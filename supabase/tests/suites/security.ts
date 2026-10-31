// Security review fixes (0047–0052): the payment simulator contained (SEC-02), register tanker
// adoption reviewed by NWS (SEC-03), staff least privilege (SEC-04), self-declared identity
// (SEC-05), optional staff MFA (SEC-06) and limits / second approval on staff wallet credits
// (SEC-08). Checks that change global settings run only on the fresh PGlite build.
import type { Reporter, Target } from "../lib/harness";
import { makeWorld } from "../lib/world";

type Row = Record<string, unknown>;
const LAT = 23.6;
const LNG = 58.2; // inside the Seeb service zone
const FRESH_ONLY = "changes a global setting — covered by the fresh (PGlite) run";

export async function securitySuite(t: Target, r: Reporter) {
  const one = async <T = Row>(uid: string | null, sql: string, params: unknown[] = []) => (await t.as<T>(uid, sql, params))[0];
  const mkStaff = async (label: string, role: string) => {
    const u = await t.createUser(label, { role: "customer", full_name: `Test ${label}` });
    await t.admin("update profiles set role = 'nws_staff', staff_role = $2 where id = $1", [u.id, role]);
    return u;
  };
  const w = await makeWorld(t, "sec");
  const { C1, C2, D1 } = w;
  const bal = async (uid: string) => Math.round(Number((await one<{ b: string }>(uid, "select my_wallet() ->> 'balance' as b")).b) * 1000);
  const order = (uid: string, method: string, card: string | null = null, gal = 1000) =>
    one<Row>(uid, `select * from create_order(p_service_type => 'DW', p_gallons => $1, p_lat => ${LAT}, p_lng => ${LNG}, p_area => 'TEST area', p_address => 'TEST address',
                    p_pay_method => $2, p_card_last4 => $3)`, [gal, method, card]);
  const setSim = (v: string) => t.admin("update app_settings set value = $1 where key = 'PAYMENT_SIMULATOR'", [v]);
  const SIM_DEFAULT = '{"mode": "on", "daily_topup_omr": 50, "wallet_cap_omr": 150}';

  // ===========================================================================================
  r.start("SECPAY simulated payments contained (0047)");
  const [sim] = await t.admin<{ on: boolean }>("select payment_simulator_on() as on");
  r.check("the demo runs with the payment simulator on (PAYMENT_SIMULATOR)", sim.on === true, sim);
  await one(C1.id, "select wallet_topup(20, 'card', '4417')");
  await one(C1.id, "select wallet_topup(20, 'card', '4417')");
  await r.denies("simulated top-ups are capped per customer per day", () => one(C1.id, "select wallet_topup(20, 'card', '4417')"), "topup_daily_cap");
  r.check("…and the refused one credits nothing", (await bal(C1.id)) === 40000, await bal(C1.id));
  await r.denies("a declined card (0002) is still refused in the demo", () => one(C2.id, "select wallet_topup(5, 'card', '0002')"), "payment_failed");

  // A card order cancelled: the money goes back to the card, not into the wallet.
  const c0 = await bal(C2.id);
  const co = await order(C2.id, "card", "4417");
  await one(C2.id, "select * from cancel_order($1)", [co.id]);
  const [cp] = await t.admin<{ status: string; refunded_amount: string; refunded_to_card: string }>("select status, refunded_amount, refunded_to_card from payments where order_id = $1", [co.id]);
  const crf = await t.as<{ amount: string; status: string; gateway_ref: string; card_last4: string }>(C2.id, "select amount, status, gateway_ref, card_last4 from card_refunds where order_id = $1", [co.id]);
  r.check("cancelling a card order refunds the card (a card refund record), not the wallet",
    (await bal(C2.id)) === c0 && cp.status === "refunded" && Number(cp.refunded_to_card) === Number(co.total) && crf.length === 1 && Number(crf[0].amount) === Number(co.total),
    { cp, crf, wallet: await bal(C2.id) });
  r.check("…completed by the simulator, with a SIM-RF reference and the card's last digits", crf[0]?.status === "completed" && /^SIM-RF-\d+$/.test(crf[0].gateway_ref) && crf[0].card_last4 === "4417", crf);
  const [nt] = await t.admin<{ n: number }>("select count(*)::int n from notifications where user_id = $1 and order_id = $2 and event = 'refund_card'", [C2.id, co.id]);
  r.check("…and the customer is told it is going back to the card", nt.n === 1, nt);
  r.check("another customer can't see that card refund", (await t.as(C1.id, "select 1 from card_refunds where order_id = $1", [co.id])).length === 0);
  await r.denies("customers can't write card refunds", () => t.as(C2.id, "update card_refunds set status = 'failed'"), "permission denied");

  // Wallet + card: each part goes back where it came from.
  await t.admin("insert into wallet_tx (customer_id, kind, amount, memo) values ($1, 'adjustment', 2 - public.wallet_balance($1), 'TEST set balance')", [C2.id]);
  const wc = await order(C2.id, "wallet_card", "4417");
  await one(C2.id, "select * from cancel_order($1)", [wc.id]);
  const [wcp] = await t.admin<{ wallet_amount: string; card_amount: string; refunded_to_card: string }>("select wallet_amount, card_amount, refunded_to_card from payments where order_id = $1", [wc.id]);
  r.check("wallet + card cancelled: the wallet part back in the wallet, the card part back to the card",
    (await bal(C2.id)) === 2000 && Number(wcp.wallet_amount) === 2 && Number(wcp.refunded_to_card) === Number(wcp.card_amount), { wcp, wallet: await bal(C2.id) });

  // A wallet-paid order still refunds into the wallet.
  const w0 = await bal(C1.id);
  const wo = await order(C1.id, "wallet");
  await one(C1.id, "select * from cancel_order($1)", [wo.id]);
  r.check("a wallet-paid order cancelled goes back to the wallet (no card refund)",
    (await bal(C1.id)) === w0 && (await t.admin("select 1 from card_refunds where order_id = $1", [wo.id])).length === 0, await bal(C1.id));

  if (!t.fresh) {
    for (const n of ["wallet balance cap", "simulator off: top-ups wait", "simulator off: no magic card numbers", "simulator off: confirmation job idle",
                     "gateway_confirm only for the service role", "gateway_confirm checks the amount", "gateway_confirm credits once", "simulator off: tip earnings wait for the gateway"]) r.skip(n, FRESH_ONLY);
  } else {
    try {
      await setSim('{"mode": "on", "daily_topup_omr": 500, "wallet_cap_omr": 45}');
      await r.denies("the demo wallet can't grow past the wallet cap", () => one(C1.id, "select wallet_topup(10, 'card', '4417')"), "wallet_cap_reached");

      await setSim('{"mode": "off"}');
      const b1 = await bal(C1.id);
      const tu = (await one<{ w: Row }>(C1.id, "select wallet_topup(10, 'card', '0002') as w")).w.topup as Row;
      r.check("simulator off: a top-up waits for the gateway (PSP reference, nothing credited, no magic decline)",
        tu?.status === "pending" && /^PSP-TU-\d+$/.test(String(tu.gateway_ref)) && (await bal(C1.id)) === b1, tu);
      const so = await order(C1.id, "card", "0002");
      const [sp] = await t.admin<{ status: string; gateway_ref: string; card_last4: string }>("select status, gateway_ref, card_last4 from payments where order_id = $1", [so.id]);
      r.check("simulator off: card 0002 isn't declined and no card order is approved without the gateway",
        so.status === "requested" && so.payment_status === "pending" && sp.status === "pending" && sp.gateway_ref.startsWith("PSP-") && sp.card_last4 === "0002", { so: so.payment_status, sp });
      await t.admin("update topups set created_at = now() - interval '5 minutes' where id = $1", [tu.id]);
      await t.admin("update payments set created_at = now() - interval '5 minutes' where order_id = $1", [so.id]);
      await t.admin("select confirm_simulated_payments()");
      const [still] = await t.admin<{ tu: string; p: string }>("select (select status from topups where id = $1) tu, (select status from payments where order_id = $2) p", [tu.id, so.id]);
      r.check("simulator off: the simulated confirmation job confirms nothing", still.tu === "pending" && still.p === "pending", still);
      await r.denies("customers can't call the gateway confirmation", () => one(C1.id, "select gateway_confirm($1, true, 10)", [tu.gateway_ref]), "permission denied");
      const [svc] = await t.admin<{ ok: boolean }>("select has_function_privilege('service_role', 'public.gateway_confirm(text, boolean, numeric, text)', 'execute') ok");
      r.check("…only the service role (the server-side webhook) can", svc.ok === true, svc);
      await r.denies("the gateway confirmation must carry the exact amount", () => t.admin("select gateway_confirm($1, true, 100)", [tu.gateway_ref]), "amount_mismatch");
      await t.admin("select gateway_confirm($1, true, 10)", [tu.gateway_ref]);
      const [replay] = await t.admin<{ j: Row }>("select gateway_confirm($1, true, 10) j", [tu.gateway_ref]);
      r.check("a confirmed gateway top-up credits the wallet exactly once", (await bal(C1.id)) === b1 + 10000 && replay.j.replay === true, { replay, b: await bal(C1.id) });
      const [pc] = await t.admin<{ j: Row }>("select gateway_confirm(gateway_ref, true, card_amount) j from payments where order_id = $1", [so.id]);
      r.check("a confirmed gateway order payment is authorised", pc.j.status === "authorized", pc);

      // A delivered order on a company tanker, tipped by card while the simulator is off.
      const [cmp] = await t.admin<{ id: string }>("insert into companies (name, cr_no) values ('TST Sec Co', $1) returning id", [`TSTSEC${t.runId.slice(-5)}`]);
      await t.admin("update tankers set company_id = $1 where id = $2", [cmp.id, w.tk.D1]);
      const tipo = await order(C1.id, "wallet", null, 500);
      await t.admin("update orders set status = 'delivered', delivered_at = now(), tanker_id = $2, driver_id = $3 where id = $1", [tipo.id, w.tk.D1, D1.id]);
      await one(C1.id, "select * from rate_order($1, 5, 'TEST', 2, 'card')", [tipo.id]);
      const tipEarn = async () => (await t.admin("select 1 from company_tx where order_id = $1 and kind = 'tip'", [tipo.id])).length;
      const [tp] = await t.admin<{ status: string; gateway_ref: string; kind: string }>("select status, gateway_ref, kind from payments where order_id = $1 and kind = 'tip'", [tipo.id]);
      r.check("simulator off: a card tip waits for the gateway and creates no company earnings yet", tp?.status === "pending" && tp.gateway_ref.startsWith("PSP-") && (await tipEarn()) === 0, tp);
      await t.admin("select gateway_confirm($1, true, 2)", [tp.gateway_ref]);
      r.check("…the gateway's confirmation credits the tip to the company once", (await tipEarn()) === 1);
    } finally {
      await setSim(SIM_DEFAULT);
    }
  }
}
