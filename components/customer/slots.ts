// Delivery windows from the prototype (SLOTS), anchored to Asia/Muscat (UTC+4, no DST).
// "As soon as possible" has no slot; is_peak() then prices on the current time.

export type Slot = { id: string; start: string | null; end: string | null; peak: boolean; key: string; label: string };

const MUSCAT_MS = 4 * 3600_000;
const DEFS = [
  { id: "s1", day: 0, from: 16, to: 18, key: "slotS1" },
  { id: "s2", day: 0, from: 18, to: 20, key: "slotS2", peak: true },
  { id: "s3", day: 1, from: 8, to: 10, key: "slotS3" },
  { id: "s4", day: 1, from: 16, to: 18, key: "slotS4" },
];

const muscatDate = (now: number, addDays: number) => new Date(now + MUSCAT_MS + addDays * 86_400_000).toISOString().slice(0, 10);
const at = (date: string, h: number) => `${date}T${String(h).padStart(2, "0")}:00:00+04:00`;
const hh = (h: number) => `${h % 12 || 12}`;
const ampm = (h: number) => (h < 12 ? "am" : "pm");

/** Stored on the order (seen by drivers and NWS), so it names the day rather than "today". */
function storedLabel(start: string, from: number, to: number) {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Muscat", weekday: "short", day: "2-digit", month: "short" }).format(new Date(start));
  return `${day} · ${hh(from)}–${hh(to)} ${ampm(to)}`;
}

/** Windows still open at `now` (a window disappears 30 minutes before it closes). */
export function slotOptions(now: number, withAsap = true): Slot[] {
  const out: Slot[] = withAsap ? [{ id: "now", start: null, end: null, peak: false, key: "slotNow", label: "As soon as possible" }] : [];
  for (const d of DEFS) {
    const date = muscatDate(now, d.day);
    const start = at(date, d.from);
    const end = at(date, d.to);
    if (new Date(end).getTime() - 30 * 60_000 <= now) continue;
    out.push({ id: d.id, start, end, peak: Boolean(d.peak), key: d.key, label: storedLabel(start, d.from, d.to) });
  }
  return out;
}

// ---------------------------------------------------------------- NWS window templates (0044)
export type Window = Slot & { day: string; from: string; to: string; template: string };
type WindowRow = { day: string; template_code: string; starts_at: string; ends_at: string; label: string; peak: boolean };

const hm = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Muscat", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

/** delivery_windows(): the active template's windows for the next `days` days (Ramadan, Eid, blocked prayer times). */
export function windowsFromRows(rows: WindowRow[]): Window[] {
  return rows.map((r) => ({
    id: r.starts_at,
    start: r.starts_at,
    end: r.ends_at,
    peak: r.peak,
    key: "",
    label: r.label,
    day: String(r.day).slice(0, 10),
    from: hm(r.starts_at),
    to: hm(r.ends_at),
    template: r.template_code,
  }));
}
