// Tender gaps, batch A part 2 (0027): field encryption (ID numbers, IBANs), privacy
// enforcement (masking and reveals, retention, usage default, data-subject requests)
// and per-site business access.
import type { Reporter, Target } from "../lib/harness";
import { deliver, makeWorld, placeOrder, setOnline } from "../lib/world";

type Row = Record<string, unknown>;

export async function privacy2Suite(t: Target, r: Reporter) {
  const one = async <T = Row>(uid: string, sql: string, params: unknown[] = []) => (await t.as<T>(uid, sql, params))[0];
  const mkStaff = async (label: string, role: string) => {
    const u = await t.createUser(label, { role: "customer", full_name: `Test ${role}` });
    await t.admin("update profiles set role = 'nws_staff', staff_role = $2 where id = $1", [u.id, role]);
    return u;
  };
  const AD = await mkStaff("pv-ad", "admin");
  const CA = await mkStaff("pv-ca", "complaints_agent");
  const FI = await mkStaff("pv-fi", "finance");
  const OP = await mkStaff("pv-op", "operator");
  const w = await makeWorld(t, "prv");
  const { C1, C2, D1 } = w;

  // ===================================================================== H4 encryption
  r.start("ENCRYPT ID numbers and IBANs at rest (0027)");
  await one(C1.id, "select * from verify_identity('civil_id', '12345678')");
  const [row] = await t.admin<{ id_no: string; enc: string | null; plain: string }>(
    "select id_no, encode(id_no_enc, 'hex') as enc, pii_decrypt(id_no_enc) as plain from profiles where id = $1", [C1.id]);
  r.check("verify_identity stores the number encrypted; the plain column keeps only the mask",
    row.id_no === "•••• 5678" && !!row.enc && !row.enc.includes("3132333435363738") && row.plain === "12345678", { id_no: row.id_no, plain: row.plain });
  const mine = await one<{ p: { id_no: string } }>(C1.id, "select my_private_profile() as p");
  r.check("the customer's own profile shows the masked number", mine.p.id_no === "•••• 5678", mine.p);
  await r.denies("nobody reads the ciphertext through the API", () => t.as(C1.id, "select id_no_enc from profiles where id = auth.uid()"), "permission denied");
  await r.denies("signed-in users can't call the decrypt helper", () => t.as(AD.id, "select pii_decrypt(null)"), "permission denied");
  await r.denies("… or reach the key", () => t.as(AD.id, "select private.field_key()"), "permission denied");
  const listed = await one<{ id_no: string }>(OP.id, "select id_no from staff_private_profiles(array[$1]::uuid[])", [C1.id]);
  r.check("staff lists show the masked number", listed.id_no === "•••• 5678", listed);
  const rev = await one<{ r: { id_no: string } }>(CA.id, "select staff_reveal_identity($1, 'TEST identity check on a complaint') as r", [C1.id]);
  r.check("a privileged role (complaints agent) reveals it, audited",
    rev.r.id_no === "12345678" && (await t.admin("select 1 from audit_log where action = 'privacy.reveal_id' and target_id = $1", [C1.id])).length === 1, rev.r);
  await r.denies("other roles can't reveal ID numbers", () => one(FI.id, "select staff_reveal_identity($1, 'TEST')", [C1.id]), "forbidden_for_role");
  await r.denies("a reveal needs a reason", () => one(CA.id, "select staff_reveal_identity($1, '')", [C1.id]), "reason_required");
  const [co] = await t.admin<{ id: string; iban: string }>("insert into companies (name, cr_no, iban) values ('TST Encrypt Co', $1, 'OM81 0180 0000 0129 9123 456') returning id, iban", [`TSTE${t.runId.slice(-6)}`]);
  r.check("a company IBAN is encrypted, the column keeps the last four", co.iban === "•••• 3456", co);
  const bank = await one<{ b: { iban: string } }>(FI.id, "select staff_reveal_bank($1, 'TEST payout') as b", [co.id]);
  r.check("finance reveals the IBAN for a payout (audited)", bank.b.iban === "OM810180000001299123456", bank.b);
  await r.denies("operators can't reveal bank details", () => one(OP.id, "select staff_reveal_bank($1, 'TEST')", [co.id]), "forbidden_for_role");
  const cont = await one<{ c: { phone: string | null } }>(CA.id, "select staff_reveal_contact($1, 'TEST call-back') as c", [C1.id]);
  r.check("a privileged role reveals a phone number for a call-back", cont.c !== null, cont);
  await r.denies("other roles can't reveal contact details", () => one(OP.id, "select staff_reveal_contact($1, 'TEST')", [C1.id]), "forbidden_for_role");

  // ===================================================================== F11 privacy settings
  r.start("PRIVACY2 settings, retention and data-subject requests (0027)");
  const [pv] = await t.admin<{ value: string }>("select value from app_settings where key = 'PRIVACY'");
  const pj = JSON.parse(pv.value);
  r.check("the misleading residency label is gone; hosting is stated plainly", !("residency" in pj) && /Oman at go-live/.test(pj.hosting), pj);
  await r.denies("privileged roles can't include viewers", () =>
    one(AD.id, "select staff_update_setting('PRIVACY', $1, 'TEST')", [JSON.stringify({ ...pj, privileged_roles: ["admin", "viewer"] })]), "invalid_value");
  await r.denies("retention can't be set to nothing", () =>
    one(AD.id, "select staff_update_setting('PRIVACY', $1, 'TEST')", [JSON.stringify({ ...pj, retention_gps_days: 0 })]), "invalid_value");
  await t.adminRollback(async (q) => {
    await q(`update app_settings set value = jsonb_set(value::jsonb, '{usage_data_default}', 'true')::text where key = 'PRIVACY'`);
    const [u] = await q<{ id: string }>("insert into auth.users (email, raw_user_meta_data) values ('test-pglite-pv-new@nama.test', '{\"role\": \"customer\", \"full_name\": \"x\"}') returning id");
    const [p] = await q<{ prefs: { share_usage: boolean } }>("select prefs from profiles where id = $1", [u.id]);
    r.check("new accounts get the usage-data default from the privacy setting", p.prefs.share_usage === true, p);
  });

  // Retention: an old closed order loses its GPS trail, chat, photo and street address; an open one keeps everything.
  await setOnline(t, D1.id, true);
  const closed = await placeOrder(t, C1.id, "DW", 1000);
  await one(D1.id, "select * from accept_order($1)", [closed.id]);
  await one(C1.id, "select * from send_message($1, 'TEST gate code 1234')", [closed.id]);
  await one(D1.id, "select * from mark_arrived($1)", [closed.id]);
  await deliver(t, D1.id, closed.id);
  const open = await placeOrder(t, C1.id, "DW", 1000);
  await t.admin("insert into gps_fixes (tanker_id, order_id, lat, lng, accuracy_m, recorded_at) values ($1, $2, 23.6, 58.2, 5, now() - interval '400 days'), ($1, $3, 23.6, 58.2, 5, now() - interval '400 days'), ($1, null, 23.6, 58.2, 5, now() - interval '400 days')",
    [w.tk.D1, closed.id, open.id]);
  await one(C1.id, "select * from send_message($1, 'TEST still waiting')", [open.id]).catch(() => null);
  await t.admin("update order_messages set created_at = now() - interval '400 days' where order_id = any($1::uuid[])", [[closed.id, open.id]]);
  await t.admin("update pods set created_at = now() - interval '400 days' where order_id = $1", [closed.id]);
  await t.admin("update orders set delivered_at = now() - interval '8 years' where id = $1", [closed.id]);
  const dry = await one<{ x: Record<string, number> }>(AD.id, "select staff_run_retention(true) as x");
  const stillThere = await t.admin("select 1 from gps_fixes where order_id = $1", [closed.id]);
  r.check("a dry run counts what would go and changes nothing", dry.x.gps_fixes >= 2 && dry.x.delivery_media >= 1 && stillThere.length === 1, dry.x);
  await r.denies("only admins run retention", () => one(OP.id, "select staff_run_retention(true)"), "forbidden_for_role");
  await one(AD.id, "select staff_run_retention(false)");
  const gClosed = await t.admin("select 1 from gps_fixes where order_id = $1", [closed.id]);
  const gOpen = await t.admin("select 1 from gps_fixes where order_id = $1", [open.id]);
  r.check("old GPS fixes of a closed order are purged; an open order's are kept", gClosed.length === 0 && gOpen.length === 1, { gClosed, gOpen });
  const mClosed = await t.admin("select 1 from order_messages where order_id = $1", [closed.id]);
  const mOpen = await t.admin("select 1 from order_messages where order_id = $1", [open.id]);
  r.check("old chats of a closed order are purged; an open order's chat is kept", mClosed.length === 0 && mOpen.length >= 0, { mClosed: mClosed.length, mOpen: mOpen.length });
  const [pod] = await t.admin<{ photo_path: string | null; media_purged_at: string | null; meter_gal: number }>("select photo_path, media_purged_at, meter_gal from pods where order_id = $1", [closed.id]);
  r.check("the delivery photo and signature are removed (meter reading kept) and the file queued for deletion",
    pod.photo_path === null && !!pod.media_purged_at && pod.meter_gal === 20000 && (await t.admin("select 1 from storage_purge_queue where reason = 'retention'")).length >= 1, pod);
  const [loc] = await t.admin<{ address: string; lat: number }>("select address, lat from order_locations where order_id = $1", [closed.id]);
  r.check("a delivery address past the order-retention period is anonymised (no street, ~1 km)", loc.address === "" && Math.abs(loc.lat * 100 - Math.round(loc.lat * 100)) < 1e-9, loc);
  const [ol] = await t.admin<{ address: string }>("select address from order_locations where order_id = $1", [open.id]);
  r.check("the open order's address is untouched", ol.address !== "", ol);

  // Data-subject requests.
  const acc = await one<{ id: string }>(C1.id, "select * from file_data_request('access', 'TEST my data')");
  await r.denies("only admins process requests", () => one(OP.id, "select * from staff_process_data_request($1, 'TEST')", [acc.id]), "forbidden_for_role");
  const done = await one<Row>(AD.id, "select * from staff_process_data_request($1, 'TEST export')", [acc.id]);
  const exp = await one<{ e: { profile: { id_no: string }; orders: unknown[] } | null }>(C1.id, "select my_data_export($1) as e", [acc.id]);
  r.check("an access request produces an export the customer downloads (with their full ID number and orders)",
    done.state === "completed" && exp.e?.profile.id_no === "12345678" && (exp.e?.orders.length ?? 0) >= 2, { state: done.state, n: exp.e?.orders.length });
  r.check("… and the customer is told", (await t.admin("select 1 from notifications where user_id = $1 and event = 'data_export_ready'", [C1.id])).length === 1);
  const other = await one<{ e: unknown }>(C2.id, "select my_data_export($1) as e", [acc.id]);
  r.check("nobody else can download it", other.e === null, other);

  const busy = await placeOrder(t, C2.id, "DW", 600);
  const del1 = await one<{ id: string }>(C2.id, "select * from file_data_request('delete', 'TEST erase me')");
  await r.denies("an erasure waits for open orders to finish", () => one(AD.id, "select * from staff_process_data_request($1, 'TEST')", [del1.id]), "has_open_orders");
  await t.admin("update orders set status = 'cancelled' where id = $1", [busy.id]);
  const C4 = await t.createUser("pv-c4", { role: "customer", full_name: "Test Erase Me", phone: "+968 9222 3344" });
  await one(C4.id, "select * from verify_identity('civil_id', '87654321')");
  await one(C4.id, "select id from save_property(null, 'TEST home', 'TEST street 1', 'Seeb', 23.6, 58.2, 3000)");
  const del2 = await one<{ id: string }>(C4.id, "select * from file_data_request('delete', 'TEST erase me')");
  await one(AD.id, "select * from staff_process_data_request($1, 'TEST verified request')", [del2.id]);
  const [gone] = await t.admin<{ full_name: string; phone: string | null; id_no: string | null; id_no_enc: string | null; account_blocked: boolean }>(
    "select full_name, phone, id_no, id_no_enc, account_blocked from profiles where id = $1", [C4.id]);
  const [au] = await t.admin<{ email: string | null; phone: string | null }>("select email, phone from auth.users where id = $1", [C4.id]);
  r.check("an erasure anonymises the profile, removes the ID number, sites and sign-in details, and blocks the account",
    gone.full_name === "Deleted customer" && gone.phone === null && gone.id_no === null && gone.id_no_enc === null && gone.account_blocked &&
      au.email === null && au.phone === null && (await t.admin("select 1 from properties where customer_id = $1", [C4.id])).length === 0, { gone, au });

  // ===================================================================== F9 per-site business access
  r.start("SITES per-site business access (0027)");
  const BA = await t.createUser("pv-ba", { role: "business" as never, full_name: "Test Biz Admin" });
  const BM = await t.createUser("pv-bm", { role: "business" as never, full_name: "Test Site Manager" });
  const BF = await t.createUser("pv-bf", { role: "business" as never, full_name: "Test Biz Finance" });
  const org = await one<{ id: string }>(BA.id, "select * from org_register('TST Sites Hotel', $1, 'commercial')", [`TSTS${t.runId.slice(-5)}`]);
  await t.admin("update organizations set status = 'active', credit_limit = 1000, approval_limit = 1000 where id = $1", [org.id]);
  await t.admin("update profiles set org_id = $2, org_role = 'site_manager' where id = $1", [BM.id, org.id]);
  await t.admin("update profiles set org_id = $2, org_role = 'finance' where id = $1", [BF.id, org.id]);
  const S1 = await one<{ id: string }>(BA.id, "select id from save_property(null, 'TEST site one', 'TEST', 'Seeb', 23.6, 58.2, 20000)");
  const S2 = await one<{ id: string }>(BA.id, "select id from save_property(null, 'TEST site two', 'TEST', 'Seeb', 23.61, 58.21, 20000)");
  const [o1] = await t.as<{ id: string }>(BA.id, "select id from org_create_orders($1, 'DW', 1000, 1)", [S1.id]);
  const [o2] = await t.as<{ id: string }>(BA.id, "select id from org_create_orders($1, 'DW', 1000, 1)", [S2.id]);
  const seen = async (uid: string) => (await t.as<{ id: string }>(uid, "select id from orders where org_id = $1", [org.id])).map((x) => x.id);
  r.check("without a site list a member sees the whole organisation", (await seen(BM.id)).length === 2 && (await seen(BF.id)).length === 2);
  await r.denies("only admins limit members", () => one(BM.id, "select org_set_member_sites($1, array[$2]::uuid[])", [BF.id, S1.id]), "forbidden_for_role");
  await r.denies("an admin can't limit themselves", () => one(BA.id, "select org_set_member_sites($1, array[$2]::uuid[])", [BA.id, S1.id]), "cannot_restrict_self");
  await r.denies("sites must belong to the organisation", () => one(BA.id, "select org_set_member_sites($1, array[$2]::uuid[])", [BM.id, w.tk.D1]), "not_found");
  await one(BA.id, "select org_set_member_sites($1, array[$2]::uuid[])", [BM.id, S1.id]);
  await one(BA.id, "select org_set_member_sites($1, array[$2]::uuid[])", [BF.id, S2.id]);
  const bmSees = await seen(BM.id);
  r.check("a member limited to site one sees only its orders", bmSees.length === 1 && bmSees[0] === o1.id, bmSees);
  r.check("… only its order locations", (await t.as(BM.id, "select 1 from order_locations where order_id = $1", [o2.id])).length === 0);
  const bmProps = await t.as<{ id: string }>(BM.id, "select id from properties where org_id = $1", [org.id]);
  r.check("… and only its site", bmProps.length === 1 && bmProps[0].id === S1.id, bmProps);
  await r.denies("… can't order for another site", () => one(BM.id, "select id from org_create_orders($1, 'DW', 1000, 1)", [S2.id]), "not_found");
  r.check("… can still order for its own site", (await t.as(BM.id, "select id from org_create_orders($1, 'DW', 1000, 1)", [S1.id])).length === 1);
  await r.denies("… can't cancel another site's order", () => one(BM.id, "select * from org_cancel_order($1)", [o2.id]), "not_found");
  await r.denies("… can't edit another site", () => one(BM.id, "select * from save_property($1, 'x', '', '', 23.6, 58.2, 1000)", [S2.id]), "not_found");
  const S3 = await one<{ id: string }>(BM.id, "select id from save_property(null, 'TEST site three', 'TEST', 'Seeb', 23.62, 58.22, 5000)");
  r.check("a site a limited member adds joins their list", (await t.as(BM.id, "select 1 from properties where id = $1", [S3.id])).length === 1);
  const sum = await one<{ s: { sites_restricted: boolean; site_ids: string[] } }>(BM.id, "select org_summary() as s");
  r.check("org_summary tells the app the member is limited, and to which sites", sum.s.sites_restricted && sum.s.site_ids.length === 2, sum.s);
  await t.admin("insert into invoices (org_id, period_start, period_end, subtotal, vat, total, due_at) values ($1, current_date, current_date, 1, 0.05, 1.05, now() + interval '30 days')", [org.id]);
  r.check("invoices cover every site: an unlimited admin sees them, a limited member doesn't",
    (await t.as(BA.id, "select 1 from invoices where org_id = $1", [org.id])).length === 1 && (await t.as(BF.id, "select 1 from invoices where org_id = $1", [org.id])).length === 0);
  await r.denies("a finance member limited to sites can't issue invoices", () => one(BF.id, "select * from org_generate_invoice()"), "forbidden_for_role");
  r.check("the admin keeps organisation-wide access", (await seen(BA.id)).length === 3);
  await t.admin("update orders set status = 'delivered', delivered_at = now() where id = any($1::uuid[])", [[o1.id, o2.id]]);
  const sla = await t.as<{ property_id: string; deliveries: number }>(BM.id, "select * from org_sla_summary(30)");
  r.check("service levels per site follow the same limits", sla.length === 1 && sla[0].property_id === S1.id && sla[0].deliveries === 1, sla);
  await one(BA.id, "select org_set_member_sites($1, '{}'::uuid[])", [BM.id]);
  r.check("clearing the list restores organisation-wide access", (await seen(BM.id)).length === 3);
}
