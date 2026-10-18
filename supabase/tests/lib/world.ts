import type { Target } from "./harness";

export type Person = { id: string; email: string; password: string };
export type World = {
  C1: Person; // customer
  C2: Person; // other customer
  D1: Person; // driver (DW, 3,000 gal)
  D2: Person; // other driver (DW, 5,000 gal)
  D3: Person; // driver of another service (WW)
  plate: (label: string) => string;
};

/** Plates are unique per run and visibly test-prefixed. */
export const plateFor = (t: Target, label: string) => `TST${t.runId.slice(-5).toUpperCase()}${label}`.slice(0, 20);

export async function makeWorld(t: Target, prefix: string): Promise<World> {
  const C1 = await t.createUser(`${prefix}-c1`, { role: "customer", full_name: "Test Customer One" });
  const C2 = await t.createUser(`${prefix}-c2`, { role: "customer", full_name: "Test Customer Two" });
  const D1 = await t.createUser(`${prefix}-d1`, { role: "driver", full_name: "Test Driver One" });
  const D2 = await t.createUser(`${prefix}-d2`, { role: "driver", full_name: "Test Driver Two" });
  const D3 = await t.createUser(`${prefix}-d3`, { role: "driver", full_name: "Test Driver Three" });
  const plate = (label: string) => plateFor(t, `${prefix.slice(0, 3).toUpperCase()}${label}`);
  for (const [d, label, type, cap] of [
    [D1, "D1", "DW", 3000],
    [D2, "D2", "DW", 5000],
    [D3, "D3", "WW", 5000],
  ] as const) {
    await t.as(d.id, "insert into tankers (driver_id, plate, service_type, capacity_gal) values ($1, $2, $3, $4)", [d.id, plate(label), type, cap]);
  }
  return { C1, C2, D1, D2, D3, plate };
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

export const setOnline = (t: Target, driver: string, online: boolean) =>
  t.as(driver, "update tankers set is_online = $2 where driver_id = $1", [driver, online]);
