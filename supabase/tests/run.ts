// Runs every database test suite against one target and writes raw output.
//   npm run test:db              → PGlite (fresh database built from the migrations)
//   npm run test:db:supabase     → the Supabase project in DATABASE_URL, using
//                                   test-prefixed users that are deleted afterwards
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pgliteTarget, Reporter, supabaseTarget, type Target } from "./lib/harness";
import { authzSuite } from "./suites/authz";
import { concurrencySuite } from "./suites/concurrency";
import { gpsSuite } from "./suites/gps";
import { lifecycleSuite } from "./suites/lifecycle";
import { beforeMigration, migrationsSuite } from "./suites/migrations";

const which = (process.argv[2] ?? "pglite") as "pglite" | "supabase";
const outDir = process.argv[3]; // optional: write raw output + JSON here

const lines: string[] = [];
const out = (l: string) => {
  lines.push(l);
  console.log(l);
};
const secrets = [process.env.DATABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY]
  .filter((s): s is string => !!s && s.length > 8);
const scrub = (s: string) => secrets.reduce((acc, x) => acc.split(x).join("***"), s);

async function main() {
  const started = new Date();
  out(`# Database test run — target: ${which}`);
  out(`started: ${started.toISOString()}`);
  const t: Target = which === "supabase" ? await supabaseTarget() : await pgliteTarget({ beforeMigration });
  out(`run id: ${t.runId}; parallel backends: ${t.parallel}; fresh database: ${t.fresh}`);
  const r = new Reporter(out);
  let crashed: string | null = null;

  // Supabase: fingerprint every non-test row before and after, to show the run left real data untouched.
  const fingerprint = () =>
    t.admin<{ users: number; rows: number; md5: string }>(
      `with real_users as (select id from auth.users where not (email like 'test-%' and email like '%@nama.test'))
       select (select count(*)::int from real_users) as users, count(*)::int as rows, md5(coalesce(string_agg(x, ',' order by x), '')) as md5 from (
         select 'p' || row_to_json(p)::text as x from public.profiles p where p.id in (select id from real_users)
         union all select 't' || row_to_json(k)::text from public.tankers k where k.driver_id in (select id from real_users)
         union all select 'o' || row_to_json(o)::text from public.orders o where o.customer_id in (select id from real_users)
         union all select 'l' || row_to_json(l)::text from public.order_locations l join public.orders o on o.id = l.order_id where o.customer_id in (select id from real_users)
       ) s`,
    );
  const before = t.name === "supabase" ? (await fingerprint())[0] : null;
  if (before) out(`non-test data before: ${before.users} users, ${before.rows} rows, md5 ${before.md5}`);
  try {
    for (const suite of [migrationsSuite, lifecycleSuite, authzSuite, concurrencySuite, gpsSuite]) {
      try {
        await suite(t, r);
      } catch (e) {
        r.check(`${suite.name} crashed`, false, (e as Error).stack ?? String(e));
      }
    }
  } catch (e) {
    crashed = (e as Error).message;
  } finally {
    out("\n## CLEANUP");
    if (before) {
      const [after] = await fingerprint();
      out(`non-test data after:  ${after.users} users, ${after.rows} rows, md5 ${after.md5}`);
      r.start("SAFE live-project safety");
      r.check("non-test users and rows are byte-for-byte unchanged by the run", after.md5 === before.md5 && after.rows === before.rows && after.users === before.users, { before, after });
    }
    for (const l of await t.cleanup().catch((e) => [`cleanup ERROR: ${(e as Error).message}`])) out(l);
  }
  const pass = r.results.filter((x) => x.ok && !x.skipped).length;
  const fail = r.results.filter((x) => !x.ok).length;
  const skip = r.results.filter((x) => x.skipped).length;
  out(`\n${pass} passed, ${fail} failed, ${skip} skipped${crashed ? ` — runner error: ${crashed}` : ""}`);
  out(`finished: ${new Date().toISOString()}`);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${which}.txt`), scrub(lines.join("\n")) + "\n");
    writeFileSync(join(outDir, `${which}.json`), scrub(JSON.stringify({ target: which, started: started.toISOString(), runId: t.runId, parallel: t.parallel, pass, fail, skip, results: r.results }, null, 2)) + "\n");
  }
  process.exit(fail || crashed ? 1 : 0);
}

main().catch((e) => {
  console.error(scrub(String(e?.stack ?? e)));
  process.exit(1);
});
