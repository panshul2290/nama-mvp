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
}
