// Applies supabase/migrations/0001_init.sql to DATABASE_URL, then verifies the
// tables and the supabase_realtime publication (adding missing tables).
//   npm run db:apply
// Never prints the connection string.
import { readFileSync } from "node:fs";
import pg from "pg";

const MIGRATION = "supabase/migrations/0001_init.sql";
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

// ---- preflight: no transaction control outside function bodies ----------------
const sql = readFileSync(MIGRATION, "utf8");
const outsideBodies = sql
  .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "") // dollar-quoted function bodies
  .replace(/--.*$/gm, "") // line comments
  .replace(/'(?:[^']|'')*'/g, "''"); // string literals
const txControl = outsideBodies.match(/(^|;)\s*(begin|start\s+transaction|commit|rollback|end|savepoint|release)\b[^;]*;/gim);
if (txControl) {
  console.error("Refusing to apply: transaction-control statements found outside function bodies:");
  txControl.forEach((s) => console.error("  " + s.trim()));
  process.exit(1);
}
console.log("Preflight: no BEGIN/COMMIT/ROLLBACK/SAVEPOINT outside function bodies.");

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
  const { rows: [server] } = await client.query("select current_database() as db, split_part(version(), ' ', 2) as version");
  console.log(`Connected: database "${server.db}", Postgres ${server.version}.`);

  // ---- apply (once) -----------------------------------------------------------
  const before = await existingTables();
  if (before.length === TABLES.length) {
    console.log(`Migration already applied (found ${before.join(", ")}); not re-running.`);
  } else if (before.length > 0) {
    throw new Error(`Partial schema present (${before.join(", ")}); refusing to apply on top of it.`);
  } else {
    console.log(`Applying ${MIGRATION} in a single transaction…`);
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("commit");
      console.log("Migration committed.");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      const where = e.position ? ` (near: ${JSON.stringify(sql.slice(Math.max(0, e.position - 60), Number(e.position) + 40))})` : "";
      throw new Error(`Migration failed and was rolled back: ${e.message} [${e.code ?? "?"}]${where}`);
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
      (await client.query("select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'"))
        .rows.map((r) => r.tablename);
    const current = await inPub();
    const missing = REALTIME.filter((t) => !current.includes(t) && after.includes(t));
    if (missing.length) {
      await client.query(`alter publication supabase_realtime add table ${missing.map((t) => `public.${t}`).join(", ")}`);
      console.log(`  Added to supabase_realtime: ${missing.join(", ")}`);
    }
    const final = await inPub();
    for (const t of REALTIME) console.log(`  supabase_realtime ⊇ public.${t}: ${final.includes(t) ? "yes" : "NO"}`);
    const others = final.filter((t) => !REALTIME.includes(t));
    if (others.length) console.log(`  (publication also contains: ${others.join(", ")})`);
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
  const { rows: trg } = await client.query(
    "select 1 from pg_trigger where tgname = 'on_auth_user_created' and tgrelid = 'auth.users'::regclass",
  );
  console.log(`  auth.users sign-up trigger: ${trg.length ? "present" : "MISSING"}`);
}

main()
  .catch((e) => {
    console.error("Error: " + scrub(e.message));
    process.exitCode = 1;
  })
  .finally(() => client.end().catch(() => {}));
