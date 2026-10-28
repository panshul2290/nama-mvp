// Tankers and driver assignments (0007): tankers.id is the key, drivers link
// through tanker_assignments, and GPS / permits / blocks stay with the tanker.
import type { Reporter, Target } from "../lib/harness";
import { giveTanker, makeWorld, placeOrder, plateFor, setOnline, deliver } from "../lib/world";

export async function assignmentsSuite(t: Target, r: Reporter) {
  r.start("ASSIGN tankers and driver assignments");
  const w = await makeWorld(t, "asgn");
  const { C1, D1, D2 } = w;

  // ---- one active assignment per driver and per tanker
  await r.denies("a driver with a tanker can't register a second one (already_assigned)", () =>
    t.as(D1.id, "select * from driver_register_tanker($1, 'DW', 3000)", [w.plate("X1")]), "already_assigned");
  await r.denies("the database refuses a second active assignment for a driver (unique index)", () =>
    t.admin("insert into tanker_assignments (driver_id, tanker_id) values ($1, $2)", [D1.id, w.tk.D2]), "tanker_assignments_one_active_per_driver");
  const D4 = await t.createUser("asgn-d4", { role: "driver", full_name: "Test Driver Four" });
  await r.denies("the database refuses a second active assignment for a tanker (unique index)", () =>
    t.admin("insert into tanker_assignments (driver_id, tanker_id) values ($1, $2)", [D4.id, w.tk.D1]), "tanker_assignments_one_active_per_tanker");
  await r.denies("registering a plate that already exists → plate_taken", () =>
    t.as(D4.id, "select * from driver_register_tanker($1, 'DW', 3000)", [w.plate("D1")]), "plate_taken");

  // ---- a driver without an active assignment can do nothing tanker-related
  for (const [what, sql] of [
    ["go online", "select * from driver_set_online(true)"],
    ["see open requests", "select * from open_requests_near(23.6, 58.2)"],
    ["report a location", "select report_location(23.6, 58.2, 8, now())"],
  ] as const) {
    await r.denies(`a driver without a tanker can't ${what} (no_tanker)`, () => t.as(D4.id, sql), "no_tanker");
  }
  const anyOrder = await placeOrder(t, C1.id, "DW", 500);
  await r.denies("a driver without a tanker can't accept (no_tanker)", () => t.as(D4.id, "select * from accept_order($1)", [anyOrder.id]), "no_tanker");
  r.check("a driver without a tanker sees no tanker rows", (await t.as(D4.id, "select id from tankers")).length === 0);

  // ---- accepting records the tanker on the order; one active job per tanker
  await setOnline(t, D1.id, true);
  const [acc] = await t.as<{ tanker_id: string; driver_id: string }>(D1.id, "select tanker_id, driver_id from accept_order($1)", [anyOrder.id]);
  r.check("accept_order records both driver and tanker on the order", acc.tanker_id === w.tk.D1 && acc.driver_id === D1.id, acc);
  const second = await placeOrder(t, C1.id, "DW", 500);
  await r.denies("the database refuses a second active job for the same tanker (unique index)", () =>
    t.admin("update orders set status = 'accepted', tanker_id = $1, driver_id = $2 where id = $3", [w.tk.D1, D2.id, second.id]), "orders_one_active_job_per_tanker");

  // ---- GPS stays with the tanker across reassignment
  await t.as(D1.id, "select report_location(23.611, 58.211, 7, now())");
  await t.as(D1.id, "select * from mark_arrived($1)", [anyOrder.id]);
  await deliver(t, D1.id, anyOrder.id);
  // Reassign tanker D1 → D4 (as the operator override would; done directly here as a fixture).
  await t.admin("update tanker_assignments set unassigned_at = now() where tanker_id = $1 and unassigned_at is null", [w.tk.D1]);
  await t.admin("insert into tanker_assignments (driver_id, tanker_id) values ($1, $2)", [D4.id, w.tk.D1]);
  const [seen] = await t.as<{ id: string; last_lat: number; last_accuracy_m: number }>(D4.id, "select id, last_lat, last_accuracy_m from tankers");
  r.check("after reassignment the new driver sees the same tanker with its last GPS fix", seen?.id === w.tk.D1 && seen.last_lat === 23.611 && seen.last_accuracy_m === 7, seen);
  r.check("the previous driver no longer sees the tanker", (await t.as(D1.id, "select id from tankers where id = $1", [w.tk.D1])).length === 0);
  await r.denies("the previous driver can no longer report locations for it (no_tanker)", () => t.as(D1.id, "select report_location(23.6, 58.2, 8, now())"), "no_tanker");
  const [online] = await t.as<{ is_online: boolean }>(D4.id, "select is_online from driver_set_online(true)");
  r.check("the tanker's permit carries over: the new driver can go online", online?.is_online === true);
  await t.as(D4.id, "select report_location(23.622, 58.222, 9, now())");
  const [after] = await t.admin<{ last_lat: number }>("select last_lat from tankers where id = $1", [w.tk.D1]);
  r.check("the new driver's fixes update the same tanker row", after.last_lat === 23.622, after);
  const [hist] = await t.admin<{ n: number }>("select count(*)::int as n from tanker_assignments where tanker_id = $1", [w.tk.D1]);
  r.check("assignment history is kept (old row closed, new row active)", hist.n === 2, hist);

  // ---- a tanker registered without a permit can't go online
  const D5 = await t.createUser("asgn-d5", { role: "driver", full_name: "Test Driver Five" });
  await giveTanker(t, D5.id, plateFor(t, "ASGNNP"), "DW", 3000, { permit: false });
  await r.denies("a new tanker without a permit can't go online (permit_invalid)", () => setOnline(t, D5.id, true), "permit_invalid");
}
