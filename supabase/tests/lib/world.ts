import type { Target } from "./harness";

export type Person = { id: string; email: string; password: string };
export type World = {
  C1: Person; // customer
  C2: Person; // other customer
  D1: Person; // driver (DW, 3,000 gal)
  D2: Person; // other driver (DW, 5,000 gal)
  D3: Person; // driver of another service (WW)
  /** Tanker ids, by driver label. */
  tk: { D1: string; D2: string; D3: string };
  plate: (label: string) => string;
};

/** Plates are unique per run and visibly test-prefixed ("TST…"); cleanup relies on that prefix. */
export const plateFor = (t: Target, label: string) => `TST${t.runId.slice(-5).toUpperCase()}${label}`.slice(0, 20);

/**
 * Register a tanker for a driver (driver_register_tanker) and, unless told not
 * to, give it an approved permit valid for a year — a fixture, written directly
 * (it isn't a staff action under test).
 */
export async function giveTanker(t: Target, driver: string, plate: string, type: "DW" | "WW" | "TE", cap: number, opts: { permit?: boolean } = {}) {
  const [tk] = await t.as<{ id: string }>(driver, "select id from driver_register_tanker($1, $2, $3)", [plate, type, cap]);
  if (opts.permit !== false) {
    await t.admin(
      "insert into permits (tanker_id, permit_no, type, issued_at, expires_at, status, reviewed_at) values ($1, $2, $3, now() - interval '1 day', now() + interval '365 days', 'approved', now())",
      [tk.id, `P-${plate}`, type],
    );
  }
  return tk.id;
}

export async function makeWorld(t: Target, prefix: string): Promise<World> {
  const C1 = await t.createUser(`${prefix}-c1`, { role: "customer", full_name: "Test Customer One" });
  const C2 = await t.createUser(`${prefix}-c2`, { role: "customer", full_name: "Test Customer Two" });
  const D1 = await t.createUser(`${prefix}-d1`, { role: "driver", full_name: "Test Driver One" });
  const D2 = await t.createUser(`${prefix}-d2`, { role: "driver", full_name: "Test Driver Two" });
  const D3 = await t.createUser(`${prefix}-d3`, { role: "driver", full_name: "Test Driver Three" });
  const plate = (label: string) => plateFor(t, `${prefix.slice(0, 4).toUpperCase()}${label}`);
  const tk = {
    D1: await giveTanker(t, D1.id, plate("D1"), "DW", 3000),
    D2: await giveTanker(t, D2.id, plate("D2"), "DW", 5000),
    D3: await giveTanker(t, D3.id, plate("D3"), "WW", 5000),
  };
  return { C1, C2, D1, D2, D3, tk, plate };
}

export const TEST_AREA = "TEST automated check";

export async function placeOrder(t: Target, customer: string, type: "DW" | "WW" | "TE", gallons: number) {
  const [o] = await t.as<{ id: string; order_no: string; total: string; status: string; driver_earnings: string }>(
    customer,
    "select * from place_order($1, $2, 23.6, 58.2, $3, 'TEST address — not a real location')",
    [type, gallons, TEST_AREA],
  );
  return o;
}

export const setOnline = (t: Target, driver: string, online: boolean) => t.as(driver, "select driver_set_online($1)", [online]);

/** Complete an arrived DW/TE job with a proof of delivery (photo + signature, full volume). */
export async function deliver(t: Target, driver: string, orderId: string) {
  const photo = await t.evidencePhoto(driver);
  const [o] = await t.as<{ status: string }>(driver, "select status from submit_pod($1, 20000, $2, 'test-hash', '<svg/>')", [orderId, photo]);
  return o;
}
