// Second round of portal fixes and proof-of-delivery location (0024).
import type { Reporter, Target } from "../lib/harness";

type Row = Record<string, unknown>;

export async function portal2Suite(t: Target, r: Reporter) {
  r.start("PORTAL2 settings, exports and proof-of-delivery location (0024)");
  const mkStaff = async (label: string, role: string) => {
    const u = await t.createUser(label, { role: "customer", full_name: `Test ${role}` });
    await t.admin("update profiles set role = 'nws_staff', staff_role = $2 where id = $1", [u.id, role]);
    return u;
  };
  const one = async <T = Row>(uid: string, sql: string, params: unknown[] = []) => (await t.as<T>(uid, sql, params))[0];
  const AD = await mkStaff("p2-ad", "admin");
  const OP = await mkStaff("p2-op", "operator");
  const VW = await mkStaff("p2-vw", "viewer");
  const C1 = await t.createUser("p2-c1", { role: "customer", full_name: "Test P2 Customer" });

  // ---- Settings → Users -------------------------------------------------------------------------
  const dir = await t.as<{ id: string; email: string }>(AD.id, "select * from staff_directory()");
  r.check("admins see staff emails", dir.some((d) => d.id === OP.id && d.email === OP.email) && !dir.some((d) => d.id === C1.id), dir.length);
  await r.denies("other staff can't list emails", () => one(OP.id, "select * from staff_directory()"), "forbidden_for_role");
  const [zone] = await t.admin<{ name: string }>("select name from zones where not is_test order by name limit 1");
  const z = await one<Row>(AD.id, "select * from staff_set_zones($1, $2, 'TEST night shift')", [OP.id, [zone.name]]);
  r.check("admin edits a staff member's zones (audited)",
    JSON.stringify(z.staff_zones) === JSON.stringify([zone.name]) && (await t.admin("select 1 from audit_log where action = 'staff.zones' and target_id = $1", [OP.id])).length === 1, z.staff_zones);
  await r.denies("an unknown zone is refused", () => one(AD.id, "select * from staff_set_zones($1, array['Atlantis'], 'TEST')", [OP.id]), "invalid_value");
  await r.denies("only admins edit zones", () => one(OP.id, "select * from staff_set_zones($1, '{}', 'TEST')", [OP.id]), "forbidden_for_role");
  await r.denies("zones can't be set on a customer", () => one(AD.id, "select * from staff_set_zones($1, '{}', 'TEST')", [C1.id]), "not_found");

  // ---- exports are audited ----------------------------------------------------------------------
  await t.as(VW.id, "select staff_log_export('TEST report: orders by zone', 12)");
  const [ex] = await t.admin<{ actor_id: string; after: { rows: number } }>("select actor_id, after from audit_log where action = 'report.export' and target_id = 'TEST report: orders by zone'");
  r.check("an export is written to the audit log with its row count", ex?.actor_id === VW.id && ex.after.rows === 12, ex);
  await r.denies("customers can't write export entries", () => t.as(C1.id, "select staff_log_export('x', 1)"), "not_staff");

  // ---- privacy consent count --------------------------------------------------------------------
  await t.admin("update profiles set prefs = coalesce(prefs, '{}'::jsonb) || '{\"share_usage\": true}'::jsonb where id = $1", [C1.id]);
  const cs = await one<{ customers: number; sharing: number }>(VW.id, "select * from staff_consent_stats()");
  r.check("consent stats count customers and those sharing usage data", cs.customers >= 1 && cs.sharing >= 1 && cs.sharing <= cs.customers, cs);
  await r.denies("customers can't read consent stats", () => one(C1.id, "select * from staff_consent_stats()"), "not_staff");

  // ---- company portal: a rejected document keeps the reason --------------------------------------
  const PO = await mkStaff("p2-po", "permit_officer");
  const OW = await t.createUser("p2-ow", { role: "owner" as never, full_name: "Test P2 Owner" });
  const comp = await one<Row>(OW.id, "select * from owner_register_company('TST P2 Owner Co', $1, '+968 9000 0002', 'Bank Muscat', 'OM12 TEST 0002')", [`TSTR${t.runId.slice(-5)}`]);
  await one(AD.id, "select staff_company_action($1, 'activate', 'TEST documents checked')", [comp.id]);
  const tk = await one<{ id: string }>(OW.id, "select * from owner_register_tanker($1, 'DW', 4000)", [`TSTP2${t.runId.slice(-4)}`]);
  const [doc] = await t.admin<{ id: string }>("insert into tanker_documents (tanker_id, kind, ref_no, valid_to, status) values ($1, 'insurance', 'TEST', current_date + 200, 'pending_review') returning id", [tk.id]);
  await r.denies("rejecting a document needs a reason", () => one(PO.id, "select * from staff_review_document($1, false, null)", [doc.id]), "reason_required");
  await one(PO.id, "select * from staff_review_document($1, false, 'TEST policy number unreadable')", [doc.id]);
  const seen = await one<{ status: string; review_note: string | null }>(OW.id, "select status, review_note from tanker_documents where id = $1", [doc.id]);
  r.check("the owner sees the rejection and NWS's reason", seen?.status === "rejected" && seen.review_note === "TEST policy number unreadable", seen);
  const ok = await one<{ status: string; review_note: string | null }>(PO.id, "select * from staff_review_document($1, true, null)", [doc.id]);
  r.check("approving clears the reason", ok.status === "valid" && ok.review_note === null, ok);
}
