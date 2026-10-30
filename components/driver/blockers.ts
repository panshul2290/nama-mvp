// Why a driver can't go online, in the order they'd fix it. The database refuses
// driver_set_online for a blocked tanker, a suspended company or no valid permit (the
// online guard, 0008/0015); the app adds today's safety pre-check. Pure, for tests.
import type { PermitState } from "./permit";

/** Permit review stages (permits.stage, 0010), in order: "stage N of 4". */
export const PERMIT_STAGES = ["submitted", "documents", "inspection", "decision"] as const;

export type Blocker =
  | { kind: "blocked"; reason: string | null }
  | { kind: "company" }
  /** No permit for the tanker's service (`wrong`: only one for another service). */
  | { kind: "permit_none"; wrong: boolean }
  /** An application or renewal is with NWS. */
  | { kind: "permit_pending"; stage: number; stageKey: (typeof PERMIT_STAGES)[number]; info: string | null }
  | { kind: "permit_rejected"; reason: string | null }
  | { kind: "permit_expired"; expiredAt: string }
  | { kind: "check" };

export function onlineBlockers(s: {
  blocked: boolean;
  blockedReason: string | null;
  companySuspended: boolean;
  /** null while the permits are loading (no permit blocker until known). */
  permit: PermitState | null;
  shiftChecked: boolean;
}): Blocker[] {
  const out: Blocker[] = [];
  if (s.blocked) out.push({ kind: "blocked", reason: s.blockedReason?.trim() || null });
  if (s.companySuspended) out.push({ kind: "company" });
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
  return out;
}
