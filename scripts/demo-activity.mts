// Puts activity on the NWS Live operations board without needing two phones.
//   npm run demo            full loop: driver online and idle → customer request →
//                           accept → simulated drive → arrived → delivered → offline
//   npm run demo -- --idle  driver online and reporting GPS from a fixed spot until Ctrl+C
// It signs in as the seeded customer and driver (SEED_PASSWORD) with the publishable key
// and goes through the same RPCs as the app, so RLS and the permit/block checks apply.
// It never uses the service-role key. Ctrl+C sets the tanker offline and cancels or
// finishes any order it created.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildDemoRoute, positionAt, travelled } from "../lib/simulator";
import type { LngLat, Order } from "../lib/types";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const password = process.env.SEED_PASSWORD;
if (!url || !key || !password) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and SEED_PASSWORD in .env.local (run npm run seed first).");
  process.exit(1);
}
const idleOnly = process.argv.includes("--idle");

const CUSTOMER_PIN: LngLat = { lat: 23.588, lng: 58.406 }; // Al Khuwair
const IDLE_S = 40; // online and idle before the request comes in
const OFFER_S = 20; // request visible as "waiting for a tanker" before it's accepted
const AT_DOOR_S = 20; // arrived → delivered

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()}  ${m}`);

async function signIn(email: string): Promise<SupabaseClient> {
  const db = createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: true } });
  const { error } = await db.auth.signInWithPassword({ email, password: password! });
  if (error) throw new Error(`${email}: ${error.message}`);
  return db;
}

async function rpc<T = unknown>(db: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

/** Same rules as the phone: 5–12 m accuracy, the fix's own timestamp. */
const report = (db: SupabaseClient, p: LngLat) =>
  rpc(db, "report_location", { p_lat: p.lat, p_lng: p.lng, p_accuracy_m: 5 + Math.random() * 7, p_recorded_at: new Date().toISOString() });

/** Parked: a fix every 30 s (the stationary cadence), with a few metres of GPS jitter. */
async function idle(db: SupabaseClient, at: LngLat, seconds: number, stop: () => boolean) {
  const end = Date.now() + seconds * 1000;
  while (!stop() && Date.now() < end) {
    await report(db, { lat: at.lat + (Math.random() - 0.5) * 0.00005, lng: at.lng + (Math.random() - 0.5) * 0.00005 });
    await sleep(Math.min(30_000, Math.max(0, end - Date.now())));
  }
}

let stopping = false;
let driver: SupabaseClient | null = null;
let customer: SupabaseClient | null = null;
let orderId: string | null = null;

async function cleanUp() {
  if (customer && orderId) {
    const { data } = await customer.from("orders").select("status").eq("id", orderId).maybeSingle<Pick<Order, "status">>();
    if (data?.status === "requested") await customer.rpc("cancel_order", { p_order_id: orderId }).then(() => log("Cancelled the open request."));
    if (driver && data?.status && ["accepted", "arriving"].includes(data.status)) await driver.rpc("mark_arrived", { p_order_id: orderId });
    if (driver && data?.status && ["accepted", "arriving", "arrived"].includes(data.status)) await driver.rpc("mark_delivered", { p_order_id: orderId }).then(() => log("Finished the job in progress."));
  }
  if (driver) await driver.rpc("driver_set_online", { p_online: false }).then(() => log("Tanker set offline."));
}

process.on("SIGINT", () => {
  if (stopping) process.exit(1);
  stopping = true;
  log("Stopping…");
});

try {
  // The tanker waits at the start of its road route (snapped to a road, ~3 km from the customer).
  const route = await buildDemoRoute(CUSTOMER_PIN);
  const IDLE_SPOT = route.points[0];
  driver = await signIn("driver@nama.test");
  const tanker = await rpc<{ plate: string }>(driver, "driver_set_online", { p_online: true });
  log(`${tanker.plate} is online.`);
  await report(driver, IDLE_SPOT);

  if (idleOnly) {
    log("Reporting GPS every 30 s. Ctrl+C to stop.");
    await idle(driver, IDLE_SPOT, Number.POSITIVE_INFINITY, () => stopping);
  } else {
    log(`Waiting ${IDLE_S} s online and idle…`);
    await idle(driver, IDLE_SPOT, IDLE_S, () => stopping);

    if (!stopping) {
      customer = await signIn("customer@nama.test");
      const order = await rpc<Order>(customer, "place_order", {
        p_service_type: "DW", p_gallons: 3000, p_lat: CUSTOMER_PIN.lat, p_lng: CUSTOMER_PIN.lng, p_area: "Al Khuwair", p_address: "Demo request",
      });
      orderId = order.id;
      log(`Customer placed TO-${order.order_no} (DW 3,000 gal). Waiting ${OFFER_S} s before accepting…`);
      await idle(driver, IDLE_SPOT, OFFER_S, () => stopping);
    }

    if (!stopping && orderId) {
      await rpc(driver, "accept_order", { p_order_id: orderId });
      log("Driver accepted. Driving…");
      log(`Route: ${(route.totalM / 1000).toFixed(1)} km (${route.source}).`);
      const startedAt = Date.now();
      for (;;) {
        const m = Math.min(route.totalM, travelled((Date.now() - startedAt) / 1000));
        await report(driver, positionAt(route, m));
        if (stopping || m >= route.totalM) break;
        await sleep(10_000); // moving cadence
      }
    }

    if (!stopping && orderId) {
      await rpc(driver, "mark_arrived", { p_order_id: orderId });
      log(`Arrived. Delivering in ${AT_DOOR_S} s…`);
      await idle(driver, CUSTOMER_PIN, AT_DOOR_S, () => stopping);
      await rpc(driver, "mark_delivered", { p_order_id: orderId });
      log("Delivered.");
      orderId = null;
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await cleanUp().catch((e) => console.error("Clean-up:", e instanceof Error ? e.message : e));
}
