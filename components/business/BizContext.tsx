"use client";

import { createContext, use } from "react";
import type { PortalProfile } from "@/components/portal/PortalShell";
import type { OrderStatus, OrgRole } from "@/lib/types";
import type { ServiceType } from "@/lib/pricing";

/** public.org_summary(): the organisation row plus credit used and the caller's role. */
export type OrgSummary = {
  id: string;
  name: string;
  cr_no: string;
  /** 0036: the organisation's VAT registration number (OM + 10 digits). */
  vat_number?: string | null;
  segment: "commercial" | "government" | "industrial" | "farm";
  credit_limit: number | string;
  terms_days: number;
  approval_limit: number | string;
  invoicing: "monthly" | "weekly";
  paused: boolean;
  status: "pending" | "active" | "suspended";
  created_at: string;
  credit_used: number | string;
  my_role: OrgRole | null;
  /** F9 (0027): the caller is limited to some sites (empty list = the whole organisation). */
  sites_restricted?: boolean;
  site_ids?: string[];
};

type Ctx = { profile: PortalProfile; org: OrgSummary; reloadOrg: () => void };
const BizCtx = createContext<Ctx | null>(null);

export function BizProvider({ value, children }: { value: Ctx; children: React.ReactNode }) {
  return <BizCtx value={value}>{children}</BizCtx>;
}

export function useBiz() {
  const v = use(BizCtx);
  // i18n-ignore: developer error
  if (!v) throw new Error("useBiz must be used inside the Business portal layout");
  const role = v.org.my_role ?? v.profile.org_role ?? null;
  return {
    ...v,
    role,
    isAdmin: role === "admin",
    canOrder: role === "admin" || role === "site_manager",
    // Invoices cover every site, so members limited to some sites don't see or pay them.
    canPay: (role === "admin" || role === "finance") && !v.org.sites_restricted,
    restricted: Boolean(v.org.sites_restricted),
  };
}

/** English (exports); orgRoleLabel()/segmentLabel() in lib/labels give the viewer's language. */
export const ORG_ROLE_LABEL: Record<OrgRole, string> = { admin: "Account admin", site_manager: "Site manager", finance: "Finance" };
export const SEGMENT_LABEL: Record<OrgSummary["segment"], string> = { commercial: "Commercial", government: "Government", industrial: "Industrial", farm: "Farm" };

/** Org order columns the portal reads (fetched without embeds; joined client-side). */
export type BizOrder = {
  id: string;
  order_no: number;
  service_type: ServiceType;
  gallons: number;
  area: string;
  status: OrderStatus;
  total: string;
  vat: string;
  property_id: string | null;
  contract_id: string | null;
  tanker_id: string | null;
  tanker_plate: string | null;
  driver_name: string | null;
  slot_start: string | null;
  slot_end: string | null;
  slot_label: string | null;
  po_number: string | null;
  driver_note: string | null;
  invoice_id: string | null;
  created_at: string;
  accepted_at: string | null;
  arrived_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  /** Who placed it (site managers may cancel only their own). */
  customer_id: string;
  billing: "prepaid" | "account" | string;
  /** Pro-rata credit for a short delivery (0015); invoices deduct it. */
  short_credit: string | null;
};
export const ORDER_COLS =
  "id, order_no, service_type, gallons, area, status, total, vat, property_id, contract_id, tanker_id, tanker_plate, driver_name, slot_start, slot_end, slot_label, po_number, driver_note, invoice_id, created_at, accepted_at, arrived_at, delivered_at, cancelled_at, cancel_reason, customer_id, billing, short_credit";

export type BizProperty = { id: string; label: string; address: string; area: string; lat: number; lng: number; tank_gal: number; created_at: string };
