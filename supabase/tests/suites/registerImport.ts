// Batch D (0031–0033): clusters, the NWS register import, claiming, the permit campaign and
// SMS invitations. Every row here is invented (the real register never enters the repo).
// The import writes register tankers by real-looking plates, so the mutating checks run only
// on a fresh PGlite database; on Supabase the suite checks the read-only parts.
import type { Reporter, Target } from "../lib/harness";
import { makeWorld, placeOrder } from "../lib/world";
import {
  clusterCode, governorateCode, normalizePlate, permitStatus, serviceType, validateCsv, chunks, clientOnlyIssues,
} from "../../../lib/importRegister";

type Row = Record<string, unknown>;
type Res = { counts: Record<string, number>; issues: { row: number; plate: string; level: string; field: string; message: string }[] };

// Invented sample register (same columns as the NWS export).
const HEADER = '"Plate No.","Owner","Tanker Type","Governorate","Cluster","Contact","Permit Status","Permit No.","Permit Issued","Permit Expiry"';
const SAMPLE = [
  HEADER,
  '"8101 ZQ","Sample Owner One","Drinking Water","Muscat","Cluster 1","99001101","Valid","TST-2026-0001/ZQ-01","2026-10-01","2027-10-01"',
  '"8102 ZQ","Sample Owner One","Drinking Water","Muscat","Cluster 1","+968 9900 1101","In Progress","","",""',
  '"8103zq","Sample Owner Two","Sewage Water","North Al Batinah","Cluster 2","96899001102","No Permit","","",""',
  '"81041 Z","Sample Owner Three","Treated Effluent","Al Wusta","Cluster 3","null","No Permit","","",""',
  '"8105 ZQ","Sample Owner Four","Drinking Water","Al Dakhiliyah","Cluster 1","12345","No Permit","TST-2026-0005/ZQ-01","2026-10-02","2027-10-02"',
  '"8103 ZQ","Sample Owner Two","Sewage Water","North Al Batinah","Cluster 2","99001102","No Permit","","",""',
  '"ZQ 8106","Sample Owner Five","Drinking Water","Muscat","Cluster 1","99001105","No Permit","","",""',
  '"8107 ZQ","Sample Owner Six","Milk","Atlantis","Cluster 9","99001106","Maybe","","",""',
  '"8108 ZQ","Sample Owner Seven","Drinking Water","South Al Sharqiyah","Cluster 1","99001107","No Permit","","",""',
  '"8109 ZQ","Sample Owner Eight","Drinking Water","Al Dhahirah","Cluster 2","99001108","No Permit","","",""',
].join("\r\n");

