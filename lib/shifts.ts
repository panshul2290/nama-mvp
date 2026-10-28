// Driver shift hours (Asia/Muscat), defined once for the company portal and the driver app.

export type Shift = "day" | "evening" | "night";

export const SHIFTS: Record<Shift, { start: string; end: string }> = {
  day: { start: "06:00", end: "14:00" },
  evening: { start: "14:00", end: "22:00" },
  night: { start: "22:00", end: "06:00" },
};

export const SHIFT_KEYS = Object.keys(SHIFTS) as Shift[];

/** "06:00–14:00", or "06–14" when `short`. */
export const shiftHours = (s: Shift, short = false) => {
  const hm = (v: string) => (short ? v.slice(0, 2) : v);
  return `${hm(SHIFTS[s].start)}–${hm(SHIFTS[s].end)}`;
};
