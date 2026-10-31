// Why a driver can't go online, in the order they'd fix it. The database refuses
// driver_set_online for a blocked tanker, a suspended company or no valid permit (the
// online guard, 0008/0015); the app adds today's safety pre-check. Pure, for tests.
import type { PermitState } from "./permit";

/** Permit review stages (permits.stage, 0010), in order: "stage N of 4". */
export const PERMIT_STAGES = ["submitted", "documents", "inspection", "decision"] as const;

export type Blocker =
  | { kind: "blocked"; reason: string | null }
  | { kind: "company" }
  /** 0048: a register tanker claimed without the owner's mobile number waits for NWS. */
  | { kind: "adoption" }
  /** No permit for the tanker's service (`wrong`: only one for another service). */
  | { kind: "permit_none"; wrong: boolean }
  /** An application or renewal is with NWS. */
  | { kind: "permit_pending"; stage: number; stageKey: (typeof PERMIT_STAGES)[number]; info: string | null }
  | { kind: "permit_rejected"; reason: string | null }
  | { kind: "permit_expired"; expiredAt: string }
  | { kind: "check" }
  /** NWS requires the in-app training before going online (app_settings DRIVER_TRAINING_REQUIRED). */
  | { kind: "training"; done: number; total: number }
  /** 0041: an expired vehicle operating card or insurance (the database refuses online and accept). */
  | { kind: "vehicle"; what: ("op_card" | "insurance")[] };

export function onlineBlockers(s: {
  blocked: boolean;
  blockedReason: string | null;
  companySuspended: boolean;
  /** 0048: the tanker's register claim is pending NWS review. */
  adoptionPending?: boolean;
  /** null while the permits are loading (no permit blocker until known). */
  permit: PermitState | null;
  shiftChecked: boolean;
  /** Set only when NWS requires the training: lessons passed out of the total. */
  training?: { done: number; total: number } | null;
  /** The tanker's operating card and insurance expiry dates (YYYY-MM-DD) and today in Muscat. */
  vehicle?: { opCardExpiry: string | null; insuranceExpiry: string | null; today: string } | null;
}): Blocker[] {
  const out: Blocker[] = [];
  if (s.blocked) out.push({ kind: "blocked", reason: s.blockedReason?.trim() || null });
  if (s.companySuspended) out.push({ kind: "company" });
  if (s.adoptionPending) out.push({ kind: "adoption" });
  const p = s.permit;
  if (p && p.key !== "valid" && p.key !== "expiring") {
    if (p.pending) {
      const i = Math.max(0, PERMIT_STAGES.indexOf((p.pending.stage ?? "submitted") as (typeof PERMIT_STAGES)[number]));
      out.push({ kind: "permit_pending", stage: i + 1, stageKey: PERMIT_STAGES[i], info: p.pending.info_requested?.trim() || null });
    } else if (p.key === "rejected") out.push({ kind: "permit_rejected", reason: p.current?.reason?.trim() || null });
    else if (p.key === "expired" && p.current) out.push({ kind: "permit_expired", expiredAt: p.current.expires_at });
    else out.push({ kind: "permit_none", wrong: p.key === "wrong" });
  }
  if (!s.shiftChecked) out.push({ kind: "check" });
  if (s.training && s.training.done < s.training.total) out.push({ kind: "training", ...s.training });
  const v = s.vehicle;
  if (v) {
    const what = [v.opCardExpiry && v.opCardExpiry < v.today ? ("op_card" as const) : null, v.insuranceExpiry && v.insuranceExpiry < v.today ? ("insurance" as const) : null].filter(
      (x): x is "op_card" | "insurance" => x !== null,
    );
    if (what.length) out.push({ kind: "vehicle", what });
  }
  return out;
}
