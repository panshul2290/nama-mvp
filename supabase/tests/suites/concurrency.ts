// Concurrency: 20 drivers race for one order; one driver races for two orders.
//
// On Supabase each caller has its own Postgres backend and is held at an
// advisory-lock barrier inside its transaction, then all are released at once,
// so the accept_order UPDATEs genuinely overlap. On PGlite (one connection) the
// same calls run one after another — logic check only, labelled as such.
import type { Reporter, Session, Target } from "../lib/harness";
import { giveTanker, placeOrder, plateFor, setOnline, deliver } from "../lib/world";

type Outcome = { ok: boolean; msg: string };

/** Run fn for each uid concurrently, released together from a barrier. Returns outcomes and how many were waiting at release. */
export async function raceFromBarrier(t: Target, uids: string[], sql: (i: number) => [string, unknown[]]): Promise<{ outcomes: Outcome[]; waiting: number }> {
  if (!t.parallel) {
    const outcomes = await Promise.all(
      uids.map((u, i) =>
        t.as(u, ...sql(i)).then(
          () => ({ ok: true, msg: "ok" }),
          (e: Error) => ({ ok: false, msg: e.message }),
        ),
      ),
    );
    return { outcomes, waiting: 0 };
  }
  const key = Math.floor(Math.random() * 1_000_000_000);
  const coordSession = await t.session();
  const coord = await coordSession.begin(uids[0]);
  await coord.query("select pg_advisory_xact_lock($1::bigint)", [key]);
  const sessions: Session[] = [];
  const runs = uids.map(async (u, i) => {
    const s = await t.session();
    sessions.push(s);
    const tx = await s.begin(u);
    try {
      await tx.query("select pg_advisory_xact_lock_shared($1::bigint)", [key]);
      const [q, p] = sql(i);
      await tx.query(q, p);
      await tx.commit();
      return { ok: true, msg: "ok" };
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      return { ok: false, msg: (e as Error).message };
    }
  });
  // Wait until every caller is blocked on the barrier (or the count stops growing).
  let waiting = 0;
  let stableSince = Date.now();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const [row] = await coord.query<{ n: number }>(
      "select count(*)::int as n from pg_locks where locktype = 'advisory' and classid::bigint = 0 and objid::text::bigint = $1::bigint and not granted",
      [key],
    );
    if (row.n !== waiting) {
      waiting = row.n;
      stableSince = Date.now();
    }
    if (waiting >= uids.length || Date.now() - stableSince > 3000) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  await coord.commit(); // releases the barrier: everyone runs at once
  const outcomes = await Promise.all(runs);
  await Promise.all([coordSession, ...sessions].map((s) => s.close()));
  return { outcomes, waiting };
}

export async function concurrencySuite(t: Target, r: Reporter) {
  r.start("RACE concurrency");
  const label = t.parallel ? "concurrent (separate backends, released from a barrier)" : "serialised on PGlite's single connection — logic only, not a race";

  // --- 20 drivers, one order
  const customer = await t.createUser("race-c", { role: "customer", full_name: "Test Race Customer" });
  const drivers = [];
  for (let i = 0; i < 20; i++) {
    const d = await t.createUser(`race-d${i}`, { role: "driver", full_name: `Test Racer ${i}` });
    await giveTanker(t, d.id, plateFor(t, `R${i}`), "DW", 5000);
    await setOnline(t, d.id, true);
    drivers.push(d);
  }
  const order = await placeOrder(t, customer.id, "DW", 1000);
  const { outcomes, waiting } = await raceFromBarrier(t, drivers.map((d) => d.id), () => ["select * from accept_order($1)", [order.id]]);
  const wins = outcomes.filter((o) => o.ok).length;
  const taken = outcomes.filter((o) => !o.ok && o.msg.includes("already_taken")).length;
  const other = outcomes.filter((o) => !o.ok && !o.msg.includes("already_taken")).map((o) => o.msg);
  const note = `${label}${t.parallel ? `; ${waiting} of 20 were blocked at the barrier when it opened` : ""}`;
  r.check("20 drivers call accept_order on the same order at once: exactly 1 succeeds", wins === 1, { wins, taken, other }, note);
  r.check("… and the other 19 get already_taken", taken === 19, { wins, taken, other }, note);
  const winner = drivers[outcomes.findIndex((o) => o.ok)];
  const [row] = await t.admin<{ status: string; driver_id: string }>("select status, driver_id from orders where id = $1", [order.id]);
  r.check("the order row is accepted and belongs to the single winner", row.status === "accepted" && row.driver_id === winner?.id, row);

  // --- one driver, two orders at once (repeated)
  const solo = await t.createUser("race-solo", { role: "driver", full_name: "Test Solo Driver" });
  await giveTanker(t, solo.id, plateFor(t, "SOLO"), "DW", 5000);
  await setOnline(t, solo.id, true);
  const ROUNDS = 5;
  let good = 0;
  const detail: unknown[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const a = await placeOrder(t, customer.id, "DW", 800);
    const b = await placeOrder(t, customer.id, "DW", 800);
    const res = await raceFromBarrier(t, [solo.id, solo.id], (i) => ["select * from accept_order($1)", [i === 0 ? a.id : b.id]]);
    const [act] = await t.admin<{ n: number }>("select count(*)::int as n from orders where driver_id = $1 and status in ('accepted','arriving','arrived')", [solo.id]);
    const okCount = res.outcomes.filter((o) => o.ok).length;
    const busy = res.outcomes.filter((o) => o.msg.includes("driver_busy")).length;
    if (act.n === 1 && okCount === 1 && busy === 1) good++;
    detail.push({ round, active: act.n, ok: okCount, busy, waiting: res.waiting });
    // Finish the job so the next round starts free.
    const [job] = await t.admin<{ id: string }>("select id from orders where driver_id = $1 and status = 'accepted'", [solo.id]);
    if (job) {
      await t.as(solo.id, "select * from mark_arrived($1)", [job.id]);
      await deliver(t, solo.id, job.id);
    }
  }
  r.check(`one driver accepts two orders at once (${ROUNDS} rounds): always exactly one active job; the other call gets driver_busy`, good === ROUNDS, detail, `${label}; per round: ${JSON.stringify(detail)}`);
}
