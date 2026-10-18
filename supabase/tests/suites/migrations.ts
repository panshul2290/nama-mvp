// Migration-level checks. Some need a database at a specific point in history
// (e.g. orders that existed before 0002), so they run on the fresh PGlite
// build; on Supabase the equivalent read-only checks run instead.
import type { Reporter, Target } from "../lib/harness";
import { migrationFiles } from "../lib/harness";

export const legacy: { ids: string[] } = { ids: [] };

/** PGlite hook: create orders before 0002 is applied, out of created_at order. */
export const beforeMigration = {
  "0002_order_no.sql": async (_db: unknown, t: Target) => {
    const u = await t.createUser("legacy", { role: "customer", full_name: "Test Legacy Customer" });
    for (const g of [100, 200, 300]) {
      const [o] = await t.as<{ id: string }>(u.id, "select * from place_order('DW', $1, 23.6, 58.2, 'TEST legacy')", [g]);
      legacy.ids.push(o.id);
    }
    const times = ["2026-01-03T10:00:00Z", "2026-01-01T10:00:00Z", "2026-01-02T10:00:00Z"];
    for (let i = 0; i < 3; i++) await t.admin("update orders set created_at = $1 where id = $2", [times[i], legacy.ids[i]]);
  },
};

export async function migrationsSuite(t: Target, r: Reporter) {
  r.start("MIG migrations and schema");
  const files = migrationFiles().map((m) => m.file.split("_")[0]);
  if (t.fresh) {
    const rows = await t.admin<{ id: string; order_no: string }>("select id, order_no from orders where id = any($1::uuid[]) order by order_no", [legacy.ids]);
    r.check(
      "orders that existed before 0002 were numbered 48200… in created_at order",
      JSON.stringify(rows.map((x) => [x.id, Number(x.order_no)])) === JSON.stringify([[legacy.ids[1], 48200], [legacy.ids[2], 48201], [legacy.ids[0], 48202]]),
      rows,
    );
    r.skip("migrations recorded in supabase_migrations.schema_migrations", "PGlite applies files directly; tracking is checked on Supabase");
  } else {
    r.skip("backfill order of pre-0002 orders", "needs a pre-0002 database; checked on the fresh PGlite build");
    const recorded = (await t.admin<{ version: string }>("select version from supabase_migrations.schema_migrations order by version")).map((x) => x.version);
    r.check(`every migration file is recorded as applied (${files.join(", ")})`, files.every((v) => recorded.includes(v)), recorded);
  }
  const [cols] = await t.admin<{ nullable: string; uniq: number; trg: number }>(
    `select (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'order_no') as nullable,
            (select count(*)::int from pg_constraint where conname = 'orders_order_no_key' and contype = 'u') as uniq,
            (select count(*)::int from pg_trigger where tgrelid = 'public.orders'::regclass and tgname in ('orders_assign_order_no', 'orders_freeze_order_no')) as trg`,
  );
  r.check("orders.order_no is NOT NULL, UNIQUE, with assign + freeze triggers", cols.nullable === "NO" && cols.uniq === 1 && cols.trg === 2, cols);
  const [agg] = await t.admin<{ missing: number; dups: number }>(
    "select count(*) filter (where order_no is null)::int as missing, (count(*) - count(distinct order_no))::int as dups from orders",
  );
  r.check("read-only scan: every order has a number and none repeat", agg.missing === 0 && agg.dups === 0, agg);
  const [rls] = await t.admin<{ n: number }>(
    "select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace and relname in ('profiles','tankers','orders','order_locations') and relrowsecurity",
  );
  r.check("RLS is enabled on profiles, tankers, orders, order_locations", rls.n === 4, rls);
  const pub = (await t.admin<{ tablename: string }>("select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'")).map((x) => x.tablename);
  r.check("orders and tankers are in the supabase_realtime publication", pub.includes("orders") && pub.includes("tankers"), pub);
  const fns = await t.admin<{ name: string; anon: boolean; authed: boolean }>(
    `select p.proname as name, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authed
       from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname in ('place_order','cancel_order','open_requests_near','accept_order','report_location','mark_arrived','mark_delivered','price_quote','location_stale','location_age_s')`,
  );
  r.check("no RPC is executable by anon; all are executable by signed-in users", fns.length >= 10 && fns.every((f) => !f.anon && f.authed), fns);
  const [seq] = await t.admin<{ anon: boolean; authed: boolean }>(
    "select has_sequence_privilege('anon', 'public.orders_order_no_seq', 'usage') as anon, has_sequence_privilege('authenticated', 'public.orders_order_no_seq', 'usage') as authed",
  );
  r.check("the order-number sequence is not usable by anon or signed-in users", !seq.anon && !seq.authed, seq);
}
