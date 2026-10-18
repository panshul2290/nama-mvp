// Applies supabase/migrations/NNNN_*.sql to DATABASE_URL in order, skipping
// ones already recorded in supabase_migrations.schema_migrations, then verifies
// the schema and the supabase_realtime publication (adding missing tables).
//   npm run db:apply
// Never prints the connection string.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const DIR = "supabase/migrations";
const TABLES = ["profiles", "tankers", "orders"];
const REALTIME = ["orders", "tankers"];

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.error("DATABASE_URL is not set (expected in .env.local).");
  process.exit(1);
}

// Keep secrets out of anything we print.
const url = new URL(raw);
const secrets = [raw, url.password, decodeURIComponent(url.password)].filter(Boolean);
const scrub = (s) => secrets.reduce((acc, x) => acc.split(x).join("***"), String(s));

// ---- migrations on disk, with preflight ---------------------------------------
const files = readdirSync(DIR)
  .map((f) => /^(\d+)_(.+)\.sql$/.exec(f))
  .filter(Boolean)
  .map(([file, version, name]) => ({ file, version, name, sql: readFileSync(join(DIR, file), "utf8") }))
  .sort((a, b) => a.version.localeCompare(b.version));

for (const m of files) {
  // Transaction control outside function bodies would break the per-file transaction.
  const outsideBodies = m.sql
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "")
    .replace(/--.*$/gm, "")
    .replace(/'(?:[^']|'')*'/g, "''");
  // Check the first word of each statement (not each line, so CASE … END is fine).
  const tx = outsideBodies
    .split(";")
    .map((s) => s.trim())
    .filter((s) => /^(begin|start\s+transaction|commit|rollback|abort|end|savepoint|release)\b/i.test(s));
  if (tx.length) {
    console.error(`Refusing to apply: ${m.file} has transaction-control statements outside function bodies:`);
    tx.forEach((s) => console.error("  " + s.trim()));
    process.exit(1);
  }
}
console.log(`Preflight: ${files.length} migration file(s), none with BEGIN/COMMIT/ROLLBACK/SAVEPOINT outside function bodies.`);

// ---- connect ------------------------------------------------------------------
// Supabase's pooler cert isn't in Node's default CA bundle, so encrypt without
// chain verification for remote hosts; sslmode in the URL would override this.
url.searchParams.delete("sslmode");
const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
const client = new pg.Client({ connectionString: url.toString(), ssl: local ? false : { rejectUnauthorized: false } });

async function existingTables() {
  const { rows } = await client.query(
    "select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1)",
    [TABLES],
  );
  return rows.map((r) => r.table_name).sort();
}

