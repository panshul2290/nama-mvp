// Business portal helpers: slot windows (Asia/Muscat), ETA text and labels.
import { distanceKm } from "@/lib/geo";
import { slaDue } from "@/lib/sla";
import { fmtOman, omanToday } from "@/lib/time";
import type { OrderStatus } from "@/lib/types";

export type WindowKey = "morning" | "afternoon" | "evening";
export const WINDOWS: Record<WindowKey, { label: string; start: string; end: string; text: string }> = {
  morning: { label: "Morning · 6–10 am", start: "06:00", end: "10:00", text: "6–10 am" },
  afternoon: { label: "Afternoon · 12–4 pm", start: "12:00", end: "16:00", text: "12–4 pm" },
  evening: { label: "Evening · 6–8 pm", start: "18:00", end: "20:00", text: "6–8 pm" },
};

/** Today's date in Muscat as YYYY-MM-DD. */
export function muscatToday(now = new Date()): string {
  return omanToday(now);
}

/** Slot start/end as ISO strings with the Muscat offset (+04:00, no DST) and a label. */
export function slotFor(date: string, w: WindowKey) {
  const win = WINDOWS[w];
  const start = `${date}T${win.start}:00+04:00`;
  const end = `${date}T${win.end}:00+04:00`;
  const day = fmtOman(date, { weekday: "short", day: "numeric", month: "short" });
  return { start, end, label: `${day} · ${win.text}` };
}

/** Rough ETA from the tanker's last fix to the site at ~30 km/h in town. */
export function etaText(tanker: { lat: number | null; lng: number | null } | null, site: { lat: number; lng: number } | null, status: OrderStatus): string {
  if (status === "arrived") return "At the site";
  if (status === "collected") return "Collected — on the way to the plant";
  if (!tanker || tanker.lat == null || tanker.lng == null || !site) return status === "accepted" ? "Tanker assigned" : "—";
  const km = distanceKm({ lat: tanker.lat, lng: tanker.lng }, site);
  const min = Math.max(1, Math.round((km / 30) * 60));
  return `${km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`} away · about ${min} min`;
}

export const OPEN: OrderStatus[] = ["pending_approval", "scheduled", "requested", "accepted", "arriving", "arrived", "collected"];
export const TRACKABLE: OrderStatus[] = ["accepted", "arriving", "arrived", "collected"];

export const FREQ_LABEL = { weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly" } as const;


/** When an order should have been served by (lib/sla): the slot end, or 2 h after it was released/placed. */
export const dueBy = slaDue;
