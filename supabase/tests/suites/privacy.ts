// Location privacy.
//  1. Customers never send their live location to the server.
//  2. A driver's location is visible only to the customer of the active order,
//     and stops being visible once that order is delivered or cancelled.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Reporter, Target } from "../lib/harness";
import { makeWorld, placeOrder, setOnline } from "../lib/world";

const sees = async (t: Target, viewer: string | null, driver: string) =>
  (await t.as<{ last_lat: number }>(viewer, "select last_lat from tankers where driver_id = $1", [driver]).catch(() => [])).length > 0;

/** Realtime: count tanker UPDATE events `client` receives for `driver` while `act` runs. */
async function realtimeEvents(client: SupabaseClient, driver: string, act: () => Promise<unknown>, waitMs = 6000): Promise<number | "not-subscribed"> {
  let n = 0;
  const ch = client
    .channel(`privacy-${driver}-${Math.random().toString(36).slice(2)}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "tankers", filter: `driver_id=eq.${driver}` }, () => n++);
  const ok = await new Promise<boolean>((res) => {
    const timer = setTimeout(() => res(false), 10_000);
    ch.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        res(true);
      }
    });
  });
  if (!ok) {
    await client.removeChannel(ch);
    return "not-subscribed";
  }
  await new Promise((res) => setTimeout(res, 1500)); // let the subscription settle server-side
  await act();
  await new Promise((res) => setTimeout(res, waitMs));
  await client.removeChannel(ch);
  return n;
}

export async function privacySuite(t: Target, r: Reporter) {
  r.start("PRIV location privacy");
  const w = await makeWorld(t, "priv");
  const { C1, C2, D1, D2 } = w;
  await setOnline(t, D1.id, true);
  const ping = (lat: number) => t.as(D1.id, "select report_location($1, 58.2, 8, now())", [lat]);
  await ping(23.61); // the driver has a position before any job

  // ---- 1. customers never send their live location
  await r.denies("a customer cannot report a live location (report_location → not_a_driver)", () => t.as(C1.id, "select report_location(23.6, 58.2, 5, now())"), "not_a_driver");
  const writable = await t.admin<{ table_name: string; column_name: string; privilege_type: string }>(
    `select table_schema || '.' || table_name as table_name, column_name, privilege_type
       from information_schema.column_privileges
      where grantee in ('authenticated', 'anon', 'PUBLIC') and privilege_type in ('INSERT', 'UPDATE')
        and table_schema = 'public' and column_name ~ '(^|_)(lat|lng|lon|latitude|longitude|position|location|geo|accuracy_m|fix_at|seen_at)(_|$)'`,
  );
  r.check("no table lets a signed-in user (or anon) write a coordinate column directly", writable.length === 0, writable);
  await r.denies("a customer cannot create a tanker row (the only table holding live positions)", () =>
    t.as(C1.id, "insert into tankers (driver_id, plate, service_type, capacity_gal) values ($1, $2, 'DW', 3000)", [C1.id, w.plate("PX")]), "row-level security");
  await r.denies("a customer cannot write order_locations directly", () => t.as(C1.id, "insert into order_locations (order_id, lat, lng) values (gen_random_uuid(), 1, 1)"), "permission denied");
  r.skip("customer screens never send their position (source check)", "covered by npm run test:unit (tests/unit/privacy.test.ts)");

  // ---- 2. driver location visible only to the customer of the active order
  const o = await placeOrder(t, C1.id, "DW", 800);
  r.check("open request: the customer cannot see any driver's location yet", !(await sees(t, C1.id, D1.id)) && !(await sees(t, C1.id, D2.id)));
  await t.as(D1.id, "select * from accept_order($1)", [o.id]);
  await ping(23.62);
  r.check("accepted: the order's customer sees the driver's location", await sees(t, C1.id, D1.id));
  r.check("accepted: another customer does not", !(await sees(t, C2.id, D1.id)));
  r.check("accepted: another driver does not", !(await sees(t, D2.id, D1.id)));
  r.check("accepted: anon does not", !(await sees(t, null, D1.id)));
  await t.as(D1.id, "select * from mark_arrived($1)", [o.id]);
  r.check("arrived: the order's customer still sees it", await sees(t, C1.id, D1.id));

  let realtimeClients: { c1: SupabaseClient; c2: SupabaseClient } | null = null;
  if (t.apiClientFor) {
    realtimeClients = { c1: await t.apiClientFor(C1.email, C1.password), c2: await t.apiClientFor(C2.email, C2.password) };
    const [mine, other] = await Promise.all([
      realtimeEvents(realtimeClients.c1, D1.id, () => ping(23.63)),
      realtimeEvents(realtimeClients.c2, D1.id, async () => undefined),
    ]);
    r.check("Realtime: the active order's customer receives the driver's location updates", typeof mine === "number" && mine >= 1, mine);
    r.check("Realtime: another customer subscribed to the same driver receives nothing", other === 0, other);
  } else {
    r.skip("Realtime: only the active order's customer receives location updates", "PGlite has no Realtime server; covered by the Supabase run");
  }

  await t.as(D1.id, "select * from mark_delivered($1)", [o.id]);
  r.check("delivered: the customer can no longer see the driver's location", !(await sees(t, C1.id, D1.id)));
  if (realtimeClients) {
    const after = await realtimeEvents(realtimeClients.c1, D1.id, () => ping(23.64));
    r.check("Realtime: after delivery, the customer receives no further location updates", after === 0, after);
  } else {
    r.skip("Realtime: no updates after delivery", "covered by the Supabase run");
  }

  // Cancelled: a request cancelled before acceptance never exposes a driver; an accepted
  // order that ends up cancelled (only possible by an operator today) stops exposing it.
  const c = await placeOrder(t, C2.id, "DW", 800);
  await t.as(C2.id, "select * from cancel_order($1)", [c.id]);
  r.check("cancelled request: the customer sees no driver location", !(await sees(t, C2.id, D1.id)));
  const o2 = await placeOrder(t, C2.id, "DW", 800);
  await t.as(D1.id, "select * from accept_order($1)", [o2.id]);
  r.check("accepted (second order): its customer sees the driver", await sees(t, C2.id, D1.id));
  await t.admin("update orders set status = 'cancelled', cancelled_at = now() where id = $1", [o2.id]);
  r.check("accepted order cancelled (operator action): the customer can no longer see the driver", !(await sees(t, C2.id, D1.id)));
  r.check("… and the previous customer still can't either", !(await sees(t, C1.id, D1.id)));

  if (realtimeClients) {
    await realtimeClients.c1.auth.signOut();
    await realtimeClients.c2.auth.signOut();
    realtimeClients.c1.realtime.disconnect();
    realtimeClients.c2.realtime.disconnect();
  }
}
