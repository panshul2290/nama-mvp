// Runs the database test suites on PGlite and on the Supabase project, saves the
// raw output to docs/evidence/raw/, and writes docs/evidence/test-report.md.
//   npm run evidence
// Never writes .env.local values: run.ts scrubs them, and this file only reads
// the region code from the pooler hostname.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "docs/evidence";
const RAW = join(OUT, "raw");
mkdirSync(RAW, { recursive: true });

const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain", "--", ".", ":!docs/evidence").length > 0;

// --report-only rebuilds the report from the raw JSON already in docs/evidence/raw.
const reportOnly = process.argv.includes("--report-only");
const runs = [];
for (const target of ["pglite", "supabase"]) {
  let exit = null;
  if (!reportOnly) {
    console.log(`\n=== ${target} ===`);
    const args = ["tsx", ...(target === "supabase" ? ["--env-file-if-exists=.env.local"] : []), "supabase/tests/run.ts", target, RAW];
    exit = spawnSync("npx", args, { stdio: "inherit", shell: true }).status;
  }
  const json = JSON.parse(readFileSync(join(RAW, `${target}.json`), "utf8"));
  runs.push({ target, exit: exit ?? (json.fail ? 1 : 0), ...json });
}

let region = "unknown";
try {
  const host = new URL(process.env.DATABASE_URL).hostname;
  region = /^aws-\d+-([a-z]+-[a-z]+-\d+)\.pooler\.supabase\.com$/.exec(host)?.[1] ?? "unknown";
} catch {}
const pgVersion = (() => {
  const m = /Postgres (\d+\.\d+)/.exec(readFileSync(join(RAW, "supabase.txt"), "utf8"));
  return m?.[1];
})();

const icon = (x) => (x.skipped ? "SKIP" : x.ok ? "PASS" : "FAIL");
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const now = new Date();
let md = `# Test report — database authorization, concurrency and GPS freshness

| | |
|---|---|
| Generated | ${now.toISOString()} (UTC) |
| Git commit | \`${commit}\`${dirty ? " (working tree had uncommitted changes outside docs/evidence)" : ""} |
| Node.js | ${process.version} on ${process.platform} |
| PGlite | ${JSON.parse(readFileSync("node_modules/@electric-sql/pglite/package.json", "utf8")).version} (Postgres compiled to WASM, single connection) |
| Supabase | project region \`${region}\`, Postgres ${pgVersion ?? "?"}, reached through the Supavisor transaction pooler |
| Command | \`npm run evidence\` (runs \`supabase/tests/run.ts\` against each target) |

## Summary

| Target | Started | Passed | Failed | Skipped | Exit |
|---|---|---|---|---|---|
${runs.map((r) => `| ${r.target} | ${r.started} | ${r.pass} | ${r.fail} | ${r.skip} | ${r.exit} |`).join("\n")}

Raw output: [raw/pglite.txt](raw/pglite.txt), [raw/supabase.txt](raw/supabase.txt) (and the matching \`.json\`).

## How the two runs differ

- **PGlite** builds a fresh database from \`supabase/migrations/*.sql\` on a stub of Supabase's \`auth\` schema and roles. It has one connection, so the race tests run serialised there: that checks the logic, not concurrency.
- **Supabase** runs the same suites against the live project. Every user is created as \`test-<run id>-…@nama.test\` through the Auth admin API, with test-prefixed tanker plates and order areas. All of them are deleted at the end, and their rows go with them via foreign-key cascades. The run fingerprints every non-test user and row (md5 over profiles, tankers, orders, order_locations) before and after, and fails if anything changed. Checks that need a global change run in transactions that are rolled back.
- **Race tests on Supabase:** each driver has its own Postgres backend, and all are held at an advisory-lock barrier inside their transaction, then released together. The output records how many were blocked at the barrier when it opened. The pooler limits how many transactions can hold a server connection at the same moment.
- **Side effect:** the order-number sequence advances during the Supabase run (test orders consume numbers), so real order numbers skip ahead. No real row is changed.

## Results
`;
const sections = [...new Set(runs.flatMap((r) => r.results.map((x) => x.section)))];
for (const section of sections) {
  md += `\n### ${section}\n\n| ID | Check | PGlite | Supabase |\n|---|---|---|---|\n`;
  const names = [...new Map(runs.flatMap((r) => r.results.filter((x) => x.section === section).map((x) => [x.name, x.id]))).entries()];
  for (const [name, id] of names) {
    const cell = (target) => {
      const x = runs.find((r) => r.target === target).results.find((y) => y.section === section && y.name === name);
      if (!x) return "—";
      return icon(x) + (x.skipped || !x.ok ? ` (${esc(x.detail).slice(0, 140)})` : "") + (x.note ? ` — ${esc(x.note).slice(0, 220)}` : "");
    };
    md += `| ${id} | ${esc(name)} | ${cell("pglite")} | ${cell("supabase")} |\n`;
  }
}
writeFileSync(join(OUT, "test-report.md"), md);
console.log(`\nwrote ${join(OUT, "test-report.md")}`);
process.exit(runs.some((r) => r.fail || r.exit) ? 1 : 0);
