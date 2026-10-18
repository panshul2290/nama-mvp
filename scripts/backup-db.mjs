// Backs up the Supabase database (DATABASE_URL) into backups/<timestamp>/ (gitignored):
//   public + supabase_migrations  schema and data (INSERT statements, restorable into PGlite)
//   auth                          data only (users, identities, …; the schema is Supabase-managed)
//   meta.json                     live row counts and object counts, for the restore check
// Usage: PG_DUMP=/path/to/pg_dump node --env-file=.env.local scripts/backup-db.mjs
// pg_dump must be version 17 (the server's major version). Never prints the connection string.
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const raw = process.env.DATABASE_URL;
const pgDump = process.env.PG_DUMP || "pg_dump";
if (!raw) {
  console.error("DATABASE_URL is not set (expected in .env.local).");
  process.exit(1);
}
const url = new URL(raw);
const secrets = [raw, url.password, decodeURIComponent(url.password)].filter(Boolean);
const scrub = (s) => secrets.reduce((acc, x) => acc.split(x).join("***"), String(s));
url.searchParams.set("sslmode", "require");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join("backups", stamp);
mkdirSync(dir, { recursive: true });

function dump(file, args) {
  const r = spawnSync(pgDump, [`--dbname=${url.toString()}`, "--no-password", "--file", join(dir, file), ...args], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) {
    console.error(`pg_dump ${file} failed (exit ${r.status}): ${scrub(r.stderr || r.error?.message || "")}`);
    process.exit(1);
  }
  console.log(`  ${file.padEnd(28)} ${(statSync(join(dir, file)).size / 1024).toFixed(1)} KB`);
}

console.log(`Backing up to ${dir}`);
dump("public_and_migrations.sql", ["--schema=public", "--schema=supabase_migrations", "--column-inserts", "--no-comments"]);
dump("auth_data.sql", ["--schema=auth", "--data-only", "--column-inserts"]);

// Live counts, compared after restoring into PGlite.
const c = new pg.Client({ connectionString: (() => { const u = new URL(raw); u.searchParams.delete("sslmode"); return u.toString(); })(), ssl: { rejectUnauthorized: false } });
await c.connect();
const tables = (await c.query("select table_schema, table_name from information_schema.tables where table_schema in ('public','supabase_migrations') and table_type = 'BASE TABLE' order by 1, 2")).rows;
const counts = {};
for (const t of tables) counts[`${t.table_schema}.${t.table_name}`] = Number((await c.query(`select count(*) from "${t.table_schema}"."${t.table_name}"`)).rows[0].count);
const [objects] = (
  await c.query(`select
    (select count(*) from pg_proc where pronamespace = 'public'::regnamespace)::int as functions,
    (select count(*) from pg_policies where schemaname = 'public')::int as policies,
    (select count(*) from pg_trigger t join pg_class r on r.oid = t.tgrelid where r.relnamespace = 'public'::regnamespace and not t.tgisinternal)::int as triggers,
    (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relrowsecurity)::int as rls_tables,
    (select count(*) from auth.users)::int as auth_users`)
).rows;
const authUserColumns = (await c.query("select column_name, data_type, udt_name, is_generated, is_nullable from information_schema.columns where table_schema = 'auth' and table_name = 'users' order by ordinal_position")).rows;
await c.end();
writeFileSync(join(dir, "meta.json"), JSON.stringify({ created: new Date().toISOString(), counts, objects, authUserColumns }, null, 2));
console.log(`  meta.json: ${tables.length} tables, ${objects.functions} functions, ${objects.policies} policies, ${objects.triggers} triggers, ${objects.auth_users} auth users`);
console.log(dir);
