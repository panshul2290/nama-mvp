import { supabase } from "@/lib/supabase/client";
import type { ServiceType } from "@/lib/pricing";
import { fetchPaged, sinceIso } from "@/components/nws/admin/ui";
import { isOnTime } from "@/lib/sla";

// Report rows for the report builder's exports (Builder.tsx). The Operations, Consumption
// and Feedback tabs are aggregated in the database instead (0029, report.tsx), and BI tools
// read GET /api/v1/reports/{dataset}. Test-zone orders (0020, is_test) are never part of a report.

export const ROW_CAP = 5000;

export type ORow = {
  id: string; order_no: number; service_type: ServiceType; gallons: number; area: string; status: string; channel: string;
  zone_id: string | null; tanker_id: string | null; customer_id: string; property_id: string | null; driver_id: string | null;
  driver_name: string | null; org_id: string | null; total: string; created_at: string; released_at: string | null; accepted_at: string | null;
  arrived_at: string | null; collected_at: string | null; delivered_at: string | null; cancelled_at: string | null; slot_end: string | null;
  rating: number | null; rating_comment: string | null; rated_at: string | null; is_emergency: boolean;
};
export const ORDER_COLS =
  "id, order_no, service_type, gallons, area, status, channel, zone_id, tanker_id, customer_id, property_id, driver_id, driver_name, org_id, total, created_at, released_at, accepted_at, arrived_at, collected_at, delivered_at, cancelled_at, slot_end, rating, rating_comment, rated_at, is_emergency";

export type Ref = {
  zones: Map<string, string>;
  tankerCompany: Map<string, string | null>;
  companies: Map<string, string>;
};

export async function loadRef(): Promise<Ref> {
  const db = supabase();
  const [z, t, c] = await Promise.all([
    db.from("zones").select("id, name"),
    // Only tankers with a company matter here (an order's company); the register's ~11,000
    // offline tankers have none, so they never exceed PostgREST's 1,000-row page.
    db.from("tankers").select("id, company_id").not("company_id", "is", null).limit(10000),
    db.from("companies").select("id, name"),
  ]);
  return {
    zones: new Map((z.data ?? []).map((r: { id: string; name: string }) => [r.id, r.name])),
    tankerCompany: new Map((t.data ?? []).map((r: { id: string; company_id: string | null }) => [r.id, r.company_id])),
    companies: new Map((c.data ?? []).map((r: { id: string; name: string }) => [r.id, r.name])),
  };
}

/** Orders created in the last `days` days (or by `field` timestamp), newest first; `truncated` past ROW_CAP. */
export async function loadOrders(days: number, field: "created_at" | "rated_at" | "delivered_at" = "created_at") {
  const from = sinceIso(days);
  return fetchPaged<ORow>((a, b) => supabase().from("orders").select(ORDER_COLS).eq("is_test", false).gte(field, from).order(field, { ascending: false }).order("id").range(a, b), ROW_CAP);
}

export const CHANNEL_LABEL: Record<string, string> = { app: "Customer app", call_centre: "Call centre", business: "Business portal", contract: "Contract" };
export const zoneName = (ref: Ref | null, id: string | null) => (id ? (ref?.zones.get(id) ?? "Unknown zone") : "Outside service areas");
export const companyName = (ref: Ref | null, tanker: string | null) => {
  const c = tanker ? ref?.tankerCompany.get(tanker) : null;
  return c ? (ref?.companies.get(c) ?? "Unknown company") : tanker ? "Independent" : "Not assigned";
};

/** On time: the shared definition in lib/sla (served by the slot end, or within 2 h for ASAP orders). */
export const onTime = (o: ORow) => isOnTime(o);

/** Minutes from request (or release of a scheduled order) to acceptance. */
export const assignMinutes = (o: ORow) =>
  o.accepted_at ? (new Date(o.accepted_at).getTime() - new Date(o.released_at ?? o.created_at).getTime()) / 60_000 : null;

export const RANGES: [string, string][] = [["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"]];
