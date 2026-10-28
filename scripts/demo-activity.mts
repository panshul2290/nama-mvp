// Puts activity on the NWS Live operations board without needing two phones.
//   npm run demo            full loop: driver online and idle → customer request → accept →
//                           drive to the filling station → fill → drive to the customer →
//                           arrived → proof of delivery (photo, meter, signature) → offline
//   npm run demo -- --idle  driver online and reporting GPS from a fixed spot until Ctrl+C
// It signs in as the seeded customer and driver (SEED_PASSWORD) with the publishable key
// and goes through the same RPCs as the app, so RLS and the permit/block checks apply.
// It never uses the service-role key. Ctrl+C sets the tanker offline and cancels or
// finishes any order it created. DEMO_CUSTOMER / DEMO_DRIVER pick other seeded accounts.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildDemoRoute, positionAt, travelled } from "../lib/simulator";
import type { LngLat, Order, Site } from "../lib/types";

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
const CUSTOMER_EMAIL = process.env.DEMO_CUSTOMER ?? "customer@nama.test";
const DRIVER_EMAIL = process.env.DEMO_DRIVER ?? "driver@nama.test";
/** A 1×1 JPEG standing in for the phone's photo of the tank inlet (submit_pod needs an uploaded object). */
const POD_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDrKKKK0Mj/2Q==",
  "base64",
);
/** The signature pad's path data (a short scribble in its 300×120 box). */
const SIGNATURE = "M40 80L70 50L95 85L130 40L160 82L200 45L240 78";

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

/** Proof of delivery as the app does it: upload the photo to evidence/<driver>/…, then submit_pod. */
async function deliver(db: SupabaseClient, order: Order) {
  const { data: auth } = await db.auth.getUser();
  const path = `${auth.user!.id}/${order.id}-pod.jpg`;
  const up = await db.storage.from("evidence").upload(path, POD_JPEG, { contentType: "image/jpeg", upsert: false });
  if (up.error) throw new Error(`photo upload: ${up.error.message}`);
  await rpc(db, "submit_pod", { p_order_id: order.id, p_meter_gal: order.gallons, p_photo_path: path, p_signature_svg: SIGNATURE });
}

/** Drive a route at the moving cadence (a fix every 10 s). */
async function drive(db: SupabaseClient, to: LngLat, from: LngLat, stop: () => boolean) {
  const route = await buildDemoRoute(to, from);
  log(`Route: ${(route.totalM / 1000).toFixed(1)} km (${route.source}).`);
  const startedAt = Date.now();
  for (;;) {
    const m = Math.min(route.totalM, travelled((Date.now() - startedAt) / 1000));
    await report(db, positionAt(route, m));
    if (stop() || m >= route.totalM) break;
    await sleep(10_000);
  }
}

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
let order: Order | null = null;

async function cleanUp() {
  if (customer && orderId) {
    const { data } = await customer.from("orders").select("status").eq("id", orderId).maybeSingle<Pick<Order, "status">>();
    if (data?.status === "requested") await customer.rpc("cancel_order", { p_order_id: orderId }).then(() => log("Cancelled the open request."));
    if (driver && data?.status && ["accepted", "arriving"].includes(data.status)) await driver.rpc("mark_arrived", { p_order_id: orderId });
    if (driver && order && data?.status && ["accepted", "arriving", "arrived"].includes(data.status)) await deliver(driver, order).then(() => log("Finished the job in progress."));
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
  driver = await signIn(DRIVER_EMAIL);
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
      customer = await signIn(CUSTOMER_EMAIL);
      order = await rpc<Order>(customer, "place_order", {
        p_service_type: "DW", p_gallons: 3000, p_lat: CUSTOMER_PIN.lat, p_lng: CUSTOMER_PIN.lng, p_area: "Al Khuwair", p_address: "Demo request",
      });
      orderId = order.id;
      log(`Customer placed TO-${order.order_no} (DW 3,000 gal). Waiting ${OFFER_S} s before accepting…`);
      await idle(driver, IDLE_SPOT, OFFER_S, () => stopping);
    }

    if (!stopping && orderId) {
      await rpc(driver, "accept_order", { p_order_id: orderId });
      // Same legs as the app: fill at the nearest station for the service, then the customer.
      const { data: sites } = await driver.from("sites").select("*").eq("kind", "fill").eq("active", true);
      const fill = ((sites ?? []) as Site[]).filter((x) => x.service_types.includes("DW")).sort((a, b) => Math.hypot(a.lat - IDLE_SPOT.lat, a.lng - IDLE_SPOT.lng) - Math.hypot(b.lat - IDLE_SPOT.lat, b.lng - IDLE_SPOT.lng))[0];
      if (!fill) throw new Error("No active DW filling station");
      log(`Driver accepted. Driving to ${fill.name} to fill…`);
      await drive(driver, fill, IDLE_SPOT, () => stopping);
      if (!stopping) {
        await rpc(driver, "confirm_fill", { p_order_id: orderId });
        log("Filled. Driving to the customer…");
        await drive(driver, CUSTOMER_PIN, fill, () => stopping);
      }
    }

    if (!stopping && orderId && order) {
      await rpc(driver, "mark_arrived", { p_order_id: orderId });
      log(`Arrived. Delivering in ${AT_DOOR_S} s…`);
      await idle(driver, CUSTOMER_PIN, AT_DOOR_S, () => stopping);
      await deliver(driver, order);
      log("Delivered (proof of delivery submitted).");
      orderId = null;
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await cleanUp().catch((e) => console.error("Clean-up:", e instanceof Error ? e.message : e));
}
