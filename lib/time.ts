// Dates and times as Oman shows them. Every surface displays Asia/Muscat time whatever the
// viewer's browser or phone is set to (a team member in India sees the same clock as the control
// room), and "today" is the Muscat calendar day. Oman is UTC+4 all year (no daylight saving).
// Numbers are not formatted here: toLocaleString on a number is unaffected by the time zone.

export const TZ = "Asia/Muscat";
export const MUSCAT_OFFSET_MS = 4 * 3_600_000;
const DAY = 86_400_000;

type When = string | number | Date | null | undefined;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Format an instant in Muscat time. A plain calendar date ("2026-10-29", e.g. a permit expiry or a
 * date column) is shown as that date, never shifted by a time zone. Empty or invalid → "".
 */
export function fmtOman(v: When, opts: Intl.DateTimeFormatOptions, locale = "en-GB"): string {
  if (v == null || v === "") return "";
  const dateOnly = typeof v === "string" && DATE_ONLY.test(v);
  const d = dateOnly ? new Date(`${v}T00:00:00Z`) : v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: dateOnly ? "UTC" : TZ }).format(d);
}

/** "14:05" (24-hour). */
export const omanTime = (v: When, locale = "en-GB") => fmtOman(v, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, locale);
/** "29 Oct 2026". */
export const omanDate = (v: When, locale = "en-GB") => fmtOman(v, { day: "numeric", month: "short", year: "numeric" }, locale);
/** "29 Oct". */
export const omanDay = (v: When, locale = "en-GB") => fmtOman(v, { day: "numeric", month: "short" }, locale);
/** "29 Oct, 14:05". */
export const omanDateTime = (v: When, locale = "en-GB") =>
  fmtOman(v, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, locale);
/** "29 Oct 2026, 14:05" (exports and print headers). */
export const omanStamp = (v: When, locale = "en-GB") =>
  fmtOman(v, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, locale);

const ms = (v: number | Date | string) => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : v.getTime());

/** The Muscat calendar date ("YYYY-MM-DD") of an instant; `addDays` moves it by whole days. */
export const omanDateKey = (at: number | Date | string = Date.now(), addDays = 0) =>
  new Date(ms(at) + MUSCAT_OFFSET_MS + addDays * DAY).toISOString().slice(0, 10);
/** Today in Muscat as "YYYY-MM-DD" (the value a date input expects). */
export const omanToday = (now: number | Date = Date.now()) => omanDateKey(now);
/** Hour of the day (0–23) in Muscat. */
export const omanHour = (at: number | Date | string = Date.now()) => new Date(ms(at) + MUSCAT_OFFSET_MS).getUTCHours();
/** Day of the week in Muscat (0 = Sunday). */
export const omanWeekday = (at: number | Date | string = Date.now()) => new Date(ms(at) + MUSCAT_OFFSET_MS).getUTCDay();
/** Shift a "YYYY-MM-DD" date by whole days. */
export const addDaysKey = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** 00:00 Muscat on a "YYYY-MM-DD" date, as an ISO instant (for "from" filters). */
export const omanDayStartIso = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - MUSCAT_OFFSET_MS).toISOString();
/** The last millisecond of a Muscat "YYYY-MM-DD" date, as an ISO instant (for "to" filters). */
export const omanDayEndIso = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY - 1 - MUSCAT_OFFSET_MS).toISOString();
