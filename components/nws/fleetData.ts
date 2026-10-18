// Shared fleet/permit types and the permit summary used by the Fleet and Permits screens.
import { fmtDate } from "@/components/nws/StaffContext";
import type { ServiceType } from "@/lib/pricing";

export type Permit = { id: string; permit_no: string; type: ServiceType; status: "pending" | "approved" | "rejected" | "expired"; issued_at: string; expires_at: string };
export type Assignment = { id: string; driver_id: string; assigned_at: string; unassigned_at: string | null; driver: { full_name: string; phone: string | null } | null };
export type FleetTanker = {
  id: string; plate: string; service_type: ServiceType; capacity_gal: number; is_online: boolean;
  blocked: boolean; blocked_reason: string | null; blocked_at: string | null; location_age_s: number | null;
  assignments: Assignment[]; permits: Permit[];
};

const DAY = 86_400_000;

/** Summarise a tanker's permits the way the database judges them (approved, unexpired, same service type). */
export function permitSummary(t: Pick<FleetTanker, "service_type" | "permits">, now = Date.now()): { text: string; tone: "ok" | "warn" | "bad" | ""; valid: boolean } {
  const ps = [...t.permits].sort((a, b) => b.expires_at.localeCompare(a.expires_at));
  const valid = ps.find((p) => p.status === "approved" && p.type === t.service_type && Date.parse(p.expires_at) > now);
  if (valid) {
    const days = Math.ceil((Date.parse(valid.expires_at) - now) / DAY);
    return days <= 30 ? { text: `Expires in ${days} day${days === 1 ? "" : "s"}`, tone: "warn", valid: true } : { text: `Valid to ${fmtDate(valid.expires_at)}`, tone: "ok", valid: true };
  }
  if (ps.some((p) => p.status === "pending")) return { text: "Pending review", tone: "warn", valid: false };
  if (ps.some((p) => p.status === "approved" && Date.parse(p.expires_at) <= now)) return { text: "Expired", tone: "bad", valid: false };
  if (ps.some((p) => p.status === "rejected")) return { text: "Rejected", tone: "bad", valid: false };
  if (ps.some((p) => p.status === "approved")) return { text: "Wrong service type", tone: "bad", valid: false };
  return { text: "No permit", tone: "bad", valid: false };
}

