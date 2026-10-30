// Smart recommendations for households (E11): what tanker size to order and how often, from
// the property's tank capacity, the household size (when the customer gave it) and their past
// deliveries. Pure, unit-tested in tests/unit/recommend.test.ts.
import { VOLUME_PRESETS, type ServiceType } from "./pricing";

/** Drinking water per person per day (gal) — an assumption (≈ 150 L), to be confirmed with NWS consumption data. */
export const GAL_PER_PERSON_DAY = 40;
const DAY = 86_400_000;

export type PastOrder = { service_type: string; gallons: number; delivered_at: string | null; property_id?: string | null };
export type RecoInput = {
  service: ServiceType;
  /** The property's tank (gal), when it has one on file. */
  tankGal?: number | null;
  /** People living there, when known. */
  household?: number | null;
  /** Delivered orders (any order; filtered here). */
  history: PastOrder[];
  /** Only this property's deliveries count (null: deliveries to a dropped pin). */
  propertyId?: string | null;
};
export type Basis = "history" | "household" | "tank" | "default";
export type Reco = {
  gallons: number;
  /** Suggested days between deliveries; null when there's nothing to base it on. */
  everyDays: number | null;
  basis: Basis;
  /** How many past deliveries the suggestion used. */
  orders: number;
  /** Daily use behind a household-size suggestion (gal). */
  perDay?: number;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The smallest preset that covers `need`, without overflowing the tank when one is known. */
export function fitPreset(service: ServiceType, need: number, tankGal?: number | null): number {
  const presets = VOLUME_PRESETS[service];
  const fits = tankGal && tankGal > 0 ? presets.filter((p) => p <= tankGal) : presets;
  const pool = fits.length ? fits : [presets[0]];
  return pool.find((p) => p >= need) ?? pool[pool.length - 1];
}

/** Days → the nearest contract frequency. */
export const contractFrequency = (days: number): "weekly" | "biweekly" | "monthly" => (days <= 10 ? "weekly" : days <= 21 ? "biweekly" : "monthly");

export function recommend(i: RecoInput): Reco {
  const past = i.history
    .filter((o) => o.service_type === i.service && o.delivered_at && (i.propertyId === undefined || (o.property_id ?? null) === (i.propertyId ?? null)))
    .map((o) => ({ g: o.gallons, at: Date.parse(o.delivered_at as string) }))
    .filter((o) => Number.isFinite(o.at))
    .sort((a, b) => b.at - a.at)
    .slice(0, 8);
  const tank = i.tankGal && i.tankGal > 0 ? i.tankGal : null;

  // Past orders: the usual volume and the usual gap between deliveries.
  if (past.length >= 2) {
    const gaps = past.slice(1).map((o, k) => (past[k].at - o.at) / DAY).filter((d) => d >= 0.5);
    const days = gaps.length ? Math.max(1, Math.round(median(gaps))) : null;
    return { gallons: fitPreset(i.service, median(past.map((o) => o.g)), tank), everyDays: days, basis: "history", orders: past.length };
  }

  if (i.service === "DW") {
    const people = i.household && i.household > 0 ? Math.min(Math.round(i.household), 50) : null;
    if (people) {
      const perDay = people * GAL_PER_PERSON_DAY;
      // A week's water, or what the tank holds when that's less.
      const gallons = fitPreset("DW", Math.min(perDay * 7, tank ?? Infinity), tank);
      return { gallons, everyDays: Math.max(1, Math.min(30, Math.floor(gallons / perDay))), basis: "household", orders: past.length, perDay };
    }
    if (tank) return { gallons: Math.min(tank, 5000), everyDays: null, basis: "tank", orders: past.length };
    return { gallons: 3000, everyDays: null, basis: "default", orders: past.length };
  }
  if (past.length === 1) return { gallons: fitPreset(i.service, past[0].g, tank), everyDays: null, basis: "history", orders: 1 };
  return { gallons: i.service === "WW" ? 3000 : 10000, everyDays: null, basis: "default", orders: 0 };
}