async function main() {
  await client.connect();
  const {
    rows: [server],
  } = await client.query("select current_database() as db, split_part(version(), ' ', 2) as version");
  console.log(`Connected: database "${server.db}", Postgres ${server.version}.`);

  // One runner at a time.
  await client.query("select pg_advisory_lock(hashtext('nama-mvp:migrations'))");

  // Same table the Supabase CLI uses; only version/name are written here.
  await client.query("create schema if not exists supabase_migrations");
  await client.query(
    "create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)",
  );
  const recorded = async () =>
    new Set((await client.query("select version from supabase_migrations.schema_migrations")).rows.map((r) => r.version));
  let applied = await recorded();

  // 0001 predates tracking: if its tables exist but it isn't recorded, record it as a baseline.
  const first = files[0];
  if (first && !applied.has(first.version)) {
    const present = await existingTables();
    if (present.length === TABLES.length) {
      await client.query("insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)", [first.version, first.name]);
      console.log(`Baselined ${first.file}: its schema was already present (applied before tracking).`);
      applied = await recorded();
    } else if (present.length > 0) {
      throw new Error(`Partial schema present (${present.join(", ")}) but ${first.file} isn't recorded; refusing to continue.`);
    }
  }

  // ---- apply pending, in order ------------------------------------------------
  for (const m of files) {
    if (applied.has(m.version)) {
      console.log(`  skip   ${m.file} (already applied)`);
      continue;
    }
    console.log(`  apply  ${m.file} …`);
    try {
      await client.query("begin");
      await client.query(m.sql);
      await client.query("insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)", [m.version, m.name]);
      await client.query("commit");
      console.log(`         committed`);
    } catch (e) {
      await client.query("rollback").catch(() => {});
      const where = e.position ? ` (near: ${JSON.stringify(m.sql.slice(Math.max(0, e.position - 60), Number(e.position) + 40))})` : "";
      throw new Error(`${m.file} failed and was rolled back: ${e.message} [${e.code ?? "?"}]${where}`);
    }
  }

  // ---- verify tables ----------------------------------------------------------
  const after = await existingTables();
  for (const t of TABLES) console.log(`  public.${t}: ${after.includes(t) ? "present" : "MISSING"}`);

  // ---- verify realtime publication -------------------------------------------
  const { rowCount: hasPub } = await client.query("select 1 from pg_publication where pubname = 'supabase_realtime'");
  if (!hasPub) {
    console.log("  supabase_realtime publication: MISSING (not created by this script; enable Realtime in the dashboard).");
  } else {
    const inPub = async () =>
      (await client.query("select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'")).rows.map(
        (r) => r.tablename,
      );
    const current = await inPub();
    const missing = REALTIME.filter((t) => !current.includes(t) && after.includes(t));
    if (missing.length) {
      await client.query(`alter publication supabase_realtime add table ${missing.map((t) => `public.${t}`).join(", ")}`);
      console.log(`  Added to supabase_realtime: ${missing.join(", ")}`);
    }
    const final = await inPub();
    for (const t of REALTIME) console.log(`  supabase_realtime ⊇ public.${t}: ${final.includes(t) ? "yes" : "NO"}`);
  }

  // ---- extra sanity -----------------------------------------------------------
  const { rows: rls } = await client.query(
    "select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = any($1) order by relname",
    [[...TABLES, "order_locations"]],
  );
  console.log("  RLS enabled: " + rls.map((r) => `${r.relname}=${r.relrowsecurity}`).join(", "));
  const { rows: fns } = await client.query(
    "select proname from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1) order by proname",
    [["place_order", "cancel_order", "open_requests_near", "accept_order", "report_location", "mark_arrived", "mark_delivered", "price_quote"]],
  );
  console.log(`  RPCs present (${fns.length}/8): ${fns.map((f) => f.proname).join(", ")}`);

  const { rows: col } = await client.query(
    "select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'order_no'",
  );
  if (col.length) {
    const {
      rows: [stats],
    } = await client.query(
      "select count(*)::int as n, count(order_no)::int as numbered, count(distinct order_no)::int as distinct_no, min(order_no) as min_no, max(order_no) as max_no from public.orders",
    );
    const { rows: trg } = await client.query(
      "select tgname from pg_trigger where tgrelid = 'public.orders'::regclass and tgname in ('orders_assign_order_no', 'orders_freeze_order_no') order by 1",
    );
    const { rows: rpc } = await client.query(
      "select pg_get_function_result('public.open_requests_near(double precision, double precision)'::regprocedure) like '%order_no%' as ok",
    );
    console.log(
      `  orders.order_no: NOT NULL=${col[0].is_nullable === "NO"}, orders=${stats.n}, numbered=${stats.numbered}, distinct=${stats.distinct_no}` +
        (stats.n ? `, range TO-${stats.min_no}…TO-${stats.max_no}` : "") +
        `, triggers=${trg.map((t) => t.tgname).join("+") || "MISSING"}, open_requests_near returns order_no=${rpc[0].ok}`,
    );
  }

  const { rows: done } = await client.query("select version, name from supabase_migrations.schema_migrations order by version");
  console.log("  Recorded migrations: " + done.map((r) => `${r.version}_${r.name}`).join(", "));
}

main()
  .catch((e) => {
    console.error("Error: " + scrub(e.message));
    process.exitCode = 1;
  })
  .finally(() => client.end().catch(() => {}));
