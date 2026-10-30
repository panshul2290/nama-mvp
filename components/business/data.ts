// Business portal helpers: slot windows (Asia/Muscat), ETA text and labels.
import { distanceKm } from "@/lib/geo";
import { slaDue } from "@/lib/sla";
import { localDigits, type Lang } from "@/lib/i18n";
import { fmtOman, omanLocale, omanTime, omanToday } from "@/lib/time";
import type { OrderStatus } from "@/lib/types";

export type WindowKey = "morning" | "afternoon" | "evening";
// English labels (also stored as orders.slot_label); the screens show BIZ wMorning/wAfternoon/wEvening.
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

/** A booked window in the viewer's language, e.g. "Thu, 29 Oct · 06:00–10:00" (the stored slot_label is English). */
export function slotText(start: string | null | undefined, end: string | null | undefined, lang: Lang): string {
  if (!start) return "";
  const loc = omanLocale(lang);
  const day = fmtOman(start, { weekday: "short", day: "numeric", month: "short" }, loc);
  return `${day} · ${omanTime(start, loc)}${end ? `–${omanTime(end, loc)}` : ""}`;
}

const ETA: Record<Lang, { at: string; col: string; asg: string; m: string; km: string; away: string }> = {
  en: { at: "At the site", col: "Collected — on the way to the plant", asg: "Tanker assigned", m: "m", km: "km", away: "{d} away · about {min} min" },
  ar: { at: "في الموقع", col: "تم السحب — في الطريق إلى المحطة", asg: "تم تعيين الصهريج", m: "م", km: "كم", away: "على بُعد {d} · نحو {min} دقيقة" },
};

/** Rough ETA from the tanker's last fix to the site at ~30 km/h in town. */
export function etaText(tanker: { lat: number | null; lng: number | null } | null, site: { lat: number; lng: number } | null, status: OrderStatus, lang: Lang = "en"): string {
  const w = ETA[lang];
  if (status === "arrived") return w.at;
  if (status === "collected") return w.col;
  if (!tanker || tanker.lat == null || tanker.lng == null || !site) return status === "accepted" ? w.asg : "—";
  const km = distanceKm({ lat: tanker.lat, lng: tanker.lng }, site);
  const min = Math.max(1, Math.round((km / 30) * 60));
  const d = km < 1 ? `${localDigits(Math.round(km * 1000), lang)} ${w.m}` : `${localDigits(km.toFixed(1), lang)} ${w.km}`;
  return w.away.replace("{d}", d).replace("{min}", localDigits(min, lang));
}

export const OPEN: OrderStatus[] = ["pending_approval", "scheduled", "requested", "accepted", "arriving", "arrived", "collected"];
export const TRACKABLE: OrderStatus[] = ["accepted", "arriving", "arrived", "collected"];

/** English (exports); freqLabel() in lib/labels gives the viewer's language. */
export const FREQ_LABEL = { weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly" } as const;


/** When an order should have been served by (lib/sla): the slot end, or 2 h after it was released/placed. */
export const dueBy = slaDue;
