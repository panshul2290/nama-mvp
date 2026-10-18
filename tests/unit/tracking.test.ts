// Unit tests for client-side tracking rules (no database).  npm run test:unit
import { shouldSend, usable, type Fix } from "../../lib/tracking";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${JSON.stringify(detail)}`}`);
};

const t0 = 1_800_000_000_000;
const at = (lat: number, lng: number, accuracy = 8, ts = t0): Fix => ({ lat, lng, accuracy, at: ts });
const NEAR = 0.0001; // ≈ 11 m of latitude
const FAR = 0.0005; // ≈ 55 m

console.log("## UNIT tracking cadence");
check("first usable fix is sent immediately", shouldSend(at(23.6, 58.2), null, t0));
check("fix with accuracy 100 m is usable", usable(at(23.6, 58.2, 100), t0));
check("fix with accuracy 101 m is rejected (never sent)", !shouldSend(at(23.6, 58.2, 101), null, t0));
check("fix older than 60 s is not sent", !shouldSend(at(23.6, 58.2, 8, t0 - 61_000), null, t0));
const last = { lat: 23.6, lng: 58.2, at: t0 };
check("moving (>15 m) → sent again after 10 s", shouldSend(at(23.6 + FAR, 58.2, 8, t0 + 10_000), last, t0 + 10_000));
check("moving (>15 m) → not before 10 s", !shouldSend(at(23.6 + FAR, 58.2, 8, t0 + 5_000), last, t0 + 5_000));
check("not moving (≤15 m) → not sent after 10 s", !shouldSend(at(23.6 + NEAR, 58.2, 8, t0 + 10_000), last, t0 + 10_000));
check("not moving (≤15 m) → not sent after 20 s", !shouldSend(at(23.6 + NEAR, 58.2, 8, t0 + 20_000), last, t0 + 20_000));
check("not moving (≤15 m) → sent after 30 s", shouldSend(at(23.6 + NEAR, 58.2, 8, t0 + 30_000), last, t0 + 30_000));
check("parked, inaccurate fix after 30 s → still not sent", !shouldSend(at(23.6, 58.2, 150, t0 + 30_000), last, t0 + 30_000));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