export async function registerImportSuite(t: Target, r: Reporter) {
  const one = async <T = Row>(uid: string | null, sql: string, params: unknown[] = []) => (await t.as<T>(uid, sql, params))[0];
  const mkStaff = async (label: string, role: string) => {
    const u = await t.createUser(label, { role: "customer", full_name: `Test ${role}` });
    await t.admin("update profiles set role = 'nws_staff', staff_role = $2 where id = $1", [u.id, role]);
    return u;
  };

  r.start("REGGEO clusters and register helpers (0031)");
  const plates = ["1798 ml", "1798ML", "9999/A A", "12345 a", "1234567", "999A AA", "/ A A9999", "ABC", " 77  k ", "١٢٣ AB"];
  const sqlPlates = await t.admin<{ p: string | null }>("select normalize_plate(x) as p from unnest($1::text[]) with ordinality u(x, i) order by i", [plates]);
  const tsPlates = plates.map(normalizePlate);
  r.check("plates: lib/importRegister and normalize_plate() agree (uppercase, one space, format check)", sqlPlates.every((x, i) => x.p === tsPlates[i]), { sql: sqlPlates.map((x) => x.p), ts: tsPlates });
  const govs = ["Muscat", "Al Dakhiliyah", "Ad Dakhiliyah", "North Al Sharqiyah", "north ash sharqiyah", "Al Dhahirah", "Adh Dhahirah", "South Al Batinah", "Al Wusta",
    "South Al Sharqiyah", "North Al Batinah", "Muscat Governorate", "MUS", "Atlantis", ""];
  const sqlGov = await t.admin<{ g: string | null }>("select governorate_code(x) as g from unnest($1::text[]) with ordinality u(x, i) order by i", [govs]);
  r.check("governorates: the register's and the zones' spellings map to the same codes in both", sqlGov.every((x, i) => x.g === governorateCode(govs[i])), { sql: sqlGov.map((x) => x.g), ts: govs.map((g) => governorateCode(g)) });
  const cls = ["Cluster 1", "cluster2", "C3", "3", "Cluster 9", "x", ""];
  const sqlCl = await t.admin<{ c: string | null }>("select cluster_code(x) as c from unnest($1::text[]) with ordinality u(x, i) order by i", [cls]);
  r.check("clusters: 'Cluster 1' / 'C1' / '1' agree in both", sqlCl.every((x, i) => x.c === clusterCode(cls[i])), { sql: sqlCl.map((x) => x.c) });
  const svcs = ["Drinking Water", "Sewage Water", "Treated Effluent", "drinking  water", "Milk"];
  const sqlSvc = await t.admin<{ s: string | null; p: string | null }>(
    "select register_service_type(x)::text as s, register_permit_status(y) as p from unnest($1::text[], $2::text[]) with ordinality u(x, y, i) order by i",
    [svcs, ["Valid", "In Progress", "No Permit", "in_progress", "Maybe"]]);
  r.check("tanker type → DW/WW/TE and permit status → valid/in_progress/none agree in both",
    sqlSvc.every((x, i) => x.s === serviceType(svcs[i]) && x.p === permitStatus(["Valid", "In Progress", "No Permit", "in_progress", "Maybe"][i])), sqlSvc);
  const map = await t.admin<{ code: string; cluster_code: string | null }>("select code, cluster_code from governorates where code in ('MUS','NSH','SSH','DHA','NBA','SBA','DAK','WUS') order by code");
  r.check("the register's governorate → cluster mapping is seeded (C1 Muscat + Sharqiyah, C2 Dhahirah + North Batinah, C3 South Batinah + Dakhiliyah + Wusta)",
    map.map((x) => `${x.code}:${x.cluster_code}`).join(",") === "DAK:C3,DHA:C2,MUS:C1,NBA:C2,NSH:C1,SBA:C3,SSH:C1,WUS:C3", map);
  const [zm] = await t.admin<{ n: number }>("select count(*)::int as n from zones where not is_test and governorate_code is null");
  r.check("every Omani zone has a governorate code (orders report per governorate and cluster)", zm.n === 0, zm);

  r.start("REGVAL validation in the browser and the script (lib/importRegister)");
  const v = validateCsv(SAMPLE, { today: "2026-10-30" });
  const errs = (row: number) => v.issues.filter((x) => x.row === row && x.level === "error").map((x) => x.field);
  const warns = (row: number) => v.issues.filter((x) => x.row === row && x.level === "warning").map((x) => x.field);
  r.check("the register's headers are recognised without a mapping step", v.missing.length === 0 && Object.values(v.mapping).every((x) => x != null), v.mapping);
  r.check("rows: 10 total, 7 to send; a plate repeated after normalisation, letters-first plate and unknown type/governorate/status are errors",
    v.summary.total === 10 && v.summary.send === 7 && errs(7).includes("plate") && errs(8).includes("plate") && ["tanker_type", "governorate", "permit_status"].every((f) => errs(9).includes(f)),
    { s: v.summary, e7: errs(7), e8: errs(8), e9: errs(9) });
  r.check("phones become E.164 (8 digits, +968 …, 968…); 'null' is missing; an invalid one is a warning",
    v.rows.find((x) => x.row === 2)?.phone === "+96899001101" && v.rows.find((x) => x.row === 3)?.phone === "+96899001101" && v.rows.find((x) => x.row === 4)?.phone === "+96899001102"
      && v.rows.find((x) => x.row === 5)?.phone === null && v.rows.find((x) => x.row === 6)?.phone === null && warns(6).includes("contact"), v.rows.map((x) => [x.row, x.phone]));
  r.check("a cluster that disagrees with the governorate is a warning; No Permit with permit details is a warning",
    warns(6).includes("cluster") && warns(6).includes("permit_status"), warns(6));
  r.check("plate '8103zq' is stored as '8103 ZQ'", v.rows.find((x) => x.row === 4)?.plate === "8103 ZQ");

  if (!t.fresh) {
    r.skip("register import, claims, campaign and invitations", "writes register tankers by plate: PGlite only (never on the live project)");
    return;
  }

  const AD = await mkStaff("ri-ad", "admin");
  const PO = await mkStaff("ri-po", "permit_officer");
  const OP = await mkStaff("ri-op", "operator");
  const w = await makeWorld(t, "regi");

  r.start("REGIMP import RPCs (0032)");
  await r.denies("customers can't start an import", () => one(w.C1.id, "select * from staff_import_batch_start('x.csv', 10)"), "not_staff");
  await r.denies("operators can't import the register", () => one(OP.id, "select * from staff_import_batch_start('x.csv', 10)"), "forbidden_for_role");
  const b1 = await one<{ id: string; status: string }>(PO.id, "select * from staff_import_batch_start($1, $2, $3::jsonb)", ["sample.csv", v.summary.total, JSON.stringify(v.summary)]);
  r.check("a permit officer starts a batch", b1?.status === "running");
  await r.denies("a chunk over 500 rows is refused", () => one(PO.id, "select staff_import_register($1::jsonb, $2)", [JSON.stringify(Array.from({ length: 501 }, () => v.rows[0])), b1.id]), "chunk_too_large");
  const [c1, c2] = chunks(v.rows, 4);
  const r1 = (await one<{ r: Res }>(PO.id, "select staff_import_register($1::jsonb, $2) as r", [JSON.stringify(c1), b1.id])).r;
  const r2 = (await one<{ r: Res }>(PO.id, "select staff_import_register($1::jsonb, $2) as r", [JSON.stringify(c2), b1.id])).r;
  const sum = (k: string) => (r1.counts[k] ?? 0) + (r2.counts[k] ?? 0);
  r.check("7 tankers created; owners matched on mobile number (two tankers, one owner)", sum("tankers_created") === 7 && sum("owners_created") === 6 && sum("owners_matched") === 1,
    { r1: r1.counts, r2: r2.counts });
  r.check("Valid → an approved permit; In Progress → a pending application; No Permit → none", sum("permits_created") === 1 && sum("applications_created") === 1);
  const tk = await t.admin<{ plate: string; on_platform: boolean; in_register: boolean; is_online: boolean; capacity_known: boolean; governorate_code: string; service_type: string }>(
    "select plate, on_platform, in_register, is_online, capacity_known, governorate_code, service_type::text from tankers where import_batch_id = $1 order by plate", [b1.id]);
  r.check("register tankers are offline, not on the platform, capacity unknown, with a governorate",
    tk.length === 7 && tk.every((x) => !x.on_platform && x.in_register && !x.is_online && !x.capacity_known && !!x.governorate_code), tk);
  const [perm] = await t.admin<{ status: string; type: string; stage: string; exp: string }>(
    "select p.status::text, p.type::text, p.stage, to_char(p.expires_at at time zone 'Asia/Muscat', 'YYYY-MM-DD') as exp from permits p join tankers k on k.id = p.tanker_id where k.plate = '8101 ZQ'");
  const [app] = await t.admin<{ status: string; stage: string }>("select p.status::text, p.stage from permits p join tankers k on k.id = p.tanker_id where k.plate = '8102 ZQ'");
  r.check("the approved permit keeps the register's number and expiry; the application is at the submitted stage",
    perm?.status === "approved" && perm.type === "DW" && perm.exp === "2027-10-01" && app?.status === "pending" && app.stage === "submitted", { perm, app });
  const bad = (await one<{ r: Res }>(PO.id, "select staff_import_register($1::jsonb, $2) as r",
    [JSON.stringify([{ row: 99, plate: "XYZ", owner: "x", service_type: "DW", governorate: "Muscat", permit_status: "none" }, { row: 98, plate: "8199 ZQ", service_type: "Milk", governorate: "Atlantis", permit_status: "none" }]), b1.id])).r;
  r.check("the database re-validates rows itself (bad plate, unknown type) and reports them", bad.counts.errors === 2 && bad.counts.tankers_created === 0 && bad.issues.length === 2, bad);
  const dup = (await one<{ r: Res }>(PO.id, "select staff_import_register($1::jsonb, $2) as r", [JSON.stringify([{ ...v.rows[0], row: 50 }]), b1.id])).r;
  r.check("a plate already imported earlier in the same batch is reported as a duplicate", dup.counts.errors === 1 && dup.issues[0]?.message.includes("twice"), dup);
  const fin = await one<{ status: string; errors: unknown[]; counts: Record<string, number>; chunks: number }>(PO.id,
    "select * from staff_import_batch_finish($1, $2::jsonb)", [b1.id, JSON.stringify(clientOnlyIssues(v.issues))]);
  r.check("finishing stores counts and one error report (browser and database issues together)",
    fin?.status === "completed" && fin.chunks === 4 && fin.counts.tankers_created === 7 && fin.errors.length >= 6, { status: fin?.status, chunks: fin?.chunks, n: fin?.errors.length });
  const [au] = await t.admin<{ n: number; fin: number }>("select count(*)::int as n, count(*) filter (where action = 'register.import')::int as fin from audit_log where target_type = 'import_batch' and target_id = $1", [b1.id]);
  r.check("the import is audit-logged (start, each chunk, finish)", au.n === 6 && au.fin === 1, au);
  await r.denies("a finished batch takes no more rows", () => one(PO.id, "select staff_import_register($1::jsonb, $2)", [JSON.stringify(c1), b1.id]), "invalid_state");

  const b2 = await one<{ id: string }>(PO.id, "select * from staff_import_batch_start('sample-again.csv', 10)");
  const again = (await one<{ r: Res }>(PO.id, "select staff_import_register($1::jsonb, $2) as r", [JSON.stringify(v.rows), b2.id])).r;
  await one(PO.id, "select * from staff_import_batch_finish($1)", [b2.id]);
  const [nt] = await t.admin<{ n: number; p: number }>("select (select count(*)::int from tankers where in_register) as n, (select count(*)::int from permits p join tankers k on k.id = p.tanker_id where k.in_register) as p");
  r.check("re-importing the same file is idempotent by plate (updates only, no new tankers, owners or permits)",
    again.counts.tankers_created === 0 && again.counts.tankers_updated === 7 && again.counts.owners_created === 0 && again.counts.permits_created === 0
      && again.counts.applications_created === 0 && nt.n === 7 && nt.p === 2, { c: again.counts, nt });

  r.start("REGOPS register tankers stay out of dispatch and live operations (0031)");
  const [reg] = await t.admin<{ id: string }>("select id from tankers where plate = '8101 ZQ'");
  await r.denies("a register-only tanker can't be switched online", () => t.admin("update tankers set is_online = true where id = $1", [reg.id]), "not_on_platform");
  const o = await placeOrder(t, w.C1.id, "DW", 1000);
  const rankedIds = (await t.admin<{ tanker_id: string }>("select tanker_id from dispatch_rank($1)", [o.id])).map((x) => x.tanker_id);
  r.check("dispatch ranks only on-platform tankers (no register tanker among the candidates)", rankedIds.length > 0 && !rankedIds.includes(reg.id), { n: rankedIds.length });
  const [cnt] = await t.as<{ platform: number; register: number }>(OP.id,
    "select count(*) filter (where on_platform)::int as platform, count(*) filter (where in_register)::int as register from tankers");
  r.check("'registered on platform' and 'in NWS register' are separate counts", cnt.register === 7 && cnt.platform >= 3, cnt);

  r.start("REGLIST register list, privacy and the campaign (0033)");
  type List = { total: number; privileged: boolean; rows: { plate: string; cluster: string; phone: string | null; stage: string; owner_id: string | null; has_phone: boolean }[] };
  const l1 = (await one<{ r: List }>(PO.id, "select staff_register_tankers($1::jsonb, 50, 0) as r", [JSON.stringify({ source: "register", cluster: "C1" })])).r;
  r.check("filtering by cluster: only C1 tankers (the governorate decides: Al Dakhiliyah stays in C3)", l1.total === 3 && l1.rows.every((x) => x.cluster === "C1"), l1.rows.map((x) => [x.plate, x.cluster]));
  const ph = l1.rows.find((x) => x.plate === "8101 ZQ")?.phone ?? "";
  r.check("a permit officer sees owner numbers masked", !l1.privileged && ph.includes("•") && !ph.includes("99001101"), ph);
  const l2 = (await one<{ r: List }>(AD.id, "select staff_register_tankers($1::jsonb, 50, 0) as r", [JSON.stringify({ q: "8101" })])).r;
  r.check("a privileged role (admin) sees the full number", l2.privileged && l2.rows[0]?.phone === "+96899001101", l2.rows[0]);
  await r.denies("staff can't select registry owner numbers directly", () => t.as(PO.id, "select phone from registry_owners limit 1"), "permission denied");
  await r.denies("customers can't list the register", () => one(w.C1.id, "select staff_register_tankers('{}'::jsonb)"), "not_staff");
  const page = (await one<{ r: List }>(PO.id, "select staff_register_tankers($1::jsonb, 2, 2) as r", [JSON.stringify({ source: "register" })])).r;
  r.check("the list pages on the server (total 7, page of 2)", page.total === 7 && page.rows.length === 2);

  type Funnel = { in_register: number; invited: number; registered: number; applied: number; review: number; permitted: number; expiring_60: number; no_phone: number; invitable: number };
  const f0 = (await one<{ r: { total: Funnel; by_cluster: (Funnel & { cluster_code: string })[]; by_governorate: (Funnel & { governorate_code: string })[] } }>(PO.id, "select report_permit_campaign('{}'::jsonb) as r")).r;
  r.check("funnel: in register 7 → applied 2 → permitted 1", f0.total.in_register === 7 && f0.total.applied === 2 && f0.total.permitted === 1 && f0.total.invited === 2, f0.total);
  r.check("funnel by cluster and by governorate add up", f0.by_cluster.reduce((a, x) => a + x.in_register, 0) === 7 && f0.by_governorate.reduce((a, x) => a + x.in_register, 0) === 7
    && f0.by_cluster.find((x) => x.cluster_code === "C1")?.in_register === 3, f0.by_cluster);

  r.start("REGINV SMS invitations to registry owners (0033)");
  await r.denies("operators can't send register invitations", () => one(OP.id, "select staff_invite_registry_owners(null, $1)", [b1.id]), "forbidden_for_role");
  const inv = (await one<{ r: { queued: number; skipped: Record<string, number> } }>(PO.id, "select staff_invite_registry_owners(null, $1, null, 'en', 500, 'TEST campaign') as r", [b1.id])).r;
  const ob = await t.admin<{ destination: string; user_id: string | null; lang: string; body: string; status: string }>("select destination, user_id, lang, body, status from notification_outbox where event = 'registry_invite' order by id");
  r.check("owners with a number get one SMS each through the outbox (no account needed); owners without a number are skipped",
    inv.queued === 4 && inv.skipped.no_phone === 2 && ob.length === 4 && ob.every((x) => x.user_id === null && /^\+968\d{8}$/.test(x.destination) && x.status === "queued" && x.lang === "en"), { inv, ob: ob.length });
  r.check("the invitation names the owner's plates and how to opt out", ob.some((x) => x.body.includes("8101 ZQ") && x.body.includes("8102 ZQ") && x.body.includes("STOP")), ob.map((x) => x.body.slice(0, 60)));
  const inv2 = (await one<{ r: { queued: number; skipped: Record<string, number> } }>(PO.id, "select staff_invite_registry_owners(null, $1) as r", [b1.id])).r;
  r.check("inviting again within the cooldown sends nothing", inv2.queued === 0 && inv2.skipped.cooldown === 4, inv2);
  const [own] = await t.admin<{ id: string }>("select id from registry_owners where phone = '+96899001107'");
  await one(PO.id, "select staff_registry_owner_opt_out($1, true, 'TEST owner replied STOP')", [own.id]);
  const [wd] = await t.admin<{ status: string; error: string }>("select status, error from notification_outbox where event = 'registry_invite' and destination = '+96899001107'");
  r.check("an opt-out withdraws the queued invitation and is audited", wd.status === "failed" && wd.error === "Owner opted out");
  await t.admin("update registry_owners set invited_at = now() - interval '30 days'");
  const inv3 = (await one<{ r: { queued: number; skipped: Record<string, number> } }>(PO.id, "select staff_invite_registry_owners(null, $1) as r", [b1.id])).r;
  r.check("after the cooldown the opted-out owner is still skipped", inv3.skipped.opted_out === 1 && inv3.queued === 3, inv3);
  const f1 = (await one<{ r: { total: Funnel } }>(PO.id, "select report_permit_campaign($1::jsonb) as r", [JSON.stringify({ cluster: "C2" })])).r;
  r.check("funnel filtered to cluster 2 counts invited owners' tankers", f1.total.in_register === 2 && f1.total.invited === 2, f1.total);

  r.start("REGCLAIM owners claim their tankers with their verified number (0032)");
  // Owner of 8101/8102 (+968 9900 1101) signs up and verifies the number, then registers a company.
  const OW = await t.createUser("ri-ow", { role: "owner" as never, full_name: "Test Registry Owner" });
  await t.admin("update auth.users set phone = '96899001101', phone_confirmed_at = now() where id = $1", [OW.id]);
  const [lnk] = await t.admin<{ n: number }>("select count(*)::int as n from registry_owners where profile_id = $1", [OW.id]);
  r.check("verifying the same mobile number links the registry owner to the account", lnk.n === 1, lnk);
  const comp = await one<{ id: string }>(OW.id, "select * from owner_register_company('TST Registry Owner Co', $1, '+968 9900 1101', 'Bank Muscat', 'OM12 TEST 0101')", [`TSTRG${t.runId.slice(-5)}`]);
  const moved = await t.admin<{ plate: string; company_id: string; on_platform: boolean }>("select plate, company_id, on_platform from tankers where plate in ('8101 ZQ', '8102 ZQ') order by plate");
  r.check("registering a company brings the owner's register tankers onto the platform under it", moved.length === 2 && moved.every((x) => x.company_id === comp.id && x.on_platform), moved);
  const mine = await one<{ r: { owners: number; tankers: unknown[] } }>(OW.id, "select my_registry_claim() as r");
  r.check("the owner sees their register entries", mine.r.owners === 1 && mine.r.tankers.length === 2, mine.r);
  // An unverified profile phone claims nothing.
  const FAKE = await t.createUser("ri-fake", { role: "owner" as never, full_name: "Test Imposter", phone: "+96899001102" });
  const [fk] = await t.admin<{ n: number }>("select count(*)::int as n from registry_owners where profile_id = $1", [FAKE.id]);
  r.check("a number typed on a profile but not verified claims nothing", fk.n === 0, fk);
  // A driver with the register's verified number adopts their plate (typed differently).
  const DV = await t.createUser("ri-dv", { role: "driver", full_name: "Test Owner Driver" });
  await t.admin("update auth.users set phone = '96899001102', phone_confirmed_at = now() where id = $1", [DV.id]);
  const [before] = await t.admin<{ id: string }>("select id from tankers where plate = '8103 ZQ'");
  const adopted = await one<{ id: string; plate: string; on_platform: boolean; capacity_gal: number; capacity_known: boolean }>(DV.id, "select * from driver_register_tanker('8103zq', 'WW', 7000)");
  r.check("a driver registering a register plate adopts that tanker (same row, capacity now known)",
    adopted?.id === before.id && adopted.on_platform && adopted.capacity_gal === 7000 && adopted.capacity_known, adopted);
  const DX = await t.createUser("ri-dx", { role: "driver", full_name: "Test Other Driver" });
  await t.admin("update auth.users set phone = '96899001199', phone_confirmed_at = now() where id = $1", [DX.id]);
  await r.denies("a driver with a different number can't take a register plate", () => one(DX.id, "select * from driver_register_tanker('8108 ZQ', 'DW', 5000)"), "plate_in_register");
  const ok = await one<{ plate: string }>(DX.id, "select * from driver_register_tanker('81041 Z', 'TE', 4000)");
  r.check("a register plate whose owner has no number on file can be registered (NWS checks ownership at permit review)", ok?.plate === "81041 Z");

  r.start("REGRPT Reports → Clusters (0033)");
  type CRep = { by_cluster: { cluster_code: string | null; in_register: number; on_platform: number; permitted: number }[]; by_governorate: { code: string; in_register: number }[] };
  const cr = (await one<{ r: CRep }>(PO.id, "select report_clusters(30) as r")).r;
  r.check("per-cluster KPIs: register and platform tankers, permits",
    cr.by_cluster.find((x) => x.cluster_code === "C1")?.in_register === 3 && cr.by_cluster.reduce((a, x) => a + Number(x.in_register), 0) === 7
      && cr.by_governorate.find((x) => x.code === "MUS")?.in_register === 2, cr.by_cluster);
  const crf = (await one<{ r: CRep }>(PO.id, "select report_clusters(30, 'C2') as r")).r;
  r.check("filtered to one cluster", crf.by_governorate.every((x) => ["DHA", "NBA"].includes(x.code)) && crf.by_cluster.length === 1, crf.by_governorate.map((x) => x.code));
  await r.denies("admins only move a governorate to another cluster", () => one(PO.id, "select * from staff_set_governorate_cluster('Al Wusta', 'Cluster 2', 'TEST')"), "forbidden_for_role");
  const mv = await one<{ cluster_code: string }>(AD.id, "select * from staff_set_governorate_cluster('Al Wusta', 'Cluster 2', 'TEST reassignment')");
  await one(AD.id, "select * from staff_set_governorate_cluster('Al Wusta', 'Cluster 3', 'TEST restore')");
  r.check("an admin moves a governorate to another cluster (audited)", mv?.cluster_code === "C2");
}
