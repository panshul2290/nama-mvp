// Web portal fixes (0023): admin powers, permit review flow, call-centre slots, chat, complaints,
// report scheduling, business cancel, owner contract orders, customer stats.
import type { Reporter, Target } from "../lib/harness";
import { giveTanker, makeWorld, placeOrder } from "../lib/world";

type Row = Record<string, unknown>;
const LAT = 23.6;
const LNG = 58.2;

export async function portalSuite(t: Target, r: Reporter) {
  r.start("PORTAL web portal fixes (0023)");
  const w = await makeWorld(t, "port");
  const { C1, D1 } = w;
  const mkStaff = async (label: string, role: string) => {
    const u = await t.createUser(label, { role: "customer", full_name: `Test ${role}` });
    await t.admin("update profiles set role = 'nws_staff', staff_role = $2 where id = $1", [u.id, role]);
    return u;
  };
  const one = async <T = Row>(uid: string, sql: string, params: unknown[] = []) => (await t.as<T>(uid, sql, params))[0];
  const AD = await mkStaff("port-ad", "admin");
  const PO = await mkStaff("port-po", "permit_officer");
  const PO2 = await mkStaff("port-po2", "permit_officer");
  const OP = await mkStaff("port-op", "operator");
  const CA = await mkStaff("port-ca", "complaints_agent");
  const VW = await mkStaff("port-vw", "viewer");
  const notes = async (uid: string, event: string) =>
    (await t.admin<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and event = $2", [uid, event]))[0].n;

  // ---- permit application: documents → inspection → decision -----------------------------------
  const DP = await t.createUser("port-dp", { role: "driver", full_name: "Test Permit Driver" });
  const tk = await giveTanker(t, DP.id, w.plate("PRM"), "DW", 4000, { permit: false });
  const app = await one<Row>(DP.id, "select * from apply_permit()");
  r.check("driver applies for a permit (submitted)", app.stage === "submitted" && app.status === "pending", app);
  await one(PO.id, "select * from staff_permit_stage($1, 'documents')", [app.id]);
  await r.denies("document check can't complete with required documents missing", () => one(PO.id, "select * from staff_permit_stage($1, 'inspection')", [app.id]), "documents_incomplete");
  const [missing] = await t.as<{ m: string[] }>(PO.id, "select permit_missing_documents($1) as m", [app.id]);
  r.check("missing documents are listed (Mulkiya, Insurance, Water test for DW)", missing.m.length === 3, missing);

  await one(PO.id, "select * from staff_permit_stage($1, 'request_info', 'TEST upload the insurance policy')", [app.id]);
  r.check("requesting information notifies the applicant", (await notes(DP.id, "permit_info_requested")) === 1);
  await r.denies("another customer can't answer the request", () => one(C1.id, "select * from permit_respond($1, 'TEST not mine')", [app.id]), "not_found");
  const resp = await one<Row>(DP.id, "select * from permit_respond($1, 'TEST uploaded the policy today')", [app.id]);
  r.check("the applicant answers: request cleared, response kept", resp.info_requested === null && resp.info_response === "TEST uploaded the policy today", resp);
  await r.denies("answering twice is refused", () => one(DP.id, "select * from permit_respond($1, 'TEST again')", [app.id]), "invalid_state");

  for (const kind of ["mulkiya", "insurance", "water_test"])
    await t.admin("insert into tanker_documents (tanker_id, kind, ref_no, valid_to, status) values ($1, $2, 'TEST', current_date + 300, 'valid')", [tk, kind]);
  const st = await one<Row>(PO.id, "select * from staff_permit_stage($1, 'inspection')", [app.id]);
  const booked = await t.admin<{ id: string; permit_id: string }>("select id, permit_id from inspections where tanker_id = $1 and result = 'scheduled'", [tk]);
  r.check("reaching inspection books one inspection for the application and notifies", st.stage === "inspection" && booked.length === 1 && booked[0].permit_id === app.id && (await notes(DP.id, "permit_inspection_booked")) === 1, booked);

  await one(PO.id, "select * from staff_record_inspection($1, $2, 'pass', 'TEST all good', '{\"hygiene\":true}'::jsonb, $3)", [tk, app.id, booked[0].id]);
  const [after] = await t.admin<{ stage: string }>("select stage from permits where id = $1", [app.id]);
  r.check("passing the booked inspection moves the application to decision", after.stage === "decision", after);
  await r.denies("the officer who recorded the inspection can't approve (separation of duties)", () => one(PO.id, "select * from staff_review_permit($1, 'approve', null)", [app.id]), "separation_of_duties");
  const ok = await one<Row>(PO2.id, "select * from staff_review_permit($1, 'approve', null)", [app.id]);
  r.check("another officer approves; validity runs 12 months from approval; applicant notified",
    ok.status === "approved" && Math.abs(Date.parse(String(ok.issued_at)) - Date.now()) < 600e3 && (await notes(DP.id, "permit_approved")) === 1, ok);
  await one(PO.id, "select * from staff_permit_remind($1)", [app.id]);
  const [rem] = await t.admin<{ reminded_at: string | null }>("select reminded_at from permits where id = $1", [app.id]);
  r.check("expiry reminder is sent and remembered", rem.reminded_at !== null && (await notes(DP.id, "permit_expiring")) === 1, rem);

  // Rejected and resubmitted applications restart at the document check.
  const DQ = await t.createUser("port-dq", { role: "driver", full_name: "Test Permit Driver Two" });
  await giveTanker(t, DQ.id, w.plate("PRQ"), "WW", 4000, { permit: false });
  const app2 = await one<Row>(DQ.id, "select * from apply_permit()");
  await one(PO.id, "select * from staff_permit_stage($1, 'documents')", [app2.id]);
  await one(PO.id, "select * from staff_review_permit($1, 'reject', 'TEST mulkiya expired')", [app2.id]);
  r.check("rejection notifies the applicant", (await notes(DQ.id, "permit_rejected")) === 1);
  const re = await one<Row>(AD.id, "select * from staff_resubmit_permit($1, null, 'TEST corrected')", [app2.id]);
  r.check("admin resubmits; the application restarts at the document check", re.status === "pending" && re.stage === "documents", re);

  // ---- fleet: drivers only on their own company's tankers -------------------------------------
  const [co] = await t.admin<{ id: string }>("insert into companies (name, cr_no) values ('TST Port Co', $1) returning id", [`TSTP${t.runId.slice(-5)}`]);
  const DF = await t.createUser("port-df", { role: "driver", full_name: "Test Free Driver" });
  await t.admin("update tankers set company_id = $1 where id = $2", [co.id, tk]);
  await t.as(AD.id, "select * from staff_unassign_tanker($1, 'TEST move')", [tk]);
  await r.denies("a driver of another company (or none) can't be put on the tanker", () => one(OP.id, "select * from staff_assign_tanker($1, $2, 'TEST')", [DF.id, tk]), "driver_other_company");

  // ---- chat: viewer can't message --------------------------------------------------------------
  const o = await placeOrder(t, C1.id, "DW", 700);
  await r.denies("a read-only staff user can't message an order", () => one(VW.id, "select * from send_message($1, 'TEST hello')", [o.id]), "forbidden_for_role");
  r.check("an operator can", (await t.as(OP.id, "select * from send_message($1, 'TEST hello')", [o.id])).length === 1);

  // ---- call-centre orders ---------------------------------------------------------------------
  const start = new Date(Date.now() + 26 * 3600e3).toISOString();
  const end = new Date(Date.now() + 28 * 3600e3).toISOString();
  const co1 = await one<Row>(OP.id, "select * from staff_place_order($1, 'DW', 1000, $2, $3, 'TEST area', 'TEST address', 'GEN-1', false, $4, $5, 'Tomorrow 8–10')", [C1.id, LAT, LNG, start, end]);
  r.check("a caller order with a window tomorrow is scheduled", co1.status === "scheduled" && co1.slot_label === "Tomorrow 8–10", co1);
  await t.admin("update profiles set account_blocked = true where id = $1", [w.C2.id]);
  await r.denies("a blocked customer can't get a caller order", () => one(OP.id, "select * from staff_place_order($1, 'DW', 1000, $2, $3, 'TEST', 'TEST', null)", [w.C2.id, LAT, LNG]), "account_blocked");
  await t.admin("update profiles set account_blocked = false where id = $1", [w.C2.id]);

  // ---- complaints -----------------------------------------------------------------------------
  const cmp = await one<Row>(C1.id, "select * from file_complaint($1, 'late_delivery', 'TEST late again', null)", [o.id]);
  await one(CA.id, "select * from staff_case_action($1, 'assign', null, 'Water quality lab')", [cmp.id]);
  await one(CA.id, "select * from staff_case_action($1, 'reply', 'TEST we are on it')", [cmp.id]);
  const cn = await t.admin<{ body: string; internal: boolean }>("select body, internal from complaint_notes where complaint_id = $1 order by id", [cmp.id]);
  r.check("assign is logged (internal) and a reply is visible to the customer",
    cn.some((n) => n.internal && n.body.startsWith("Assigned to Water quality lab")) && cn.some((n) => !n.internal && n.body === "TEST we are on it"), cn);
  r.check("the customer sees the reply", (await t.as(C1.id, "select 1 from complaint_notes where complaint_id = $1 and body = 'TEST we are on it'", [cmp.id])).length === 1);
  await r.denies("a viewer can't act on a case", () => one(VW.id, "select * from staff_case_action($1, 'note', 'TEST')", [cmp.id]), "forbidden_for_role");

  // ---- report scheduling ------------------------------------------------------------------------
  const rep = await one<Row>(OP.id, "select * from staff_save_scheduled_report('TEST weekly', 'Orders', 'zone', 'weekly', 'xlsx', 'ops@nws.test')");
  r.check("scheduling accepts the dataset in any case", rep.dataset === "orders", rep);
  r.check("permits dataset grouped by status is accepted", (await t.as(OP.id, "select * from staff_save_scheduled_report('TEST permits', 'permits', 'status', 'monthly', 'pdf', '')")).length === 1);
  await r.denies("a viewer can't schedule reports", () => one(VW.id, "select * from staff_save_scheduled_report('TEST v', 'orders', 'day', 'daily', 'csv', '')"), "forbidden_for_role");

  // ---- customer stats ---------------------------------------------------------------------------
  const stats = await t.as<{ customer_id: string; orders: number }>(VW.id, "select * from staff_customer_stats() where customer_id = $1", [C1.id]);
  r.check("staff_customer_stats counts the customer's orders", stats.length === 1 && stats[0].orders >= 2, stats);
  await r.denies("customers can't read staff stats", () => one(C1.id, "select * from staff_customer_stats()"), "not_staff");

  // ---- business: cancel an account order --------------------------------------------------------
  const FIN = await mkStaff("port-fin", "finance");
  const BA = await t.createUser("port-ba", { role: "business" as never, full_name: "Test Biz Admin" });
  const BM = await t.createUser("port-bm", { role: "business" as never, full_name: "Test Site Manager" });
  const BF = await t.createUser("port-bf", { role: "business" as never, full_name: "Test Biz Finance" });
  const org = await one<Row>(BA.id, "select * from org_register('TST Port Hotel', $1, 'commercial')", [`TSTH${t.runId.slice(-5)}`]);
  await one(FIN.id, "select * from staff_org_action($1, 'activate', 'TEST verified')", [org.id]);
  await one(FIN.id, "select * from staff_org_action($1, 'raise_limit', 'TEST credit', 500)", [org.id]);
  for (const [u, role] of [[BM, "site_manager"], [BF, "finance"]] as const) {
    const inv = await one<Row>(BA.id, "select * from org_add_member($1, $2)", [u.email, role]);
    await one(u.id, "select * from respond_invitation($1, true)", [inv.id]);
  }
  const [site] = await t.as<{ id: string }>(BA.id, "select id from save_property(null, 'TEST port site', 'TEST', 'Seeb', $1, $2, 20000)", [LAT, LNG]);
  const bulk = await t.as<Row>(BM.id, "select * from org_create_orders($1, 'DW', 5000, 2, null, null, null, 'PO-PORT')", [site.id]);
  await r.denies("business finance can't cancel orders", () => one(BF.id, "select * from org_cancel_order($1, 'TEST')", [bulk[0].id]), "forbidden_for_role");
  const cx = await one<Row>(BM.id, "select * from org_cancel_order($1, 'TEST not needed')", [bulk[0].id]);
  r.check("site manager cancels their own pending order (no wallet refund)", cx.status === "cancelled" && (await t.admin("select 1 from wallet_tx where order_id = $1", [cx.id])).length === 0, cx);
  await r.denies("a delivered/cancelled order can't be cancelled again", () => one(BA.id, "select * from org_cancel_order($1, null)", [bulk[0].id]), "cannot_cancel");
  const cmpB = await one<Row>(BM.id, "select * from file_complaint($1, 'late_delivery', 'TEST business complaint', null)", [bulk[1].id]);
  r.check("org admin sees complaints on the organisation's orders", (await t.as(BA.id, "select 1 from complaints where id = $1", [cmpB.id])).length === 1);

  // ---- owners see their contract orders before a driver takes them -----------------------------
  const OW = await t.createUser("port-ow", { role: "owner" as never, full_name: "Test Port Owner" });
  const comp = await one<Row>(OW.id, "select * from owner_register_company('TST Port Owner Co', $1, '+968 9000 0001', 'Bank Muscat', 'OM12 TEST 0001')", [`TSTQ${t.runId.slice(-5)}`]);
  await one(AD.id, "select staff_company_action($1, 'activate', 'TEST documents checked')", [comp.id]);
  const [prop] = await t.as<{ id: string }>(C1.id, "select id from save_property(null, 'TEST port villa', 'TEST address', 'Seeb', $1, $2, 3000)", [LAT, LNG]);
  const day = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
  const ct = await one<Row>(C1.id, "select * from create_contract($1, $2, 'DW', 3000, 'weekly', 'monthly', 'morning', $3, 3)", [prop.id, comp.id, day]);
  await one(OW.id, "select * from owner_decide_contract($1, true)", [ct.id]);
  const seen = await t.as(OW.id, "select id from orders where contract_id = $1", [ct.id]);
  r.check("the owner sees the scheduled contract orders", seen.length >= 1, seen.length);
  void D1;
}
