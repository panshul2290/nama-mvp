// Restores a backup made by scripts/backup-db.mjs into a fresh PGlite and checks
// it against the live counts recorded in meta.json.
//   npx tsx scripts/verify-backup.mts backups/<timestamp>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

type Col = { column_name: string; data_type: string; udt_name: string; is_generated: string; is_nullable: string };
const dir = process.argv[2];
if (!dir) throw new Error("usage: tsx scripts/verify-backup.mts backups/<timestamp>");
const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as {
  counts: Record<string, number>; objects: Record<string, number>; authUserColumns: Col[];
};
const dumpSql = readFileSync(join(dir, "public_and_migrations.sql"), "utf8");
const authSql = readFileSync(join(dir, "auth_data.sql"), "utf8");

// Supabase pieces the public schema depends on: roles named in GRANTs/OWNERs, auth.users, auth.uid().
const roles = new Set<string>(["anon", "authenticated", "service_role"]);
for (const line of dumpSql.split("\n")) {
  const m =
    /^(?:GRANT|REVOKE)\b.*\b(?:TO|FROM)\s+"?([a-z_][a-z0-9_]*)"?;$/i.exec(line) ??
    /\bOWNER TO\s+"?([a-z_][a-z0-9_]*)"?;$/i.exec(line) ??
    /^ALTER DEFAULT PRIVILEGES FOR ROLE\s+"?([a-z_][a-z0-9_]*)"?/i.exec(line);
  if (m) roles.add(m[1]);
}
for (const r of [...roles]) if (r === "postgres" || r.toLowerCase() === "public" || r.startsWith("pg_")) roles.delete(r);

const typeOf = (c: Col) => (c.data_type === "USER-DEFINED" ? "text" : c.data_type === "ARRAY" ? `${c.udt_name.replace(/^_/, "")}[]` : c.data_type);
const authUsersDdl = `create table auth.users (${meta.authUserColumns
  .filter((c) => c.is_generated !== "ALWAYS")
  .map((c) => `"${c.column_name}" ${typeOf(c)}`)
  .join(", ")}, primary key (id))`;

// Only auth.users rows are needed (profiles reference them); other auth tables are kept in the backup file.
const authUserInserts = authSql.split("\n").filter((l) => l.startsWith("INSERT INTO auth.users "));

// pg_dump preamble lines PGlite can't (or needn't) run.
const cleaned = dumpSql
  .split("\n")
  .filter((l) => !/^\\(restrict|unrestrict)\b/.test(l)) // psql meta-commands (pg_dump 17.6+)
  .filter((l) => !/^SET transaction_timeout/.test(l))
  .map((l) => l.replace(/^CREATE SCHEMA (\w+);$/, "CREATE SCHEMA IF NOT EXISTS $1;"))
  .join("\n");

const db = new PGlite();
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${JSON.stringify(detail)}`}`);
};

await db.exec(`
  ${[...roles].map((r) => `create role "${r}" nologin;`).join("\n")}
  create schema auth;
  ${authUsersDdl};
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
  create publication supabase_realtime;
`);
console.log(`stub: ${roles.size} roles, auth.users (${meta.authUserColumns.length} columns), auth.uid()`);
for (const ins of authUserInserts) await db.exec(ins);
console.log(`auth.users rows restored: ${authUserInserts.length}`);
await db.exec(cleaned);
console.log("public + supabase_migrations restored");

for (const [table, live] of Object.entries(meta.counts)) {
  const [schema, name] = table.split(".");
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from "${schema}"."${name}"`);
  check(`${table}: ${rows[0].n} rows (live ${live})`, rows[0].n === live, { restored: rows[0].n, live });
}
const { rows: [o] } = await db.query<Record<string, number>>(`select
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace)::int as functions,
  (select count(*) from pg_policies where schemaname = 'public')::int as policies,
  (select count(*) from pg_trigger t join pg_class r on r.oid = t.tgrelid where r.relnamespace = 'public'::regnamespace and not t.tgisinternal)::int as triggers,
  (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relrowsecurity)::int as rls_tables,
  (select count(*) from auth.users)::int as auth_users`);
for (const k of ["functions", "policies", "triggers", "rls_tables", "auth_users"]) check(`${k}: ${o[k]} (live ${meta.objects[k]})`, o[k] === meta.objects[k], { restored: o[k], live: meta.objects[k] });
const { rows: [s] } = await db.query<{ last: string }>("select last_value::text as last from public.orders_order_no_seq");
check(`order-number sequence restored (last value ${s.last})`, Number(s.last) >= 48200);
const { rows: [p] } = await db.query<{ total: string }>("select total::text from public.price_quote('DW', 3000)");
check(`functions work after restore (price_quote DW 3000 = ${p.total})`, p.total === "11.760");

console.log(failed ? `\n${failed} check(s) failed` : "\nbackup restores cleanly into PGlite");
process.exit(failed ? 1 : 0);
