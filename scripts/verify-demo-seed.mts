// Dry run of the demo seed on a fresh PGlite database built from the migrations:
// creates the seed accounts (as `npm run seed` would), runs supabase/seed/demo.sql
// twice (the second run must skip) and prints what it produced.
//   npx tsx scripts/verify-demo-seed.mts
import { readFileSync } from "node:fs";
import { pgliteTarget } from "../supabase/tests/lib/harness";

const ACCOUNTS: [string, string, string?][] = [
  ["customer@nama.test", "customer"], ["driver@nama.test", "driver"],
  ...[2, 3, 4, 5, 6, 7, 8].map((n) => [`customer${n}@nama.test`, "customer"] as [string, string]),
  ...[2, 3, 4, 5, 6, 7].map((n) => [`driver${n}@nama.test`, "driver"] as [string, string]),
  ["owner@nama.test", "owner"], ["owner2@nama.test", "owner"],
  ["business@nama.test", "business"], ["business-site@nama.test", "business"], ["business-finance@nama.test", "business"],
  ...["admin", "operator", "permits:permit_officer", "inspector", "complaints:complaints_agent", "finance", "viewer"].map(
    (s) => [`nws-${s.split(":")[0]}@nama.test`, "customer", s.split(":")[1] ?? s] as [string, string, string],
  ),
];

const t = await pgliteTarget();
for (const [email, role, staff] of ACCOUNTS) {
  const [u] = await t.admin<{ id: string }>("insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id", [email, JSON.stringify({ role, full_name: email.split("@")[0] })]);
  if (staff) await t.admin("update profiles set role = 'nws_staff', staff_role = $2 where id = $1", [u.id, staff]);
}
const sql = readFileSync("supabase/seed/demo.sql", "utf8");
await t.admin(sql);
await t.admin(sql); // idempotent: must skip
const counts = await t.admin<Record<string, number>>(`select
  (select count(*)::int from companies) companies, (select count(*)::int from tankers) tankers, (select count(*)::int from tanker_assignments where unassigned_at is null) assigned,
  (select count(*)::int from orders) orders, (select count(*)::int from orders where status = 'delivered') delivered, (select count(*)::int from orders where status = 'scheduled') scheduled,
  (select count(*)::int from orders where rating is not null) rated, (select count(*)::int from payments) payments, (select count(*)::int from pods) pods,
  (select count(*)::int from complaints) complaints, (select count(*)::int from penalties) penalties, (select count(*)::int from alerts) alerts,
  (select count(*)::int from invoices) invoices, (select count(*)::int from contracts) contracts, (select count(*)::int from notifications) notifications,
  (select count(*)::int from company_tx) company_tx, (select count(*)::int from wallet_tx) wallet_tx, (select count(*)::int from incidents) incidents`);
console.log(counts[0]);
const bal = await t.admin("select c.name, company_balance(c.id, 'earnings') earnings, company_balance(c.id, 'fill_credit') fill_credit from companies c order by 1");
console.log(bal);
console.log(await t.admin("select p.full_name, wallet_balance(p.id) wallet, p.loyalty_points from profiles p where p.role = 'customer' and p.staff_role is null order by 1 limit 3"));
