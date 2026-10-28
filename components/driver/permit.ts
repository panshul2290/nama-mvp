"use client";

// The tanker's permits (RLS: drivers see only their assigned tanker's) and what they mean for the driver.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { ServiceType } from "@/lib/pricing";

export type PermitRow = { id: string; permit_no: string; type: ServiceType; status: string; issued_at: string; expires_at: string; stage?: string; info_requested?: string | null };
export type PermitState = {
  /** valid | expiring (≤ 30 days) | expired | rejected | wrong (other service) | none */
  key: "valid" | "expiring" | "expired" | "rejected" | "wrong" | "none";
  current: PermitRow | null;
  daysLeft: number | null;
  /** A renewal or application under NWS review. */
  pending: PermitRow | null;
};

const DAY = 86_400_000;

export function permitState(rows: PermitRow[], service: ServiceType, now: number): PermitState {
  const ps = [...rows].sort((a, b) => b.expires_at.localeCompare(a.expires_at));
  const pending = ps.find((p) => p.status === "pending") ?? null;
  const valid = ps.find((p) => p.status === "approved" && p.type === service && Date.parse(p.expires_at) > now);
  if (valid) {
    const daysLeft = Math.ceil((Date.parse(valid.expires_at) - now) / DAY);
    return { key: daysLeft <= 30 ? "expiring" : "valid", current: valid, daysLeft, pending };
  }
  const approved = ps.find((p) => p.status === "approved");
  if (approved && approved.type === service) return { key: "expired", current: approved, daysLeft: null, pending };
  if (approved) return { key: "wrong", current: approved, daysLeft: null, pending };
  const rejected = ps.find((p) => p.status === "rejected");
  return { key: rejected ? "rejected" : "none", current: rejected ?? null, daysLeft: null, pending };
}

export function usePermits(tankerId: string) {
  const [rows, setRows] = useState<PermitRow[] | null>(null);
  const reload = useCallback(() => {
    supabase()
      .from("permits")
      .select("id, permit_no, type, status, issued_at, expires_at, stage, info_requested")
      .eq("tanker_id", tankerId)
      .then(({ data }) => setRows((data ?? []) as PermitRow[]));
  }, [tankerId]);
  useEffect(() => {
    const t = setTimeout(reload, 0);
    return () => clearTimeout(t);
  }, [reload]);
  return { rows, reload };
}
