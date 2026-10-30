// Complaint status as customers and businesses see it (#33): received → in review →
// resolved, with an "escalated to 1442" step when the customer escalated (0039), and the
// promised answer time from the case's SLA (complaint_sla hours, frozen on the case as
// sla_hours / due_at). Shared by the customer app and the Business portal.
import type { Complaint } from "@/lib/types";

export const NAMA_1442 = "1442";

export type CaseStepKey = "received" | "review" | "escalated" | "resolved";
export type CaseStep = { key: CaseStepKey; at: string | null; done: boolean; current: boolean };

export function caseSteps(c: Pick<Complaint, "state" | "created_at" | "resolved_at" | "escalated_at">): CaseStep[] {
  const resolved = c.state === "resolved";
  const steps: CaseStep[] = [
    { key: "received", at: c.created_at, done: true, current: c.state === "new" },
    { key: "review", at: null, done: c.state !== "new", current: c.state === "assigned" },
  ];
  if (c.escalated_at || c.state === "escalated") steps.push({ key: "escalated", at: c.escalated_at ?? null, done: true, current: c.state === "escalated" });
  steps.push({ key: "resolved", at: resolved ? c.resolved_at : null, done: resolved, current: resolved });
  return steps;
}

/** The answer promise: open and on time, open and late, or answered within / after it. */
export function casePromise(c: Pick<Complaint, "state" | "due_at" | "resolved_at" | "sla_hours">, now: number) {
  const due = Date.parse(c.due_at);
  if (c.state === "resolved") return { kind: c.resolved_at && Date.parse(c.resolved_at) <= due ? ("met" as const) : ("missed" as const), hours: c.sla_hours, due: c.due_at };
  return { kind: now > due ? ("late" as const) : ("open" as const), hours: c.sla_hours, due: c.due_at };
}

/** The customer (or business) can escalate once; a resolved case can be escalated again to reopen it. */
export const canEscalate = (c: Pick<Complaint, "state" | "escalated_by">) => !(c.state === "escalated" && c.escalated_by === "customer");
