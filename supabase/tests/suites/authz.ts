// Authorization matrix: role × table/RPC × action, allowed and denied.
// Roles: anon, customer (C1), other customer (C2), driver (D1, assigned to C1's
// accepted order), other driver (D2).
import type { Reporter, Target, Uid } from "../lib/harness";
import { makeWorld, placeOrder, setOnline, deliver } from "../lib/world";

export async function authzSuite(t: Target, r: Reporter) {
  r.start("AUTHZ authorization matrix");
  const w = await makeWorld(t, "authz");
  const { C1, C2, D1, D2 } = w;
  await setOnline(t, D1.id, true);
  await setOnline(t, D2.id, true);

  // State: C1 has an open request (oReq) and an order accepted by D1 (oAcc); C2 has oC2.
  const oReq = await placeOrder(t, C1.id, "DW", 1000);
  const oAcc = await placeOrder(t, C1.id, "DW", 1000);
  const oC2 = await placeOrder(t, C2.id, "DW", 1000);
  await t.as(D1.id, "select * from accept_order($1)", [oAcc.id]);

  const rows = (uid: Uid, sql: string, p: unknown[] = []) => t.as(uid, sql, p);
  const none = (x: unknown[]) => x.length === 0;
  const one = (x: unknown[]) => x.length === 1;
  const ROLES: [string, Uid][] = [
    ["anon", null],
    ["customer", C1.id],
    ["other customer", C2.id],
    ["driver", D1.id],
    ["other driver", D2.id],
  ];

  // ---------------------------------------------------------------- anon
  for (const table of ["profiles", "tankers", "orders", "order_locations"]) {
    await r.denies(`anon cannot SELECT ${table}`, () => rows(null, `select * from ${table} limit 1`), "permission denied");
  }
  await r.denies("anon cannot INSERT orders", () => rows(null, "insert into orders (customer_id, service_type, gallons, area, water_charge, delivery_fee, vat, total, driver_earnings) values (gen_random_uuid(),'DW',1,'x',0,0,0,0,0)"), "permission denied");
  for (const [fn, args] of [
    ["place_order", "'DW', 100, 23.6, 58.2, 'x'"],
    ["cancel_order", `'${oReq.id}'`],
    ["open_requests_near", "23.6, 58.2"],
    ["accept_order", `'${oReq.id}'`],
    ["report_location", "23.6, 58.2, 8, now()"],
    ["mark_arrived", `'${oAcc.id}'`],
    ["mark_delivered", `'${oAcc.id}'`],
    ["price_quote", "'DW', 100"],
  ]) {
    await r.denies(`anon cannot call ${fn}()`, () => rows(null, `select * from ${fn}(${args})`), "permission denied");
  }

  // ---------------------------------------------------------------- profiles
  await r.allows("customer reads own profile", () => rows(C1.id, "select id from profiles where id = $1", [C1.id]), one);
  await r.allows("customer cannot read other customer's profile (0 rows)", () => rows(C1.id, "select id from profiles where id = $1", [C2.id]), none);
  await r.allows("customer cannot read the driver's profile (0 rows; name comes from the order snapshot)", () => rows(C1.id, "select id from profiles where id = $1", [D1.id]), none);
  await r.allows("driver reads the customer on their active job", () => rows(D1.id, "select full_name from profiles where id = $1", [C1.id]), one);
  await r.allows("other driver cannot read that customer (0 rows)", () => rows(D2.id, "select id from profiles where id = $1", [C1.id]), none);
  await r.allows("customer updates own full_name", () => rows(C1.id, "update profiles set full_name = 'Test Customer One' where id = $1 returning id", [C1.id]), one);
  await r.allows("customer cannot update another profile (0 rows)", () => rows(C1.id, "update profiles set full_name = 'x' where id = $1 returning id", [C2.id]), none);
  for (const [role, uid] of ROLES.slice(1)) {
    await r.denies(`${role} cannot change own role`, () => rows(uid, "update profiles set role = 'driver' where id = $1", [uid]), "permission denied");
    await r.denies(`${role} cannot INSERT a profile`, () => rows(uid, "insert into profiles (id, role) values (gen_random_uuid(), 'customer')"), "permission denied");
  }

  // ---------------------------------------------------------------- tankers (by tankers.id; drivers reach theirs via tanker_assignments)
  const { tk } = w;
  await r.allows("customer reads the tanker on their active order (with location columns)", () => rows(C1.id, "select plate, last_lat, last_lng, last_seen_at from tankers where id = $1", [tk.D1]), one);
  await r.allows("customer cannot read a tanker not on their active order (0 rows)", () => rows(C1.id, "select plate from tankers where id = $1", [tk.D2]), none);
  await r.allows("other customer cannot read the assigned tanker's location (0 rows)", () => rows(C2.id, "select last_lat, last_lng from tankers where id = $1", [tk.D1]), none);
  await r.allows("driver reads the tanker assigned to them", () => rows(D1.id, "select plate from tankers where id = $1", [tk.D1]), one);
  await r.allows("driver cannot read another driver's tanker (0 rows)", () => rows(D1.id, "select plate from tankers where id = $1", [tk.D2]), none);
  await r.allows("driver reads own active assignment", () => rows(D1.id, "select tanker_id from tanker_assignments where unassigned_at is null"), (x) => x.length === 1 && x[0].tanker_id === tk.D1);
  await r.allows("driver sees only their own assignment rows", () => rows(D1.id, "select driver_id from tanker_assignments"), (x) => x.length > 0 && x.every((a) => a.driver_id === D1.id));
  await r.allows("driver goes online through driver_set_online()", () => rows(D2.id, "select is_online from driver_set_online(true)"), (x) => x[0]?.is_online === true);
  for (const col of ["is_online = false", "last_lat = 1", "last_lng = 1", "last_seen_at = now()", "blocked = false", "plate = 'X'"]) {
    await r.denies(`driver cannot UPDATE tankers SET ${col} directly`, () => rows(D1.id, `update tankers set ${col} where id = $1`, [tk.D1]), "permission denied");
  }
  await r.denies("driver cannot INSERT a tanker directly", () => rows(D1.id, "insert into tankers (plate, service_type, capacity_gal) values ($1, 'DW', 3000)", [w.plate("DX")]), "permission denied");
  await r.denies("driver cannot write tanker_assignments directly", () => rows(D1.id, "insert into tanker_assignments (driver_id, tanker_id) values ($1, $2)", [D1.id, tk.D2]), "permission denied");
  await r.denies("customer cannot register a tanker (driver_register_tanker → not_a_driver)", () => rows(C1.id, "select * from driver_register_tanker($1, 'DW', 3000)", [w.plate("CX")]), "not_a_driver");
  await r.denies("customer cannot INSERT a tanker directly", () => rows(C1.id, "insert into tankers (plate, service_type, capacity_gal) values ($1, 'DW', 3000)", [w.plate("CY")]), "permission denied");
  await r.denies("customer cannot go online (driver_set_online → not_a_driver)", () => rows(C1.id, "select * from driver_set_online(true)"), "not_a_driver");

  // ---------------------------------------------------------------- orders
  await r.allows("customer reads own orders", () => rows(C1.id, "select id from orders where id = any($1::uuid[])", [[oReq.id, oAcc.id]]), (x) => x.length === 2);
  await r.allows("customer cannot read another customer's order (0 rows)", () => rows(C1.id, "select id from orders where id = $1", [oC2.id]), none);
  await r.allows("other customer cannot read C1's orders (0 rows)", () => rows(C2.id, "select id from orders where id = any($1::uuid[])", [[oReq.id, oAcc.id]]), none);
  await r.allows("driver sees an open request row (no address columns exist on orders)", () => rows(D2.id, "select * from orders where id = $1", [oReq.id]), (x) => one(x) && !("lat" in x[0]) && !("address" in x[0]));
  await r.allows("driver sees own accepted job", () => rows(D1.id, "select id from orders where id = $1", [oAcc.id]), one);
  await r.allows("other driver cannot see someone else's accepted job (0 rows)", () => rows(D2.id, "select id from orders where id = $1", [oAcc.id]), none);
  await r.allows("customers see no open requests of others (0 rows)", () => rows(C2.id, "select id from orders where id = $1", [oReq.id]), none);

  // Nobody can set price, order_no or status directly.
  const PROTECTED = ["total = 0", "water_charge = 0", "delivery_fee = 0", "vat = 0", "driver_earnings = 99", "order_no = 1", "status = 'delivered'", "driver_id = null"];
  for (const [role, uid] of ROLES) {
    for (const set of PROTECTED) {
      await r.denies(`${role} cannot UPDATE orders SET ${set}`, () => rows(uid, `update orders set ${set} where id = $1`, [oAcc.id]), "permission denied");
    }
    if (uid) {
      await r.denies(`${role} cannot INSERT an order with its own price/status/number`, () =>
        rows(uid, "insert into orders (customer_id, service_type, gallons, area, water_charge, delivery_fee, vat, total, driver_earnings, status, order_no) values ($1,'DW',1,'x',0,0,0,0,0,'delivered',1)", [uid]), "permission denied");
      await r.denies(`${role} cannot DELETE orders`, () => rows(uid, "delete from orders where id = $1", [oReq.id]), "permission denied");
    }
  }

  // ---------------------------------------------------------------- order_locations (exact address)
  await r.allows("customer reads own exact location", () => rows(C1.id, "select lat, lng, address from order_locations where order_id = $1", [oReq.id]), one);
  await r.allows("other customer cannot read it (0 rows)", () => rows(C2.id, "select lat from order_locations where order_id = $1", [oReq.id]), none);
  await r.allows("driver cannot see the exact address before acceptance (0 rows)", () => rows(D2.id, "select lat, lng, address from order_locations where order_id = $1", [oReq.id]), none);
  await r.allows("driver cannot see it via the request they could accept either (D1, 0 rows)", () => rows(D1.id, "select address from order_locations where order_id = $1", [oReq.id]), none);
  await r.allows("assigned driver sees the exact address after acceptance", () => rows(D1.id, "select lat, lng, address from order_locations where order_id = $1", [oAcc.id]), one);
  await r.allows("other driver cannot see the accepted job's address (0 rows)", () => rows(D2.id, "select address from order_locations where order_id = $1", [oAcc.id]), none);
  for (const [role, uid] of ROLES) {
    await r.denies(`${role} cannot UPDATE order_locations`, () => rows(uid, "update order_locations set address = 'x' where order_id = $1", [oReq.id]), "permission denied");
  }

  // ---------------------------------------------------------------- RPCs
  const open = await r.allows("driver: open_requests_near returns the request without coordinates or address", () => rows(D2.id, "select * from open_requests_near(23.6, 58.2)"), (x) => {
    const hit = x.find((o) => o.id === oReq.id);
    return !!hit && "distance_km" in hit && "area" in hit && !("lat" in hit) && !("lng" in hit) && !("address" in hit);
  });
  void open;
  await r.denies("customer: open_requests_near → not_a_driver", () => rows(C1.id, "select * from open_requests_near(23.6, 58.2)"), "not_a_driver");
  await r.denies("driver: place_order → not_a_customer", () => rows(D1.id, "select * from place_order('DW', 100, 23.6, 58.2, 'x')"), "not_a_customer");
  await r.denies("customer: accept_order → not_a_driver", () => rows(C1.id, "select * from accept_order($1)", [oReq.id]), "not_a_driver");
  await r.denies("busy driver: accept_order → driver_busy", () => rows(D1.id, "select * from accept_order($1)", [oReq.id]), "driver_busy");
  await r.denies("other driver: accept an already accepted order → already_taken", () => rows(D2.id, "select * from accept_order($1)", [oAcc.id]), "already_taken");
  await r.denies("other customer: cancel C1's request → not_found", () => rows(C2.id, "select * from cancel_order($1)", [oReq.id]), "not_found");
  await r.denies("driver: cancel_order → not_found", () => rows(D2.id, "select * from cancel_order($1)", [oReq.id]), "not_found");
  await r.denies("customer: cancel an accepted order → cannot_cancel", () => rows(C1.id, "select * from cancel_order($1)", [oAcc.id]), "cannot_cancel");
  await r.denies("customer: report_location → not_a_driver", () => rows(C1.id, "select report_location(23.6, 58.2, 8, now())"), "not_a_driver");
  await r.denies("customer: mark_arrived → invalid_transition", () => rows(C1.id, "select * from mark_arrived($1)", [oAcc.id]), "invalid_transition");
  await r.denies("other driver: mark_arrived on someone else's job → invalid_transition", () => rows(D2.id, "select * from mark_arrived($1)", [oAcc.id]), "invalid_transition");
  await r.denies("assigned driver: mark_delivered before arrived → invalid_transition", () => rows(D1.id, "select * from mark_delivered($1)", [oAcc.id]), "invalid_transition");
  await r.allows("assigned driver: report_location", () => rows(D1.id, "select report_location(23.601, 58.201, 8, now())"));
  await r.allows("assigned driver: mark_arrived", () => rows(D1.id, "select status from mark_arrived($1)", [oAcc.id]), (x) => x[0]?.status === "arrived");
  await r.denies("other driver: mark_delivered → invalid_transition", () => rows(D2.id, "select * from mark_delivered($1)", [oAcc.id]), "invalid_transition");
  await r.denies("assigned driver: mark_delivered without proof of delivery → pod_required", () => rows(D1.id, "select * from mark_delivered($1)", [oAcc.id]), "pod_required");
  await r.allows("assigned driver: complete with proof of delivery (submit_pod)", () => deliver(t, D1.id, oAcc.id), (x) => x?.status === "delivered");
  await r.allows("customer: cancel own open request", () => rows(C1.id, "select status from cancel_order($1)", [oReq.id]), (x) => x[0]?.status === "cancelled");
  await r.allows("signed-in user: price_quote", () => rows(C2.id, "select total from price_quote('DW', 1000)"), one);

  // After the job: access is withdrawn.
  await r.allows("after delivery, customer can no longer read the tanker (0 rows)", () => rows(C1.id, "select plate from tankers where id = $1", [w.tk.D1]), none);
  await r.allows("after delivery, driver can no longer read the exact address (0 rows)", () => rows(D1.id, "select address from order_locations where order_id = $1", [oAcc.id]), none);
  await r.allows("after delivery, driver can no longer read the customer's profile (0 rows)", () => rows(D1.id, "select id from profiles where id = $1", [C1.id]), none);
}
