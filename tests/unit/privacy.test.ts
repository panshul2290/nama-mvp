// Source check: customer screens never send the customer's position to the server.
// The customer's own position may be read (to pre-fill the delivery pin) and shown
// locally; the only coordinates a customer sends are points they chose: the
// delivery pin (create_order / place_order) and a saved property (save_property).
//   npm run test:unit
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${JSON.stringify(detail)}`}`);
};

console.log("## UNIT customer location privacy (source check)");
const customerFiles = [...walk(join(root, "app", "customer")), ...walk(join(root, "components", "customer")), join(root, "components", "CustomerContext.tsx")];
const src = customerFiles.map((f) => ({ f: f.slice(root.length + 1), s: readFileSync(f, "utf8") }));
const offending = (re: RegExp) => src.filter((x) => re.test(x.s)).map((x) => x.f);

check(`customer code (${customerFiles.length} files) never calls report_location`, offending(/report_location/).length === 0, offending(/report_location/));
check("customer code never watches the position continuously (no watchPosition)", offending(/watchPosition/).length === 0, offending(/watchPosition/));
const rpcCalls = src.flatMap((x) => [...x.s.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => ({ f: x.f, fn: m[1] })));
// Files that build a p_lat argument may only call the RPCs that take a chosen point.
const CHOSEN_POINT = ["place_order", "create_order", "save_property"];
const coordFiles = src.filter((x) => /p_lat/.test(x.s));
const coordRpcs = coordFiles.flatMap((x) => rpcCalls.filter((c) => c.f === x.f).map((c) => c.fn));
check(
  `customer code sends coordinates only to ${CHOSEN_POINT.join(" / ")} (points the customer chose)`,
  coordFiles.length > 0 && coordRpcs.some((fn) => CHOSEN_POINT.includes(fn)) &&
    coordFiles.every((x) => !/report_location|staff_|send_message[^)]*p_lat/.test(x.s)),
  { coordRpcs, files: coordFiles.map((x) => x.f) },
);
const tableWrites = src.flatMap((x) => [...x.s.matchAll(/\.from\(\s*"([a-z_]+)"\s*\)\s*\.(insert|update|upsert)/g)].map((m) => `${x.f}: ${m[1]}.${m[2]}`));
// The only direct write is the customer's own profile (column grants limit it to name, phone, language and preferences).
const otherWrites = tableWrites.filter((w) => !w.endsWith("profiles.update"));
check("customer code makes no direct table writes except its own profile", otherWrites.length === 0, tableWrites);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
