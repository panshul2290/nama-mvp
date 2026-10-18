// Runs the migrations against PGlite (Postgres in WASM) with a minimal stub of
// the Supabase environment, then exercises RLS, the order lifecycle and order numbers.
//   npm run test:db
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { quote as jsQuote } from "../../lib/pricing";

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    raw_user_meta_data jsonb not null default '{}'
  );
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated;
  -- Supabase grants these by default; the migration must lock them down itself.
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  create publication supabase_realtime;
`;

const migration = (file: string) => readFileSync(join(__dirname, "../migrations", file), "utf8");

const db = new PGlite();
let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passes++;
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, detail ?? "");
  }
}

async function as<T = Record<string, unknown>>(
  uid: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await db.exec("reset role");
  if (uid) {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid]);
    await db.exec("set role authenticated");
  } else {
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
    await db.exec("set role anon");
  }
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

async function expectError(name: string, uid: string | null, sql: string, params: unknown[], match: string) {
  try {
    await as(uid, sql, params);
    check(name, false, "no error raised");
  } catch (e) {
    const msg = (e as Error).message;
    check(name, msg.includes(match), msg);
  }
}

async function createUser(email: string, meta: Record<string, string>) {
  const { rows } = await db.query<{ id: string }>(
    "insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id",
    [email, JSON.stringify(meta)],
  );
  return rows[0].id;
}

async function main() {
  await db.exec(SUPABASE_STUB);
  await db.exec(migration("0001_init.sql"));
  console.log("0001 applied");

  // Orders that exist before 0002, inserted out of created_at order, to check the backfill.
  const legacy = await createUser("legacy@test", { role: "customer", full_name: "Legacy" });
  const legacyIds: string[] = [];
  for (const g of [100, 200, 300]) {
    const [o] = await as<{ id: string }>(legacy, "select * from place_order('DW', $1, 23.6, 58.2, 'Old Town')", [g]);
    legacyIds.push(o.id);
  }
  // Creation times: 2nd order oldest, then 3rd, then 1st.
  const times = ["2026-01-03T10:00:00Z", "2026-01-01T10:00:00Z", "2026-01-02T10:00:00Z"];
  for (let i = 0; i < 3; i++) await db.query("update orders set created_at = $1 where id = $2", [times[i], legacyIds[i]]);

  await db.exec(migration("0002_order_no.sql"));
  console.log("0002 applied");

  console.log("order number backfill");
  const back = (await db.query<{ id: string; order_no: string }>("select id, order_no from orders order by order_no")).rows;
  check(
    "existing orders backfilled from 48200 in created_at order",
    JSON.stringify(back.map((r) => [r.id, Number(r.order_no)])) ===
      JSON.stringify([
        [legacyIds[1], 48200],
        [legacyIds[2], 48201],
        [legacyIds[0], 48202],
      ]),
    back,
  );
  const col = (
    await db.query<{ is_nullable: string }>(
      "select is_nullable from information_schema.columns where table_name = 'orders' and column_name = 'order_no'",
    )
  ).rows[0];
  check("order_no is NOT NULL after the backfill", col?.is_nullable === "NO", col);
  const uniq = await db.query("select 1 from pg_constraint where conname = 'orders_order_no_key' and contype = 'u'");
  check("order_no has a UNIQUE constraint", uniq.rows.length === 1);
  // Close the legacy requests so they don't show up in the lifecycle tests below.
  for (const id of legacyIds) await as(legacy, "select * from cancel_order($1)", [id]);

  console.log("pricing");
  const quote = async (t: string, g: number) =>
    (await db.query<Record<string, string>>("select * from price_quote($1, $2)", [t, g])).rows[0];
  const cases: [string, number, string, string, string, string, string][] = [
    //  type gal   water    fee      vat      total    earnings
    ["DW", 650, "0.650", "3.500", "0.208", "4.358", "2.975"],
    ["DW", 1000, "1.700", "3.500", "0.260", "5.460", "2.975"],
    ["WW", 3000, "3.000", "6.000", "0.450", "9.450", "5.100"],
    ["TE", 10000, "0.500", "8.000", "0.425", "8.925", "6.800"],
    ["TE", 3, "0.000", "8.000", "0.400", "8.400", "6.800"],
  ];
  for (const [t, g, w, f, v, tot, e] of cases) {
    const q = await quote(t, g);
    const got = [q.water_charge, q.delivery_fee, q.vat, q.total, q.driver_earnings].map(String);
    check(`${t} ${g} gal`, JSON.stringify(got) === JSON.stringify([w, f, v, tot, e]), got);
  }

  let mismatches = 0;
  for (const t of ["DW", "WW", "TE"] as const) {
    for (const g of [1, 2, 3, 9, 10, 11, 19, 20, 21, 99, 649, 650, 651, 652, 999, 1234, 3333, 5000, 9999, 10001, 19999]) {
      const q = await quote(t, g);
      const js = jsQuote(t, g);
      const sql = [q.water_charge, q.delivery_fee, q.vat, q.total, q.driver_earnings].map((v) => Math.round(Number(v) * 1000));
      if (JSON.stringify(sql) !== JSON.stringify([js.water, js.fee, js.vat, js.total, js.driverEarnings])) {
        mismatches++;
        console.log("    mismatch", t, g, sql, js);
      }
    }
  }
  check("lib/pricing.ts matches price_quote() on 63 volumes", mismatches === 0);

  const C = await createUser("c@test", { role: "customer", full_name: "Fatma" });
  const C2 = await createUser("c2@test", { role: "customer", full_name: "Other" });
  const D1 = await createUser("d1@test", { role: "driver", full_name: "Salim" });
  const D2 = await createUser("d2@test", { role: "driver", full_name: "Hamed" });
  const D3 = await createUser("d3@test", { role: "driver", full_name: "Waste Driver" });

  console.log("profiles and tankers");
  check("profile rows created by trigger",
    (await db.query("select * from profiles")).rows.length === 6); // 5 + the legacy customer
  await expectError("user cannot change own role", C, "update profiles set role = 'driver' where id = $1", [C], "permission denied");
  await expectError("customer cannot register a tanker", C,
    "insert into tankers (driver_id, plate, service_type, capacity_gal) values ($1, 'X 1', 'DW', 3000)", [C], "row-level security");
  for (const [d, plate, type, cap] of [[D1, "1234 AB", "DW", 3000], [D2, "5678 CD", "DW", 5000], [D3, "9 WW", "WW", 5000]] as const) {
    await as(d, "insert into tankers (driver_id, plate, service_type, capacity_gal) values ($1, $2, $3, $4)", [d, plate, type, cap]);
  }
  await expectError("driver cannot set own GPS directly", D1, "update tankers set last_lat = 1 where driver_id = $1", [D1], "permission denied");

  console.log("placing an order");
  await expectError("driver cannot place order", D1,
    "select * from place_order('DW', 1000, 23.6, 58.2, 'Al Khoud')", [], "not_a_customer");
  await expectError("anon cannot place order", null,
    "select * from place_order('DW', 1000, 23.6, 58.2, 'Al Khoud')", [], "permission denied");
  await expectError("customer cannot insert orders directly", C,
    "insert into orders (customer_id, service_type, gallons, area, water_charge, delivery_fee, vat, total, driver_earnings) values ($1,'DW',1,'x',0,0,0,0,0)", [C], "permission denied");
  const [o1] = await as<{ id: string; total: string; status: string }>(C,
    "select * from place_order('DW', 1000, 23.5880, 58.1680, 'Al Khoud', 'Villa 214, Way 3021')");
  check("order placed with server-side price", o1.total === "5.460" && o1.status === "requested", o1);
  check("customer sees own order", (await as(C, "select id from orders")).length === 1);
  check("customer sees own location", (await as(C, "select * from order_locations")).length === 1);
  check("other customer sees nothing", (await as(C2, "select id from orders")).length === 0
    && (await as(C2, "select * from order_locations")).length === 0);
  check("customer cannot see any tanker yet", (await as(C, "select * from tankers")).length === 0);

  console.log("open requests");
  check("offline driver gets no requests", (await as(D1, "select * from open_requests_near(23.6, 58.2)")).length === 0);
  for (const d of [D1, D2, D3]) await as(d, "update tankers set is_online = true where driver_id = $1", [d]);
  const reqs = await as<Record<string, unknown>>(D1, "select * from open_requests_near(23.6, 58.2)");
  check("matching driver sees request", reqs.length === 1 && reqs[0].area === "Al Khoud", reqs);
  check("request has distance + earnings, no coordinates",
    reqs[0] && "distance_km" in reqs[0] && reqs[0].driver_earnings === "2.975" && !("lat" in reqs[0]) && !("address" in reqs[0]), reqs[0]);
  check("wrong service type sees nothing", (await as(D3, "select * from open_requests_near(23.6, 58.2)")).length === 0);
  check("driver sees open order row via RLS", (await as(D1, "select id from orders")).length === 1);
  check("driver cannot read exact location before accepting", (await as(D1, "select * from order_locations")).length === 0);
  await expectError("driver cannot update orders directly", D1, "update orders set status = 'accepted'", [], "permission denied");

  const [small] = await as<{ id: string }>(C, "select * from place_order('DW', 4000, 23.59, 58.17, 'Al Khoud')");
  check("capacity filter: 3000-gal tanker skips 4000-gal job",
    !(await as<{ id: string }>(D1, "select id from open_requests_near(23.6, 58.2)")).some((r) => r.id === small.id)
    && (await as<{ id: string }>(D2, "select id from open_requests_near(23.6, 58.2)")).some((r) => r.id === small.id));
  await expectError("ineligible driver gets not_eligible", D1, "select * from accept_order($1)", [small.id], "not_eligible");

  console.log("accepting");
  const [acc] = await as<{ status: string; tanker_plate: string; driver_name: string }>(D1, "select * from accept_order($1)", [o1.id]);
  check("first driver wins", acc.status === "accepted" && acc.tanker_plate === "1234 AB" && acc.driver_name === "Salim", acc);
  await expectError("second driver gets already_taken", D2, "select * from accept_order($1)", [o1.id], "already_taken");
  check("loser can no longer see the order", !(await as<{ id: string }>(D2, "select id from orders")).some((r) => r.id === o1.id));
  check("winner now sees exact location", (await as(D1, "select * from order_locations where order_id = $1", [o1.id])).length === 1);
  check("winner sees customer profile", (await as(D1, "select full_name from profiles where id = $1", [C])).length === 1);
  check("customer sees only the assigned tanker",
    JSON.stringify((await as<{ plate: string }>(C, "select plate from tankers")).map((r) => r.plate)) === '["1234 AB"]');
  await expectError("customer cannot cancel accepted order", C, "select * from cancel_order($1)", [o1.id], "cannot_cancel");

  console.log("one active job per driver");
  const [o2] = await as<{ id: string }>(C, "select * from place_order('DW', 500, 23.6, 58.2, 'Bawshar')");
  await expectError("busy driver cannot accept second job", D1, "select * from accept_order($1)", [o2.id], "driver_busy");
  try {
    await db.query("update orders set driver_id = $1, status = 'accepted' where id = $2", [D1, o2.id]);
    check("partial unique index blocks second active job", false, "no error");
  } catch (e) {
    check("partial unique index blocks second active job", (e as Error).message.includes("orders_one_active_job_per_driver"), (e as Error).message);
  }
  await expectError("customer cannot accept", C, "select * from accept_order($1)", [o2.id], "not_a_driver");
  await expectError("other customer cannot cancel", C2, "select * from cancel_order($1)", [o2.id], "not_found");
  const [cx] = await as<{ status: string }>(C, "select * from cancel_order($1)", [o2.id]);
  check("customer cancels requested order", cx.status === "cancelled");
  await expectError("cannot accept cancelled order", D2, "select * from accept_order($1)", [o2.id], "already_taken");

  console.log("trip");
  await expectError("cannot deliver before arriving", D1, "select * from mark_delivered($1)", [o1.id], "invalid_transition");
  await expectError("other driver cannot mark arrived", D2, "select * from mark_arrived($1)", [o1.id], "invalid_transition");
  await as(D1, "select report_location(23.59, 58.17)");
  check("first GPS ping moves job to arriving",
    (await as<{ status: string }>(C, "select status from orders where id = $1", [o1.id]))[0].status === "arriving");
  check("customer sees tanker position",
    (await as<{ last_lat: number }>(C, "select last_lat from tankers"))[0]?.last_lat === 23.59);
  check("arrived", (await as<{ status: string }>(D1, "select * from mark_arrived($1)", [o1.id]))[0].status === "arrived");
  check("delivered", (await as<{ status: string }>(D1, "select * from mark_delivered($1)", [o1.id]))[0].status === "delivered");
  check("after delivery customer loses tanker access", (await as(C, "select * from tankers")).length === 0);
  check("after delivery driver loses exact location", (await as(D1, "select * from order_locations where order_id = $1", [o1.id])).length === 0);
  check("customer keeps driver name and plate on the order",
    (await as<{ tanker_plate: string }>(C, "select tanker_plate from orders where id = $1", [o1.id]))[0].tanker_plate === "1234 AB");
  check("driver is free for a new job",
    (await as<{ status: string }>(D2, "select * from accept_order($1)", [small.id]))[0].status === "accepted");

  console.log("order numbers");
  const nums: number[] = [];
  for (let i = 0; i < 25; i++) {
    nums.push(Number((await as<{ order_no: string }>(C, "select * from place_order('WW', 50, 23.6, 58.2, 'Qurum')"))[0].order_no));
  }
  check("25 orders in a row get distinct, increasing numbers", new Set(nums).size === 25 && nums.every((v, i) => i === 0 || v > nums[i - 1]), nums);
  check("new numbers continue after the backfill", nums[0] > 48202, nums[0]);
  const all = (await db.query<{ order_no: string }>("select order_no from orders")).rows.map((r) => r.order_no);
  check(`no two of the ${all.length} orders share a number`, new Set(all).size === all.length);

  // Even a privileged insert that supplies a number gets the next one from the sequence.
  const forced = (
    await db.query<{ order_no: string }>(
      "insert into orders (customer_id, service_type, gallons, area, water_charge, delivery_fee, vat, total, driver_earnings, order_no) values ($1,'DW',1,'x',0,0,0,0,0,$2) returning order_no",
      [C, nums[0]],
    )
  ).rows[0];
  check("a supplied number is ignored on insert (no duplicate possible)", Number(forced.order_no) === nums[24] + 1, forced);

  const target = small.id;
  await expectError("customer cannot change a number", C, "update orders set order_no = 1 where id = $1", [target], "permission denied");
  await expectError("driver cannot change a number", D2, "update orders set order_no = 1 where id = $1", [target], "permission denied");
  await expectError("customer cannot insert with a chosen number", C,
    "insert into orders (customer_id, service_type, gallons, area, water_charge, delivery_fee, vat, total, driver_earnings, order_no) values ($1,'DW',1,'x',0,0,0,0,0,1)", [C], "permission denied");
  await expectError("customer cannot advance the sequence", C, "select nextval('orders_order_no_seq')", [], "permission denied");
  await expectError("driver cannot reset the sequence", D1, "select setval('orders_order_no_seq', 1)", [], "permission denied");
  try {
    await db.query("update orders set order_no = order_no + 1000 where id = $1", [target]);
    check("number is frozen even for privileged updates", false, "no error");
  } catch (e) {
    check("number is frozen even for privileged updates", (e as Error).message.includes("order_no_immutable"), (e as Error).message);
  }

  console.log("RPCs return order_no");
  const [placed] = await as<{ order_no: string }>(C, "select * from place_order('DW', 900, 23.6, 58.2, 'Ruwi')");
  check("place_order returns order_no", Number(placed.order_no) > 0, placed);
  const openReq = await as<{ order_no: string }>(D1, "select * from open_requests_near(23.6, 58.2)");
  check("open_requests_near returns order_no", openReq.length > 0 && openReq.every((r) => Number(r.order_no) > 0), openReq);
  const [cancelled] = await as<{ order_no: string }>(C, "select * from cancel_order((select id from orders where order_no = $1))", [placed.order_no]);
  check("cancel_order returns the same order_no", cancelled.order_no === placed.order_no, cancelled);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
