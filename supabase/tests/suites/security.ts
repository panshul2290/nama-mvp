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

  // ===========================================================================================
  r.start("SECADOPT register tankers: verified owner or NWS approval (0048)");
  const PO = await mkStaff("sec-po", "permit_officer");
  const OPS = await mkStaff("sec-ops", "operator");
  const regTanker = async (label: string, ownerPhone: string | null) => {
    const plate = w.plate(label);
    const own = ownerPhone ? (await t.admin<{ id: string }>("insert into registry_owners (name, name_key, phone) values ('TEST register owner', 'test register owner ' || $1, $1) returning id", [ownerPhone]))[0].id : null;
    const [tk] = await t.admin<{ id: string }>(
      "insert into tankers (plate, service_type, capacity_gal, on_platform, in_register, capacity_known, registry_owner_id) values ($1, 'DW', 5000, false, true, false, $2) returning id", [plate, own]);
    await t.admin("insert into permits (tanker_id, permit_no, type, issued_at, expires_at, status, reviewed_at) values ($1, $2, 'DW', now() - interval '1 day', now() + interval '300 days', 'approved', now())", [tk.id, `P-${plate}`]);
    return { id: tk.id, plate };
  };
  const newDriver = async (label: string, phone?: string) => {
    const d = await t.createUser(label, { role: "driver", full_name: `Test ${label}` });
    if (phone) await t.admin("update auth.users set phone = $2, phone_confirmed_at = now() where id = $1", [d.id, phone]);
    return d;
  };
  const A = await regTanker("RA", null);
  const DA = await newDriver("sec-da");
  const adA = await one<{ id: string; adoption_state: string; on_platform: boolean }>(DA.id, "select id, adoption_state, on_platform from driver_register_tanker($1, 'DW', 5000)", [A.plate]);
  r.check("a driver adopting a register plate with no owner number gets it pending NWS review", adA?.id === A.id && adA.adoption_state === "pending" && adA.on_platform, adA);
  await r.denies("…and can't go online under its approved permit", () => one(DA.id, "select driver_set_online(true)"), "adoption_pending");
  const [okp] = await t.admin<{ ok: boolean }>("select tanker_has_valid_permit($1) ok", [A.id]);
  r.check("…the permit doesn't count for dispatch or accepting while the claim is pending", okp.ok === false, okp);
  const [nn] = await t.admin<{ n: number }>("select count(*)::int n from notifications where user_id = $1 and event = 'adoption_review'", [PO.id]);
  r.check("permit officers are told to review the claim", nn.n >= 1, nn);
  const claims = await t.as<{ tanker_id: string; adopter_phone: string | null }>(PO.id, "select tanker_id, adopter_phone from staff_adoption_claims()");
  r.check("NWS lists the pending claim", claims.some((c) => c.tanker_id === A.id), claims);
  await r.denies("drivers can't list claims", () => t.as(DA.id, "select * from staff_adoption_claims()"), "not_staff");
  await r.denies("an operator can't approve a claim (permit officers and admins)", () => one(OPS.id, "select * from staff_review_adoption($1, true, 'TEST')", [A.id]), "forbidden_for_role");
  await r.denies("the adopter can't approve their own claim", () => one(DA.id, "select * from staff_review_adoption($1, true, 'TEST')", [A.id]), "not_staff");
  await r.denies("a review needs a reason", () => one(PO.id, "select * from staff_review_adoption($1, true, '')", [A.id]), "reason_required");
  const ap = await one<{ adoption_state: string }>(PO.id, "select adoption_state from staff_review_adoption($1, true, 'TEST registration card checked')", [A.id]);
  r.check("a permit officer approves it (audited)", ap?.adoption_state === "approved"
    && (await t.admin("select 1 from audit_log where action = 'tanker.adoption_approve' and target_id = $1", [A.id])).length === 1, ap);
  const [okp2] = await t.admin<{ ok: boolean }>("select tanker_has_valid_permit($1) ok", [A.id]);
  r.check("…after which the permit counts again", okp2.ok === true, okp2);

  const B = await regTanker("RB", null);
  const DB = await newDriver("sec-db");
  await one(DB.id, "select id from driver_register_tanker($1, 'DW', 5000)", [B.plate]);
  const rj = await one<{ adoption_state: string; on_platform: boolean; company_id: string | null }>(PO.id, "select adoption_state, on_platform, company_id from staff_review_adoption($1, false, 'TEST not the owner')", [B.id]);
  const [asg] = await t.admin<{ n: number }>("select count(*)::int n from tanker_assignments where tanker_id = $1 and unassigned_at is null", [B.id]);
  r.check("a rejected claim gives the plate back to the register and unassigns the driver", rj?.adoption_state === "rejected" && !rj.on_platform && asg.n === 0, { rj, asg });
  const [rn] = await t.admin<{ n: number }>("select count(*)::int n from notifications where user_id = $1 and event = 'adoption_rejected'", [DB.id]);
  r.check("…and the driver is told why", rn.n === 1, rn);

  const C = await regTanker("RC", "+96899004401");
  const DC = await newDriver("sec-dc", "96899004401");
  const adC = await one<{ adoption_state: string }>(DC.id, "select adoption_state from driver_register_tanker($1, 'DW', 5000)", [C.plate]);
  r.check("the register owner with the matching verified mobile number adopts without review", adC?.adoption_state === "approved", adC);
  const [okc] = await t.admin<{ ok: boolean }>("select tanker_has_valid_permit($1) ok", [C.id]);
  r.check("…and the permit counts at once", okc.ok === true, okc);

  // ===========================================================================================
  r.start("SECPII staff least privilege for personal data (0049)");
  const VW = await mkStaff("sec-vw", "viewer");
  const FN = await mkStaff("sec-fn", "finance");
  const CA = await mkStaff("sec-ca", "complaints_agent");
  const PC = await t.createUser("sec-pc", { role: "customer", full_name: "Test Phone Customer", phone: "+968 9333 4455" });
  const [raw] = await t.admin<{ phone: string; phone_masked: string }>("select phone, phone_masked from profiles where id = $1", [PC.id]);
  await r.denies("nobody selects raw phone numbers from profiles directly (not even their own)", () => t.as(PC.id, "select phone from profiles where id = $1", [PC.id]), "permission denied");
  const own = await t.as<{ phone_masked: string }>(PC.id, "select phone_masked from profiles where id = $1", [PC.id]);
  r.check("the masked number is a readable column", own[0]?.phone_masked === raw.phone_masked && raw.phone_masked !== raw.phone && raw.phone_masked.endsWith(raw.phone.slice(-2)), { own, raw: raw.phone_masked });
  const phoneOf = async (uid: string, who: string) => (await t.as<{ phone: string }>(uid, "select phone from contact_phones($1::uuid[])", [[who]]))[0]?.phone ?? null;
  r.check("contact_phones gives the person their own number", (await phoneOf(PC.id, PC.id)) === raw.phone);
  r.check("…another customer gets nothing", (await phoneOf(C1.id, PC.id)) === null);
  r.check("…a viewer and finance get the masked number", (await phoneOf(VW.id, PC.id)) === raw.phone_masked && (await phoneOf(FN.id, PC.id)) === raw.phone_masked);
  r.check("…a complaints agent (who calls customers back) gets the number", (await phoneOf(CA.id, PC.id)) === raw.phone);
  await t.as(D1.id, "select driver_set_online(true)");
  const jo = await one<{ id: string }>(PC.id, `select id from create_order(p_service_type => 'DW', p_gallons => 1000, p_lat => ${LAT}, p_lng => ${LNG}, p_area => 'TEST area', p_address => 'TEST address', p_pay_method => 'card')`);
  await one(D1.id, "select * from accept_order($1)", [jo.id]);
  r.check("…the driver on the customer's active job gets the number (the call button)", (await phoneOf(D1.id, PC.id)) === raw.phone);
  r.check("…another driver doesn't", (await phoneOf(w.D2.id, PC.id)) === null);
  const found = await t.as<{ id: string; phone_masked: string }>(VW.id, "select id, phone_masked from staff_find_people('93334455', array['customer']::user_role[])");
  r.check("staff find a customer by mobile number; it comes back masked", found.some((x) => x.id === PC.id && x.phone_masked === raw.phone_masked), found);
  await r.denies("customers can't search people", () => t.as(C1.id, "select * from staff_find_people('9333')"), "not_staff");
  const locVw = await t.as(VW.id, "select 1 from order_locations where order_id = $1", [jo.id]);
  const locFn = await t.as(FN.id, "select 1 from order_locations where order_id = $1", [jo.id]);
  const locCa = await t.as(CA.id, "select address from order_locations where order_id = $1", [jo.id]);
  r.check("exact delivery points and addresses: not for viewer or finance, yes for delivery-facing roles", locVw.length === 0 && locFn.length === 0 && locCa.length === 1, { locVw, locFn, locCa });
  const [shp] = await t.admin<{ n: number }>("select count(*)::int n from pg_policies where tablename = 'route_shares' and policyname = 'route_shares_staff'");
  r.check("live-route share tokens are no longer readable by staff", shp.n === 0, shp);
  await one(PC.id, "select * from cancel_order($1)", [jo.id]).catch(() => undefined);
  await t.as(D1.id, "select driver_set_online(false)").catch(() => undefined);
}
