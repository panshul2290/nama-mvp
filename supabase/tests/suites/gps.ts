// GPS freshness: fixes are stored with a timestamp; a fix older than 60 s is
// reported as stale by the API the tracking screen uses.
import type { Reporter, Target } from "../lib/harness";
import { makeWorld, placeOrder, setOnline } from "../lib/world";

export async function gpsSuite(t: Target, r: Reporter) {
  r.start("GPS location freshness");
  const w = await makeWorld(t, "gps");
  const { C1, C2, D1 } = w;
  await setOnline(t, D1.id, true);
  const o = await placeOrder(t, C1.id, "DW", 1000);
  await t.as(D1.id, "select * from accept_order($1)", [o.id]);

  const view = (uid: string) =>
    t.as<{ last_seen_at: string | null; age: number | null; stale: boolean }>(
      uid,
      "select t.last_seen_at, location_age_s(t) as age, location_stale(t) as stale from tankers t where t.driver_id = $1",
      [D1.id],
    );

  const [before] = await view(C1.id);
  r.check("before any fix: no timestamp and reported stale", before?.last_seen_at === null && before.stale === true, before);

  await t.as(D1.id, "select report_location(23.595, 58.195)");
  const [fresh] = await view(C1.id);
  const [{ skew }] = await t.admin<{ skew: number }>("select abs(extract(epoch from (now() - last_seen_at)))::float as skew from tankers where driver_id = $1", [D1.id]);
  r.check("report_location stores the fix with a server timestamp (within 5 s of now)", fresh?.last_seen_at !== null && skew < 5, { fresh, skew });
  r.check("a fresh fix is not stale", fresh?.stale === false && (fresh.age ?? 99) <= 5, fresh);

  for (const [secs, want] of [
    [59, false],
    [61, true],
    [600, true],
  ] as const) {
    await t.admin("update tankers set last_seen_at = now() - make_interval(secs => $2) where driver_id = $1", [D1.id, secs]);
    const [v] = await view(C1.id);
    r.check(`fix ${secs} s old → stale = ${want}`, v?.stale === want && v.age !== null && Math.abs(v.age - secs) <= 2, v);
  }
  const [own] = await view(D1.id);
  r.check("the driver sees the same staleness on their own tanker", own?.stale === true, own);
  r.check("another customer gets no row (RLS), so no location or freshness leaks", (await view(C2.id)).length === 0);
  await r.denies("anon cannot call location_stale()", () => t.as(null, "select location_stale(t) from tankers t limit 1"), "permission denied");

  await t.as(D1.id, "select report_location(23.596, 58.196)");
  const [again] = await view(C1.id);
  r.check("a new fix clears the stale flag", again?.stale === false, again);

  // The tracking screen's initial fetch goes through PostgREST (supabase-js).
  if (t.apiClientFor) {
    await t.admin("update tankers set last_seen_at = now() - interval '61 seconds' where driver_id = $1", [D1.id]);
    const api = await t.apiClientFor(C1.email, C1.password);
    const { data, error } = await api.from("tankers").select("last_lat, last_lng, last_seen_at, location_age_s, location_stale").eq("driver_id", D1.id).maybeSingle();
    r.check("REST API (as the customer): tankers?select=…,location_stale returns stale = true for a 61 s old fix", !error && data?.location_stale === true, error?.message ?? data);
    const other = await t.apiClientFor(C2.email, C2.password);
    const { data: none } = await other.from("tankers").select("location_stale").eq("driver_id", D1.id);
    r.check("REST API (as another customer): no row returned", Array.isArray(none) && none.length === 0, none);
    await api.auth.signOut();
    await other.auth.signOut();
  } else {
    r.skip("REST API returns location_stale", "PGlite has no PostgREST; covered by the Supabase run");
  }
}
