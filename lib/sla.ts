// The one definition of "on time", shared by every surface (customer, driver,
// company, business and NWS), plus Asia/Muscat day/week boundaries.
//
// On time = the service was done by the deadline:
//   - deadline: the end of the booked slot, or — for as-soon-as-possible orders —
//     ASAP_MINUTES after the order was released to drivers (scheduled orders) or placed;
//   - done: delivered (drinking water, treated effluent) or collected (wastewater;
//     the later discharge at the treatment plant is not part of the customer SLA).

export const ASAP_MINUTES = 120;

const MIN = 60_000;
const DAY = 86_400_000;
const MUSCAT_OFFSET = 4 * 3_600_000; // UTC+4 all year (no DST)

export type SlaOrder = {
  service_type: string;
  slot_end?: string | null;
  released_at?: string | null;
  created_at: string;
  delivered_at?: string | null;
  collected_at?: string | null;
};

/** When the order should have been served by (epoch ms). */
export function slaDue(o: Pick<SlaOrder, "slot_end" | "released_at" | "created_at">): number {
  return o.slot_end ? Date.parse(o.slot_end) : Date.parse(o.released_at ?? o.created_at) + ASAP_MINUTES * MIN;
}

/** When the service was done: collected for wastewater, delivered otherwise. */
export function servedAt(o: SlaOrder): string | null {
  return (o.service_type === "WW" ? (o.collected_at ?? o.delivered_at) : o.delivered_at) ?? null;
}

/** true/false once served; null while the order is still open (or was cancelled). */
export function isOnTime(o: SlaOrder): boolean | null {
  const at = servedAt(o);
  return at ? Date.parse(at) <= slaDue(o) : null;
}

/** Start of the Muscat calendar day containing `at`. */
export function muscatDayStart(at: number | Date = Date.now()): Date {
  const t = typeof at === "number" ? at : at.getTime();
  return new Date(Math.floor((t + MUSCAT_OFFSET) / DAY) * DAY - MUSCAT_OFFSET);
}

/** Start of the Muscat working week (Sunday) containing `at`. */
export function muscatWeekStart(at: number | Date = Date.now()): Date {
  const d = muscatDayStart(at);
  const weekday = new Date(d.getTime() + MUSCAT_OFFSET).getUTCDay();
  return new Date(d.getTime() - weekday * DAY);
}
