// One set of status labels and tones for the web portals (NWS, Company, Business), so the same
// penalty, contract, permit stage or invitation reads the same everywhere. The phone apps have
// their own English/Arabic wording (components/customer/i18n.ts, components/driver/i18n.ts) and
// follow the same tones.
import type { Invitation, Penalty } from "./types";

export type Tone = "ok" | "warn" | "bad" | "act" | "";

/** Penalty states: issued (deducted, can be disputed), disputed (NWS deciding), upheld, cancelled (refunded). */
export const PENALTY_STATE: Record<Penalty["state"], [string, Tone]> = {
  issued: ["Issued", "warn"],
  disputed: ["Disputed — NWS reviewing", "act"],
  upheld: ["Upheld", "bad"],
  cancelled: ["Cancelled", ""],
};

/** Contract status; the tanker company sees an offer as waiting for its own decision. */
const CONTRACT: Record<string, [string, Tone]> = {
  pending_owner: ["Awaiting the tanker company", "warn"],
  active: ["Active", "ok"],
  paused: ["Paused", "warn"],
  ended: ["Ended", ""],
  declined: ["Declined", "bad"],
};
export function contractStatus(status: string, viewer: "company" | "other" = "other"): [string, Tone] {
  if (status === "pending_owner" && viewer === "company") return ["Awaiting your decision", "warn"];
  return CONTRACT[status] ?? [status, ""];
}

/** Permit application stages, in order. */
export const PERMIT_STAGE: Record<string, string> = { submitted: "Submitted", documents: "Document check", inspection: "Inspection", decision: "Decision" };

/** Invitations (company → driver, organisation → member); a pending one past its date is expired. */
export function invitationStatus(i: Pick<Invitation, "status" | "expires_at">, now = Date.now()): [string, Tone] {
  if (i.status === "pending") return Date.parse(i.expires_at) < now ? ["Expired", "bad"] : ["Pending", "act"];
  return i.status === "accepted" ? ["Accepted", "ok"] : i.status === "declined" ? ["Declined", "bad"] : ["Revoked", ""];
}
