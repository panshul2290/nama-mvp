// Import an NWS tanker register CSV through the same validation (lib/importRegister.ts) and the
// same RPCs (staff_import_batch_start / staff_import_register / staff_import_batch_finish, 0032)
// as NWS → Permits → Register → Import register.
//
//   npm run import:register                        dry run of data-private/tankers-demo-anonymised.csv
//   npm run import:register -- path/to/file.csv    dry run of another file
//   npm run import:register -- --confirm-live      import into the project in NEXT_PUBLIC_SUPABASE_URL
//
// The dry run reads the file only and prints counts (never names, numbers or plates). A live
// import signs in as a permit officer (IMPORT_EMAIL, default nws-permits@nama.test, with
// IMPORT_PASSWORD or SEED_PASSWORD) using the publishable key, so the staff role checks and the
// audit log apply; it never uses the service-role key. Chunks of 500 rows; safe to re-run
// (idempotent by plate). The real register ("Tankers Data*.csv") is refused unless
// --real-register is also given: the demo uses the anonymised copy.
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { addCounts, chunks, clientOnlyIssues, validateCsv } from "../lib/importRegister.ts";

const args = process.argv.slice(2);
const live = args.includes("--confirm-live");
const allowReal = args.includes("--real-register");
const file = resolve(args.find((a) => !a.startsWith("--")) ?? "data-private/tankers-demo-anonymised.csv");
const name = basename(file);

if (/^tankers data/i.test(name) && !allowReal) {
  console.error(`Refusing ${name}: that is NWS's real register. Import the anonymised copy for the demo, or pass --real-register on purpose.`);
  process.exit(1);
}

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Muscat", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
let text;
try {
  text = readFileSync(file, "utf8");
} catch (e) {
  console.error(`Can't read ${file}: ${e.message}`);
  process.exit(1);
}
const v = validateCsv(text, { today });
const s = v.summary;
const pad = (l, n) => `${l.padEnd(34)}${String(n).padStart(8)}`;

console.log(`\nRegister file: ${name} (${live ? "LIVE import" : "dry run"})`);
if (v.missing.length) {
  console.error(`Columns missing: ${v.missing.join("; ")}. Headers found: ${v.headers.length}.`);
  process.exit(1);
}
console.log(pad("Rows", s.total));
console.log(pad("  OK", s.ok));
console.log(pad("  with warnings (imported)", s.warnings));
console.log(pad("  with errors (skipped)", s.errors));
console.log(pad("  duplicate plates in the file", s.duplicates));
console.log(pad("Rows to import", s.send));
console.log(pad("  Drinking water (DW)", s.by_service.DW));
console.log(pad("  Sewage water (WW)", s.by_service.WW));
console.log(pad("  Treated effluent (TE)", s.by_service.TE));
console.log(pad("  permit Valid → approved permit", s.status.valid));
console.log(pad("  In Progress → application", s.status.in_progress));
console.log(pad("  No Permit", s.status.none));
console.log(pad("  with a usable mobile number", s.with_phone));
console.log(pad("  without (missing or invalid)", s.no_phone));
console.log(pad("  distinct owner numbers", s.owners_by_phone));
console.log("By governorate (code: rows):", Object.entries(s.by_governorate).sort().map(([g, n]) => `${g} ${n}`).join(", "));
console.log(`Governorate → cluster: ${s.inconsistent_governorates.length ? `INCONSISTENT for ${s.inconsistent_governorates.join(", ")}` : "consistent (one cluster per governorate)"}`);
const byKind = new Map();
for (const x of v.issues) {
  const k = `${x.level.padEnd(7)} ${x.field}: ${x.message.replace(/: [^;]*$/, ": …").replace(/\d+/g, "N")}`;
  const e = byKind.get(k) ?? { n: 0, rows: [] };
  e.n++;
  if (e.rows.length < 5) e.rows.push(x.row);
  byKind.set(k, e);
}
if (byKind.size) {
  console.log("Issues (count, first rows):");
  for (const [k, e] of [...byKind].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${String(e.n).padStart(6)}  ${k}  [rows ${e.rows.join(", ")}${e.n > e.rows.length ? ", …" : ""}]`);
}

if (!live) {
  console.log("\nDry run only: nothing was sent. Add --confirm-live to import into the configured project.");
  process.exit(0);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const email = process.env.IMPORT_EMAIL ?? "nws-permits@nama.test";
const password = process.env.IMPORT_PASSWORD ?? process.env.SEED_PASSWORD;
if (!url || !key || !password) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and IMPORT_PASSWORD (or SEED_PASSWORD) in .env.local.");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: true } });
const { error: signErr } = await db.auth.signInWithPassword({ email, password });
if (signErr) {
  console.error(`Sign-in as ${email} failed: ${signErr.message}`);
  process.exit(1);
}
const rpc = async (fn, a) => {
  const { data, error } = await db.rpc(fn, a);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
};

const batch = await rpc("staff_import_batch_start", { p_file_name: name, p_total: s.total, p_summary: s, p_source: "script" });
console.log(`\nImport batch ${batch.id}: ${s.send} rows in ${Math.ceil(s.send / 500)} chunks`);
let counts = {};
let serverIssues = 0;
const parts = chunks(v.rows, 500);
const started = Date.now();
try {
  for (let i = 0; i < parts.length; i++) {
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await rpc("staff_import_register", { p_rows: parts[i], p_batch_id: batch.id });
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        console.log(`  chunk ${i + 1}: ${e.message} — retrying`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    counts = addCounts(counts, res.counts);
    serverIssues += res.issues.length;
    process.stdout.write(`\r  ${i + 1}/${parts.length} chunks · ${Math.round(((i + 1) / parts.length) * 100)}% · ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }
  process.stdout.write("\n");
  await rpc("staff_import_batch_finish", { p_batch_id: batch.id, p_client_issues: clientOnlyIssues(v.issues), p_status: "completed" });
} catch (e) {
  console.error(`\nImport stopped: ${e.message}`);
  await rpc("staff_import_batch_finish", { p_batch_id: batch.id, p_client_issues: clientOnlyIssues(v.issues), p_status: "failed" }).catch(() => undefined);
  process.exit(1);
}
console.log("Database counts:");
for (const [k, n] of Object.entries(counts)) console.log(pad(`  ${k.replace(/_/g, " ")}`, n));
console.log(pad("  issues reported by the database", serverIssues));
console.log(`Done. The error report is on NWS → Permits → Register → Imports (batch ${batch.id}).`);
process.exit(0);
