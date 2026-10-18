// Unit tests for client-side tracking rules (no database).  npm run test:unit
import { OSRM_URL, routeEta, routeEtaFallback } from "../../lib/routing";
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

async function routing() {
  console.log("\n## UNIT road ETA (OSRM behind routeEta)");
  const A = { lat: 23.6, lng: 58.4 };
  const B = { lat: 23.6, lng: 58.4 + 0.0977 }; // ≈ 10 km east
  const fb = routeEtaFallback(A, B);
  check("fallback is labelled straight-line", fb.source === "straight-line", fb);
  check("fallback distance ≈ 10 km", Math.abs(fb.km - 10) < 0.3, fb);
  check("fallback ETA uses ~25 km/h (≈ 24 min)", fb.minutes >= 22 && fb.minutes <= 26, fb);

  let calledUrl = "";
  const ok = (body: unknown, status = 200) =>
    (async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  const r1 = await routeEta(A, B, { fetchImpl: ok({ code: "Ok", routes: [{ distance: 12_400, duration: 1_080 }] }) });
  check("OSRM response → road distance and duration", r1.source === "osrm" && Math.abs(r1.km - 12.4) < 1e-9 && r1.minutes === 18, r1);
  check("request goes to the configured OSRM base URL, lng,lat order", calledUrl.startsWith(`${OSRM_URL}/route/v1/driving/58.400000,23.600000;`), calledUrl);
  const r2 = await routeEta(A, B, { fetchImpl: ok({ code: "Ok", routes: [{ distance: 500, duration: 60, geometry: { coordinates: [[58.4, 23.6], [58.41, 23.6]] } }] }), withPath: true });
  check("withPath returns the road geometry", r2.path?.length === 2, r2);
  const r3 = await routeEta(A, B, { fetchImpl: ok({ message: "busy" }, 503) });
  check("HTTP error → straight-line fallback", r3.source === "straight-line", r3);
  const r4 = await routeEta(A, B, { fetchImpl: ok({ code: "NoRoute", routes: [] }) });
  check("no route → straight-line fallback", r4.source === "straight-line", r4);
  const r5 = await routeEta(A, B, { fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
  check("network failure → straight-line fallback (never throws)", r5.source === "straight-line", r5);
}

routing().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
