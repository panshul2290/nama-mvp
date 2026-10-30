// Customer and driver app features (0030): identity documents, water-quality certificates,
// driver training (and the optional online rule), and the source of each GPS fix.
import type { Reporter, Target } from "../lib/harness";
import { deliver, makeWorld, placeOrder, setOnline } from "../lib/world";

type Row = Record<string, unknown>;

export async function mobile2Suite(t: Target, r: Reporter) {
  r.start("MOB2 identity documents, water certificates, driver training, GPS source (0030)");
  const one = async <T = Row>(uid: string | null, sql: string, params: unknown[] = []) => (await t.as<T>(uid, sql, params))[0];
  const w = await makeWorld(t, "mob2");
  const ST = await t.createUser("mob2-st", { role: "customer", full_name: "Test Mob2 Staff" });
  await t.admin("update profiles set role = 'nws_staff', staff_role = 'viewer' where id = $1", [ST.id]);

  // ---- E1 identity documents --------------------------------------------------------------------
  const front = `${w.C1.id}/${crypto.randomUUID()}.jpg`;
  const d1 = await one<Row>(w.C1.id, "select * from add_identity_document('id_front', $1)", [front]);
  r.check("a customer records their ID card photo (received, waiting for NWS)", d1?.file_path === front && d1.review_status === "received", d1);
  const front2 = `${w.C1.id}/${crypto.randomUUID()}.jpg`;
  await one(w.C1.id, "select * from add_identity_document('id_front', $1)", [front2]);
  const mine = await t.as<Row>(w.C1.id, "select kind, file_path from identity_documents");
  r.check("a new photo of the same kind replaces the old record", mine.length === 1 && mine[0].file_path === front2, mine);
  await one(w.C1.id, "select * from add_identity_document('selfie', $1)", [`${w.C1.id}/selfie.jpg`]);
  await r.denies("a path outside the person's own folder is refused", () => one(w.C1.id, "select * from add_identity_document('id_back', $1)", [`${w.C2.id}/x.jpg`]), "invalid_path");
  await r.denies("a path that climbs out of the folder is refused", () => one(w.C1.id, "select * from add_identity_document('id_back', $1)", [`${w.C1.id}/../x.jpg`]), "invalid_path");
  await r.denies("an unknown document kind is refused", () => one(w.C1.id, "select * from add_identity_document('passport_scan', $1)", [`${w.C1.id}/p.jpg`]), "invalid_kind");
  const other = await t.as<Row>(w.C2.id, "select * from identity_documents");
  r.check("another customer can't see them", other.length === 0, other);
  const staffSees = await t.as<Row>(ST.id, "select * from identity_documents where user_id = $1", [w.C1.id]);
  r.check("NWS staff can see them for review", staffSees.length === 2, staffSees.length);
  await r.denies("customers can't write the table directly", () => t.as(w.C1.id, "insert into identity_documents (user_id, kind, file_path) values ($1, 'id_back', 'x')", [w.C1.id]), "permission denied");
  await r.denies("signed-out visitors can't record documents", () => t.as(null, "select * from add_identity_document('id_front', 'x/y.jpg')"), "permission denied");
  const cols = await t.admin<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'identity_documents'");
  r.check("no ID number column is added (the number stays on the verify_identity path)", !cols.some((c) => /id_no|number/.test(c.column_name)), cols.map((c) => c.column_name));

  // ---- E15 water-quality certificate --------------------------------------------------------------
  await t.admin("delete from water_tests where tanker_id = $1", [w.tk.D1]);
  await t.admin(
    `insert into water_tests (tanker_id, cert_no, tested_at, chlorine, turbidity, tds, ph, passed, valid_until)
     values ($1, $2, current_date - 10, 0.5, 0.3, 280, 7.3, true, current_date + 80),
            ($1, $3, current_date + 5, 0.6, 0.3, 290, 7.2, true, current_date + 95)`,
    [w.tk.D1, `WQ-T-${t.runId.slice(-6)}-A`, `WQ-T-${t.runId.slice(-6)}-B`],
  );
  await setOnline(t, w.D1.id, true);
  const o = await placeOrder(t, w.C1.id, "DW", 1000);
  await t.as(w.D1.id, "select * from accept_order($1)", [o.id]);
  await t.as(w.D1.id, "select report_location(23.6, 58.2, 8, now())");
  await t.as(w.D1.id, "select status from mark_arrived($1)", [o.id]);
  await deliver(t, w.D1.id, o.id);
  const cert = await one<{ c: Row }>(w.C1.id, "select order_water_certificate($1) as c", [o.id]);
  r.check(
    "the customer gets the test in force on the delivery day (not a later one), with lab, validity and the sample-data flag",
    cert?.c?.cert_no === `WQ-T-${t.runId.slice(-6)}-A` && cert.c.valid_on_delivery === true && cert.c.sample === true && typeof cert.c.lab === "string" && cert.c.order_no != null,
    cert?.c,
  );
  await r.denies("another customer can't open it", () => one(w.C2.id, "select order_water_certificate($1) as c", [o.id]), "not_found");
  const staffCert = await one<{ c: Row }>(ST.id, "select order_water_certificate($1) as c", [o.id]);
  r.check("staff can open it", staffCert?.c?.cert_no != null, staffCert);

  // ---- C1 GPS source -------------------------------------------------------------------------
  const at = new Date(Date.now() + 1000).toISOString();
  await t.as(w.D1.id, "select report_location(23.6001, 58.2001, 7, $1::timestamptz, 'phone')", [at]);
  const [fix] = await t.admin<{ source: string | null; accuracy_m: number }>("select source, accuracy_m from gps_fixes where tanker_id = $1 order by recorded_at desc limit 1", [w.tk.D1]);
  r.check("a fix sent from the driver app is stored with its accuracy and source 'phone'", fix?.source === "phone" && Number(fix.accuracy_m) === 7, fix);
  await r.denies("an unknown source is refused", () => t.as(w.D1.id, "select report_location(23.6, 58.2, 7, now(), 'satellite')"), "invalid_source");
  await r.denies("the 5-argument form keeps the accuracy rule", () => t.as(w.D1.id, "select report_location(23.6, 58.2, 500, now(), 'phone')"), "inaccurate_fix");
  const [priv] = await t.admin<{ anon: boolean; authed: boolean }>(
    "select has_function_privilege('anon', 'public.report_location(double precision, double precision, double precision, timestamptz, text)', 'execute') as anon, has_function_privilege('authenticated', 'public.report_location(double precision, double precision, double precision, timestamptz, text)', 'execute') as authed",
  );
  r.check("the new form is for signed-in users only", !priv.anon && priv.authed, priv);

  // ---- D13 driver training ----------------------------------------------------------------------
  const lessons = await t.as<Row>(w.D2.id, "select key, sort, pass_min from training_lessons where active order by sort");
  r.check("drivers see five lessons", lessons.length === 5, lessons);
  await r.denies("drivers can't read the answer key", () => t.as(w.D2.id, "select answer_key from training_lessons"), "permission denied");
  const fail = await one<{ res: { passed: boolean; correct: number } }>(w.D2.id, "select complete_training_lesson('safety', array[0,0,1]) as res");
  const failRows = await t.as<Row>(w.D2.id, "select * from driver_training");
  r.check("a failed quiz is graded and not recorded", fail?.res.passed === false && failRows.length === 0, { fail, failRows });
  await r.denies("the wrong number of answers is refused", () => one(w.D2.id, "select complete_training_lesson('safety', array[1]) as res"), "invalid_answers");
  await r.denies("customers can't take the training", () => one(w.C1.id, "select complete_training_lesson('safety', array[1,2,0]) as res"), "not_a_driver");
  const keys = await t.admin<{ key: string; answer_key: number[] }>("select key, answer_key from training_lessons where active order by sort");
  const pass = await one<{ res: { passed: boolean; correct: number; complete: boolean } }>(w.D2.id, "select complete_training_lesson('safety', $1::int[]) as res", [keys[0].answer_key]);
  r.check("a passed quiz is recorded for the driver", pass?.res.passed === true && pass.res.complete === false && (await t.as(w.D2.id, "select 1 from driver_training where lesson = 'safety'")).length === 1, pass);
  r.check("another driver can't see it", (await t.as(w.D3.id, "select * from driver_training")).length === 0);
  r.check("staff can see it", (await t.as(ST.id, "select * from driver_training where driver_id = $1", [w.D2.id])).length === 1);

  // The online rule (off by default).
  const [setting] = await t.admin<{ value: string }>("select value from app_settings where key = 'DRIVER_TRAINING_REQUIRED'");
  r.check("training is not required to go online by default", setting?.value === "false", setting);
  await setOnline(t, w.D2.id, false);
  await r.allows("with the rule off, an untrained driver can go online", () => setOnline(t, w.D2.id, true));
  await setOnline(t, w.D2.id, false);
  await t.admin("update app_settings set value = 'true' where key = 'DRIVER_TRAINING_REQUIRED'");
  try {
    await r.denies("with the rule on, an untrained driver can't go online", () => setOnline(t, w.D2.id, true), "training_required");
    for (const k of keys.slice(1)) await one(w.D2.id, "select complete_training_lesson($1, $2::int[]) as res", [k.key, k.answer_key]);
    const done = await one<{ c: boolean }>(w.D2.id, "select training_complete($1) as c", [w.D2.id]);
    r.check("all five lessons passed completes the training", done?.c === true, done);
    await r.allows("with the rule on, a trained driver can go online", () => setOnline(t, w.D2.id, true));
  } finally {
    await t.admin("update app_settings set value = 'false' where key = 'DRIVER_TRAINING_REQUIRED'");
  }
  await setOnline(t, w.D2.id, false);
  await setOnline(t, w.D1.id, false);
}
