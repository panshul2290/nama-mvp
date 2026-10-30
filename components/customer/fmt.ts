// Locale-aware display helpers for the customer app. Times are shown in
// Asia/Muscat (the service's time zone) whatever the phone is set to.
import { localDigits, type Lang } from "@/lib/i18n";
import { TZ } from "@/lib/time";

const locale = (l: Lang) => (l === "ar" ? "ar-OM" : "en-GB");

/** 12.345 → "12.345 OMR" / "١٢٫٣٤٥ ر.ع." */
export function omr3(v: string | number | null | undefined, l: Lang): string {
  const s = Number(v ?? 0).toFixed(3);
  return l === "ar" ? `${localDigits(s, l).replace(".", "٫")} ر.ع.` : `${s} OMR`;
}

/** Plain amount without the currency (bill lines). */
export const amt3 = (v: string | number | null | undefined, l: Lang) => {
  const s = Number(v ?? 0).toFixed(3);
  return l === "ar" ? localDigits(s, l).replace(".", "٫") : s;
};

export const nf = (v: number, l: Lang) => localDigits(Math.round(v).toLocaleString("en-US"), l);
export const gal = (v: number, l: Lang) => `${nf(v, l)} ${l === "ar" ? "جالون" : "gal"}`;

const fmt = (iso: string | null | undefined, l: Lang, o: Intl.DateTimeFormatOptions) =>
  iso ? new Intl.DateTimeFormat(locale(l), { timeZone: TZ, ...o }).format(new Date(iso)) : "";

export const dshort = (iso: string | null | undefined, l: Lang) => fmt(iso, l, { day: "numeric", month: "short" });
export const tshort = (iso: string | null | undefined, l: Lang) => fmt(iso, l, { hour: "2-digit", minute: "2-digit" });
export const dtshort = (iso: string | null | undefined, l: Lang) => fmt(iso, l, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** A plain date column ("2026-10-28"), shown without any time-zone shift. */
export const ddate = (d: string | null | undefined, l: Lang) =>
  d ? new Intl.DateTimeFormat(locale(l), { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${d.slice(0, 10)}T00:00:00Z`)) : "";

/** Delivery window from slot_start/slot_end, e.g. "29 Oct · 16:00–18:00". */
export function windowText(start: string | null | undefined, end: string | null | undefined, l: Lang) {
  if (!start) return "";
  return `${dshort(start, l)} · ${tshort(start, l)}${end ? `–${tshort(end, l)}` : ""}`;
}

export const uuid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16));
