// NWS staff (0008): sub-roles, staff RPCs, audit log, blocks and permits.
import type { Reporter, Target, Uid } from "../lib/harness";
import { giveTanker, makeWorld, placeOrder, plateFor, setOnline, deliver } from "../lib/world";
import { raceFromBarrier } from "./concurrency";

type Row = Record<string, unknown>;

export async function staffSuite(t: Target, r: Reporter) {
  r.start("STAFF NWS staff portal");
  const w = await makeWorld(t, "staf");
  const { C1, D1, D2, D3 } = w;

  // Staff accounts can't come from sign-up: metadata role nws_staff still yields a customer.
  const fake = await t.createUser("staf-fake", { role: "nws_staff" as never, full_name: "Test Wannabe Staff" });
  const [fp] = await t.admin<{ role: string; staff_role: string | null }>("select role, staff_role from profiles where id = $1", [fake.id]);
  r.check("signing up with role nws_staff produces a customer (no staff_role)", fp.role === "customer" && fp.staff_role === null, fp);
  await r.denies("a user can't make themselves staff by updating their profile", () => t.as(fake.id, "update profiles set role = 'nws_staff', staff_role = 'admin' where id = $1", [fake.id]), "permission denied");

  // Staff fixtures: created as customers, promoted directly (as the seed script does).
  const mkStaff = async (label: string, role: string) => {
    const u = await t.createUser(label, { role: "customer", full_name: `Test ${role}` });
    await t.admin("update profiles set role = 'nws_staff', staff_role = $2 where id = $1", [u.id, role]);
    return u;
  };
  const OP = await mkStaff("staf-op", "operator");
  const PO = await mkStaff("staf-po", "permit_officer");
  const AD = await mkStaff("staf-ad", "admin");

  const auditCount = async (targetId: string) => (await t.admin<{ n: number }>("select count(*)::int as n from audit_log where target_id = $1", [targetId]))[0].n;
  const lastAudit = async (targetId: string) => (await t.admin<Row>("select * from audit_log where target_id = $1 order by id desc limit 1", [targetId]))[0];

  // A spare tanker + permit to act on.
  const D6 = await t.createUser("staf-d6", { role: "driver", full_name: "Test Driver Six" });
  const tk6 = await giveTanker(t, D6.id, plateFor(t, "STAFD6"), "DW", 5000, { permit: false });
  const [permit] = await t.admin<{ id: string }>(
    "insert into permits (tanker_id, permit_no, type, issued_at, expires_at) values ($1, $2, 'DW', now(), now() + interval '1 year') returning id",
    [tk6, `PT-${plateFor(t, "S6")}`],
  );

  // ---- every staff RPC × anon / customer / driver → refused
  const calls: [string, string, unknown[]][] = [
    ["staff_block_tanker", "select * from staff_block_tanker($1, 'TEST reason')", [w.tk.D2]],
    ["staff_unblock_tanker", "select * from staff_unblock_tanker($1, 'TEST reason')", [w.tk.D2]],
    ["staff_assign_tanker", "select * from staff_assign_tanker($1, $2, 'TEST reason')", [D6.id, w.tk.D2]],
    ["staff_unassign_tanker", "select * from staff_unassign_tanker($1, 'TEST reason')", [w.tk.D2]],
    ["staff_create_permit", "select * from staff_create_permit($1, 'TEST-X', 'DW', now(), now() + interval '1 year')", [tk6]],
    ["staff_review_permit", "select * from staff_review_permit($1, 'approve', null)", [permit.id]],
    ["staff_resubmit_permit", "select * from staff_resubmit_permit($1, null, null)", [permit.id]],
    ["staff_set_role", "select * from staff_set_role($1, 'admin', 'TEST reason')", [C1.id]],
  ];
  const auditBefore = (await t.admin<{ n: number }>("select count(*)::int as n from audit_log"))[0].n;
  for (const [fn, sql, p] of calls) {
    for (const [who, uid, match] of [
      ["anon", null, "permission denied"],
      ["customer", C1.id, "not_staff"],
      ["driver", D1.id, "not_staff"],
    ] as [string, Uid, string][]) {
      await r.denies(`${who} → ${fn}: refused`, () => t.as(uid, sql, p), match);
    }
  }
  const auditAfterRefusals = (await t.admin<{ n: number }>("select count(*)::int as n from audit_log"))[0].n;
  r.check("refused calls write no audit rows", auditAfterRefusals === auditBefore, { auditBefore, auditAfterRefusals });

  // ---- audit_log visibility
  await r.denies("anon can't read audit_log", () => t.as(null, "select * from audit_log limit 1"), "permission denied");
  for (const [who, uid] of [["customer", C1.id], ["driver", D1.id]] as const) {
    r.check(`${who} sees no audit rows`, (await t.as(uid, "select id from audit_log")).length === 0);
  }

  // ---- each sub-role can do only its own actions
  const forbidden = async (who: string, uid: string, fn: string, sql: string, p: unknown[]) =>
    r.denies(`${who} → ${fn}: forbidden for this sub-role`, () => t.as(uid, sql, p), "forbidden_for_role");
  const byName = Object.fromEntries(calls.map(([fn, sql, p]) => [fn, [sql, p] as const]));
  for (const fn of ["staff_create_permit", "staff_review_permit", "staff_resubmit_permit", "staff_set_role"]) await forbidden("operator", OP.id, fn, ...byName[fn]);
  for (const fn of ["staff_block_tanker", "staff_unblock_tanker", "staff_assign_tanker", "staff_unassign_tanker", "staff_set_role"]) await forbidden("permit_officer", PO.id, fn, ...byName[fn]);
  for (const fn of ["staff_block_tanker", "staff_unblock_tanker", "staff_assign_tanker", "staff_unassign_tanker", "staff_create_permit", "staff_review_permit", "staff_resubmit_permit"]) await forbidden("admin", AD.id, fn, ...byName[fn]);

  // ---- staff read everything
  const o = await placeOrder(t, C1.id, "DW", 700);
  for (const [who, uid] of [["operator", OP.id], ["permit_officer", PO.id], ["admin", AD.id]] as const) {
    const [counts] = await t.as<{ o: number; l: number; tk: number; a: number; p: number; pr: number; c: number }>(uid,
      `select (select count(*) from orders where id = $1)::int as o, (select count(*) from order_locations where order_id = $1)::int as l,
              (select count(*) from tankers where id = any($2::uuid[]))::int as tk, (select count(*) from tanker_assignments where tanker_id = any($2::uuid[]))::int as a,
              (select count(*) from permits where tanker_id = any($2::uuid[]))::int as p, (select count(*) from profiles where id = any($3::uuid[]))::int as pr,
              (select count(*) from orders where customer_id = $4)::int as c`,
      [o.id, [w.tk.D1, w.tk.D2, w.tk.D3], [C1.id, D1.id], C1.id]);
    r.check(`${who} reads all orders, locations, tankers, assignments, permits and profiles`, counts.o === 1 && counts.l === 1 && counts.tk === 3 && counts.a === 3 && counts.p === 3 && counts.pr === 2 && counts.c >= 1, counts);
  }

  // ---- admin: roles (and never their own)
  await r.denies("admin can't change their own staff_role (cannot_change_own_role)", () => t.as(AD.id, "select * from staff_set_role($1, 'operator', 'TEST reason')", [AD.id]), "cannot_change_own_role");
  await r.denies("admin can't remove their own staff role either", () => t.as(AD.id, "select * from staff_set_role($1, null, 'TEST reason')", [AD.id]), "cannot_change_own_role");
  await r.denies("admin can't edit their own role/staff_role columns directly", () => t.as(AD.id, "update profiles set staff_role = 'operator' where id = $1", [AD.id]), "permission denied");
  await r.denies("admin can't edit their own role column directly", () => t.as(AD.id, "update profiles set role = 'customer' where id = $1", [AD.id]), "permission denied");
  await r.denies("staff_set_role requires a reason", () => t.as(AD.id, "select * from staff_set_role($1, 'operator', ' ')", [fake.id]), "reason_required");
  await r.denies("staff_set_role can't turn a driver into staff", () => t.as(AD.id, "select * from staff_set_role($1, 'operator', 'TEST reason')", [D3.id]), "target_is_driver");
  const n0 = await auditCount(fake.id);
  const [promoted] = await t.as<{ role: string; staff_role: string }>(AD.id, "select role, staff_role from staff_set_role($1, 'operator', 'TEST onboarding')", [fake.id]);
  const a1 = await lastAudit(fake.id);
  r.check("admin makes a user an operator", promoted.role === "nws_staff" && promoted.staff_role === "operator", promoted);
  r.check("… exactly one audit row, with before/after and actor", (await auditCount(fake.id)) === n0 + 1 && a1.action === "staff.set_role" && (a1.before as Row).role === "customer" && (a1.after as Row).staff_role === "operator" && a1.actor_id === AD.id && a1.actor_role === "admin" && a1.reason === "TEST onboarding", a1);
  await t.as(AD.id, "select * from staff_set_role($1, null, 'TEST offboarding')", [fake.id]);
  const [demoted] = await t.admin<{ role: string; staff_role: string | null }>("select role, staff_role from profiles where id = $1", [fake.id]);
  r.check("admin removes the staff role again (back to customer), audited", demoted.role === "customer" && demoted.staff_role === null && (await auditCount(fake.id)) === n0 + 2, demoted);

  // ---- operator: block / unblock (enforced in the database)
  await setOnline(t, D2.id, true);
  await r.denies("block requires a reason", () => t.as(OP.id, "select * from staff_block_tanker($1, '')", [w.tk.D2]), "reason_required");
  const nb = await auditCount(w.tk.D2);
  const [blocked] = await t.as<{ blocked: boolean; is_online: boolean; blocked_reason: string }>(OP.id, "select blocked, is_online, blocked_reason from staff_block_tanker($1, 'TEST failed inspection')", [w.tk.D2]);
  r.check("operator blocks a tanker; it is taken offline", blocked.blocked && !blocked.is_online && blocked.blocked_reason === "TEST failed inspection", blocked);
  const ab = await lastAudit(w.tk.D2);
  r.check("… exactly one audit row (tanker.block, before online/unblocked → after offline/blocked)", (await auditCount(w.tk.D2)) === nb + 1 && ab.action === "tanker.block" && (ab.before as Row).blocked === false && (ab.after as Row).blocked === true && (ab.after as Row).is_online === false, ab);
  await r.denies("a blocked tanker can't go online (tanker_blocked)", () => setOnline(t, D2.id, true), "tanker_blocked");
  const req = await placeOrder(t, C1.id, "DW", 900);
  await r.denies("a blocked tanker can't accept (tanker_blocked)", () => t.as(D2.id, "select * from accept_order($1)", [req.id]), "tanker_blocked");
  r.check("a blocked tanker sees no open requests", (await t.as(D2.id, "select id from open_requests_near(23.6, 58.2)")).length === 0);
  await r.denies("blocking twice → already_blocked", () => t.as(OP.id, "select * from staff_block_tanker($1, 'TEST again')", [w.tk.D2]), "already_blocked");
  await t.as(OP.id, "select * from staff_unblock_tanker($1, 'TEST re-inspected')", [w.tk.D2]);
  r.check("… unblock writes exactly one more audit row", (await auditCount(w.tk.D2)) === nb + 2 && (await lastAudit(w.tk.D2)).action === "tanker.unblock");
  await r.allows("after unblocking, the tanker can go online again", () => setOnline(t, D2.id, true));

  // ---- operator: assignment override
  await setOnline(t, D1.id, true);
  const job = await placeOrder(t, C1.id, "DW", 800);
  await t.as(D1.id, "select * from accept_order($1)", [job.id]);
  await r.denies("unassigning a tanker on a job is refused (tanker_on_job)", () => t.as(OP.id, "select * from staff_unassign_tanker($1, 'TEST reason')", [w.tk.D1]), "tanker_on_job");
  await t.as(D1.id, "select * from mark_arrived($1)", [job.id]);
  await deliver(t, D1.id, job.id);
  const nu = await auditCount(w.tk.D1);
  await t.as(OP.id, "select * from staff_unassign_tanker($1, 'TEST driver left')", [w.tk.D1]);
  r.check("operator unassigns the tanker (one audit row)", (await auditCount(w.tk.D1)) === nu + 1 && (await lastAudit(w.tk.D1)).action === "tanker.unassign");
  await r.denies("assigning a driver who already has a tanker → driver_already_assigned", () => t.as(OP.id, "select * from staff_assign_tanker($1, $2, 'TEST reason')", [D2.id, w.tk.D1]), "driver_already_assigned");
  await r.denies("assigning a tanker that already has a driver → tanker_already_assigned", () => t.as(OP.id, "select * from staff_assign_tanker($1, $2, 'TEST reason')", [D1.id, w.tk.D2]), "tanker_already_assigned");
  await t.as(OP.id, "select * from staff_assign_tanker($1, $2, 'TEST back on shift')", [D1.id, w.tk.D1]);
  r.check("operator assigns it back (one audit row)", (await auditCount(w.tk.D1)) === nu + 2 && (await lastAudit(w.tk.D1)).action === "tanker.assign");

  // Two operators race to assign the same free tanker to two different drivers: exactly one wins.
  const OP2 = await mkStaff("staf-op2", "operator");
  const R1 = await t.createUser("staf-r1", { role: "driver", full_name: "Test Race One" });
  const R2 = await t.createUser("staf-r2", { role: "driver", full_name: "Test Race Two" });
  const FR = await t.createUser("staf-fr", { role: "driver", full_name: "Test Free" });
  const free = await giveTanker(t, FR.id, plateFor(t, "STAFFREE"), "DW", 3000);
  await t.admin("update tanker_assignments set unassigned_at = now() where tanker_id = $1 and unassigned_at is null", [free]);
  const race = await raceFromBarrier(t, [OP.id, OP2.id], (i) => ["select * from staff_assign_tanker($1, $2, 'TEST race')", [i === 0 ? R1.id : R2.id, free]]);
  const okN = race.outcomes.filter((x) => x.ok).length;
  const [active] = await t.admin<{ n: number }>("select count(*)::int as n from tanker_assignments where tanker_id = $1 and unassigned_at is null", [free]);
  r.check("two operators assign the same tanker at once: exactly one succeeds, one active assignment",
    okN === 1 && active.n === 1 && race.outcomes.some((x) => /already_assigned/.test(x.msg)), { outcomes: race.outcomes, active }, t.parallel ? "concurrent from a barrier" : "serialised on PGlite");

  // ---- permit officer: create / review / resubmit, and what each state allows
  const D7 = await t.createUser("staf-d7", { role: "driver", full_name: "Test Driver Seven" });
  const tk7 = await giveTanker(t, D7.id, plateFor(t, "STAFD7"), "DW", 5000, { permit: false });
  await r.denies("no permit: the tanker can't go online (permit_invalid)", () => setOnline(t, D7.id, true), "permit_invalid");
  const permitNo = `P7-${plateFor(t, "X")}`;
  const [p7] = await t.as<{ id: string; status: string }>(PO.id, "select id, status from staff_create_permit($1, $2, 'DW', now() - interval '1 day', now() + interval '200 days')", [tk7, permitNo]);
  r.check("permit officer creates a permit (pending) with one audit row", p7.status === "pending" && (await auditCount(p7.id)) === 1 && (await lastAudit(p7.id)).action === "permit.create");
  await r.denies("pending permit: still can't go online", () => setOnline(t, D7.id, true), "permit_invalid");
  await r.denies("rejecting needs a reason", () => t.as(PO.id, "select * from staff_review_permit($1, 'reject', null)", [p7.id]), "reason_required");
  await t.as(PO.id, "select * from staff_review_permit($1, 'reject', 'TEST insurance missing')", [p7.id]);
  const rej = await lastAudit(p7.id);
  r.check("reject: one audit row, before pending → after rejected, with reason", (await auditCount(p7.id)) === 2 && rej.action === "permit.reject" && (rej.before as Row).status === "pending" && (rej.after as Row).status === "rejected" && rej.reason === "TEST insurance missing", rej);
  await r.denies("rejected permit: can't go online", () => setOnline(t, D7.id, true), "permit_invalid");
  await r.denies("a rejected permit can't be approved directly (invalid_state)", () => t.as(PO.id, "select * from staff_review_permit($1, 'approve', null)", [p7.id]), "invalid_state");
  const [resub] = await t.as<{ status: string }>(PO.id, "select status from staff_resubmit_permit($1, null, 'TEST documents provided')", [p7.id]);
  r.check("rejection allows resubmission (back to pending, one audit row)", resub.status === "pending" && (await auditCount(p7.id)) === 3);
  await r.denies("resubmitted (pending) permit: still can't go online", () => setOnline(t, D7.id, true), "permit_invalid");
  await t.as(PO.id, "select * from staff_review_permit($1, 'approve', null)", [p7.id]);
  r.check("approve: one audit row", (await auditCount(p7.id)) === 4 && (await lastAudit(p7.id)).action === "permit.approve");
  await r.allows("approved, unexpired permit: the tanker can go online", () => setOnline(t, D7.id, true));
  const j7 = await placeOrder(t, C1.id, "DW", 600);
  // Expire it while online (fixture: move the dates into the past).
  await t.admin("update permits set issued_at = now() - interval '2 years', expires_at = now() - interval '1 minute' where id = $1", [p7.id]);
  await r.denies("expired permit: can't accept (permit_invalid), even while still online", () => t.as(D7.id, "select * from accept_order($1)", [j7.id]), "permit_invalid");
  r.check("expired permit: no open requests are shown", (await t.as(D7.id, "select id from open_requests_near(23.6, 58.2)")).length === 0);
  await setOnline(t, D7.id, false);
  await r.denies("expired permit: can't go online", () => setOnline(t, D7.id, true), "permit_invalid");
  const [eff] = await t.as<{ s: string }>(PO.id, "select effective_status(p) as s from permits p where id = $1", [p7.id]);
  r.check("an approved permit past its expiry reads 'expired'", eff.s === "expired", eff);
  // Wrong service type: a WW permit doesn't let a DW tanker go online.
  const [pw] = await t.as<{ id: string }>(PO.id, "select id from staff_create_permit($1, $2, 'WW', now() - interval '1 day', now() + interval '200 days')", [tk7, `PW-${plateFor(t, "X")}`]);
  await t.as(PO.id, "select * from staff_review_permit($1, 'approve', null)", [pw.id]);
  await r.denies("a permit for another service type doesn't count (permit_invalid)", () => setOnline(t, D7.id, true), "permit_invalid");

  // ---- audit rows can't be changed or removed, by anyone
  const [someRow] = await t.admin<{ id: string }>("select id from audit_log where target_id = $1 limit 1", [p7.id]);
  for (const [who, uid] of [["operator", OP.id], ["admin", AD.id], ["customer", C1.id]] as const) {
    await r.denies(`${who} can't UPDATE audit_log`, () => t.as(uid, "update audit_log set reason = 'x' where id = $1", [someRow.id]), "permission denied");
    await r.denies(`${who} can't DELETE from audit_log`, () => t.as(uid, "delete from audit_log where id = $1", [someRow.id]), "permission denied");
    await r.denies(`${who} can't INSERT into audit_log directly`, () => t.as(uid, "insert into audit_log (action, target_type, target_id) values ('x','x','x')"), "permission denied");
  }
  // Even the database owner is stopped by the trigger (run in rolled-back transactions; only test rows targeted).
  for (const [what, sql] of [
    ["UPDATE", "update audit_log set reason = 'tampered' where id = $1"],
    ["DELETE", "delete from audit_log where id = $1"],
  ] as const) {
    const out = await t.adminRollback(async (q) => {
      try {
        await q(sql, [someRow.id]);
        return "allowed";
      } catch (e) {
        return (e as Error).message;
      }
    });
    r.check(`the database owner can't ${what} audit rows either (audit_log_append_only)`, String(out).includes("audit_log_append_only"), out);
  }
  const trunc = await t.adminRollback(async (q) => {
    try {
      await q("truncate audit_log");
      return "allowed";
    } catch (e) {
      return (e as Error).message;
    }
  });
  r.check("TRUNCATE audit_log is refused (audit_log_append_only)", String(trunc).includes("audit_log_append_only"), trunc);
  const [still] = await t.admin<{ reason: string | null }>("select reason from audit_log where id = $1", [someRow.id]);
  r.check("the audit row is unchanged afterwards", still.reason !== "tampered");

  // ---- drivers see their own tanker's permits, nobody else's
  r.check("a driver reads their own tanker's permits", (await t.as(D7.id, "select id from permits")).length === 2);
  r.check("a driver can't read other tankers' permits", (await t.as(D1.id, "select id from permits where tanker_id = $1", [tk7])).length === 0);
  r.check("a customer reads no permits", (await t.as(C1.id, "select id from permits")).length === 0);
}
