import { supabase } from "@/lib/supabase/client";
import type { ServiceType } from "@/lib/pricing";
import { fetchPaged, sinceIso } from "@/components/nws/admin/ui";

// Report rows. Aggregation is client-side over a capped, date-bounded query
// (fine for demo volumes; a BI extract would replace this in production).

export const ROW_CAP = 5000;

export type ORow = {
  id: string; order_no: number; service_type: ServiceType; gallons: number; area: string; status: string; channel: string;
  zone_id: string | null; tanker_id: string | null; customer_id: string; property_id: string | null; driver_id: string | null;
  driver_name: string | null; org_id: string | null; total: string; created_at: string; released_at: string | null; accepted_at: string | null;
  arrived_at: string | null; delivered_at: string | null; cancelled_at: string | null; slot_end: string | null;
  rating: number | null; rating_comment: string | null; rated_at: string | null; is_emergency: boolean;
};
export const ORDER_COLS =
  "id, order_no, service_type, gallons, area, status, channel, zone_id, tanker_id, customer_id, property_id, driver_id, driver_name, org_id, total, created_at, released_at, accepted_at, arrived_at, delivered_at, cancelled_at, slot_end, rating, rating_comment, rated_at, is_emergency";

export type Ref = {
  zones: Map<string, string>;
  tankerCompany: Map<string, string | null>;
  companies: Map<string, string>;
};

export async function loadRef(): Promise<Ref> {
  const db = supabase();
  const [z, t, c] = await Promise.all([
    db.from("zones").select("id, name"),
    db.from("tankers").select("id, company_id"),
    db.from("companies").select("id, name"),
  ]);
  return {
    zones: new Map((z.data ?? []).map((r: { id: string; name: string }) => [r.id, r.name])),
    tankerCompany: new Map((t.data ?? []).map((r: { id: string; company_id: string | null }) => [r.id, r.company_id])),
    companies: new Map((c.data ?? []).map((r: { id: string; name: string }) => [r.id, r.name])),
  };
}

/** Orders created in the last `days` days (or by `field` timestamp). */
export async function loadOrders(days: number, field: "created_at" | "rated_at" | "delivered_at" = "created_at") {
  const from = sinceIso(days);
  return fetchPaged<ORow>((a, b) => supabase().from("orders").select(ORDER_COLS).gte(field, from).order(field).order("id").range(a, b), ROW_CAP);
}

export const CHANNEL_LABEL: Record<string, string> = { app: "Customer app", call_centre: "Call centre", business: "Business portal", contract: "Contract" };
export const zoneName = (ref: Ref | null, id: string | null) => (id ? (ref?.zones.get(id) ?? "Unknown zone") : "Outside service areas");
export const companyName = (ref: Ref | null, tanker: string | null) => {
  const c = tanker ? ref?.tankerCompany.get(tanker) : null;
  return c ? (ref?.companies.get(c) ?? "Unknown company") : tanker ? "Independent" : "Not assigned";
};

/** On time: arrived before the slot ended, or (unscheduled) delivered within 2 hours of the request. */
export function onTime(o: ORow) {
  if (o.status !== "delivered") return null;
  const done = o.arrived_at ?? o.delivered_at;
  if (!done) return null;
  if (o.slot_end) return new Date(done) <= new Date(o.slot_end);
  return new Date(done).getTime() - new Date(o.released_at ?? o.created_at).getTime() <= 2 * 3600_000;
}

/** Minutes from request (or release of a scheduled order) to acceptance. */
export const assignMinutes = (o: ORow) =>
  o.accepted_at ? (new Date(o.accepted_at).getTime() - new Date(o.released_at ?? o.created_at).getTime()) / 60_000 : null;

export const RANGES: [string, string][] = [["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"]];
