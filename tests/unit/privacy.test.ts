// Source check: customer screens never send the customer's position to the server.
// The customer's own position may be read (to pre-fill the delivery pin) and shown
// locally; the only coordinates a customer sends are the delivery point chosen
// in the request wizard, via place_order.   npm run test:unit
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
const customerFiles = [...walk(join(root, "app", "customer")), join(root, "components", "CustomerContext.tsx")];
const src = customerFiles.map((f) => ({ f: f.slice(root.length + 1), s: readFileSync(f, "utf8") }));
const offending = (re: RegExp) => src.filter((x) => re.test(x.s)).map((x) => x.f);

check(`customer code (${customerFiles.length} files) never calls report_location`, offending(/report_location/).length === 0, offending(/report_location/));
check("customer code never watches the position continuously (no watchPosition)", offending(/watchPosition/).length === 0, offending(/watchPosition/));
const rpcCalls = src.flatMap((x) => [...x.s.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => ({ f: x.f, fn: m[1] })));
const coordRpcs = src.flatMap((x) => [...x.s.matchAll(/\.rpc\(\s*"([a-z_]+)"[^)]*?p_lat/g)].map((m) => m[1]));
check("the only RPC customer code sends coordinates to is place_order (the chosen delivery point)", coordRpcs.length > 0 && coordRpcs.every((fn) => fn === "place_order"), { coordRpcs, rpcCalls });
const tableWrites = src.flatMap((x) => [...x.s.matchAll(/\.from\(\s*"([a-z_]+)"\s*\)\s*\.(insert|update|upsert)/g)].map((m) => `${x.f}: ${m[1]}.${m[2]}`));
check("customer code makes no direct table inserts/updates", tableWrites.length === 0, tableWrites);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
