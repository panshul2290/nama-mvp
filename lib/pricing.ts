// Client-side price preview, computed from public.pricing_rules, public.tariff_classes and
// public.delivery_charges exactly as public.price_quote() / price_base() do (0034). The
// database prices every order itself (insert trigger); this copy only mirrors it, and the
// tests check that the two agree. No tariff numbers are hard-coded here: they all come from
// those tables.

export type ServiceType = "DW" | "WW" | "TE";
export type RuleStatus = "confirmed" | "pending_clarification" | "assumption";
export type PricingRule = { rule_key: string; value: string; status: RuleStatus; source: string; notes: string };
export type PricingRules = Record<string, PricingRule>;
/** A water tariff class (0034): service and tanker capacity range, baisa per gallon. */
export type TariffClass = {
  id: string;
  service_type: ServiceType;
  code: string;
  min_gal: number;
  max_gal: number | null;
  rate_baisa: string | number;
  status: RuleStatus;
  source: string;
  notes?: string;
  active: boolean;
  updated_at?: string;
};
/** A delivery charge (0034): per zone (null = the default for every zone) and capacity class, in OMR. */
export type DeliveryCharge = {
  id: string;
  zone_id: string | null;
  service_type: ServiceType;
  class_id: string;
  amount_omr: string | number;
  status: RuleStatus;
  source: string;
  notes?: string;
  updated_at?: string;
};
export type Tariff = { classes: TariffClass[]; charges: DeliveryCharge[] };

export const SERVICE_LABEL: Record<ServiceType, string> = {
  DW: "Drinking water",
  WW: "Wastewater",
  TE: "Treated effluent",
};

export const VOLUME_PRESETS: Record<ServiceType, number[]> = {
  DW: [650, 1000, 3000, 5000],
  WW: [1000, 3000, 5000],
  TE: [3000, 5000, 10000],
};

export type Quote = {
  water: number; // amounts in baisa (integer)
  fee: number;
  vat: number;
  total: number;
  driverEarnings: number;
  status: { water: RuleStatus; fee: RuleStatus; vat: RuleStatus; total: RuleStatus; earnings: RuleStatus };
  rulesUsed: string[];
  /** The class the volume falls in, and the delivery charge applied (the zone's or the default). */
  classCode: string;
  chargeId: string;
};

const RANK: Record<RuleStatus, number> = { confirmed: 0, assumption: 1, pending_clarification: 2 };
export const worst = (...s: RuleStatus[]): RuleStatus => s.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "confirmed");

// Rates are decimals like "0.05"; work in units of 1/10000 so all maths stays integer.
const U = 10_000;
const units = (v: string | number) => Math.round(Number(v) * U);
// Half away from zero for positives, matching Postgres round(numeric).
const roundDiv = (n: number, d: number) => Math.floor((n * 2 + d) / (2 * d));

/** The active class of a service that a volume falls in (the tanker that will be sent). */
export function classFor(type: ServiceType, gallons: number, classes: TariffClass[]): TariffClass | undefined {
  return classes
    .filter((c) => c.service_type === type && c.active && gallons >= c.min_gal && (c.max_gal == null || gallons <= c.max_gal))
    .sort((a, b) => b.min_gal - a.min_gal)[0];
}

/** The delivery charge of a class in a zone, else its default (zone_id null). */
export function chargeFor(classId: string, zoneId: string | null, charges: DeliveryCharge[]): DeliveryCharge | undefined {
  const own = zoneId ? charges.find((d) => d.class_id === classId && d.zone_id === zoneId) : undefined;
  return own ?? charges.find((d) => d.class_id === classId && d.zone_id == null);
}

export function quote(type: ServiceType, gallons: number, rules: PricingRules, tariff: Tariff, zoneId: string | null = null): Quote {
  const g = Math.max(0, Math.floor(gallons));
  const rule = (k: string) => {
    const r = rules[k];
    if (!r) throw new Error(`pricing_rule_missing: ${k}`);
    return r;
  };
  const c = classFor(type, g, tariff.classes);
  if (!c) throw new Error(`tariff_class_missing: ${type} ${g}`);
  const active = tariff.classes.filter((x) => x.service_type === type && x.active).sort((a, b) => a.min_gal - b.min_gal);

  const used: string[] = [];
  let ws: RuleStatus = c.status;
  let waterU: number; // water charge in baisa × U
  if (active.some((x) => x.min_gal < c.min_gal)) {
    // Above the service's first class: slab or whole volume (Q05).
    const basis = rule("tariff_basis");
    used.push("tariff_basis");
    ws = worst(ws, basis.status);
    if (basis.value === "slab") {
      waterU = 0;
      for (const s of active.filter((x) => x.min_gal <= g)) {
        waterU += (Math.min(g, s.max_gal ?? g) - s.min_gal + 1) * units(s.rate_baisa);
        ws = worst(ws, s.status);
      }
    } else if (basis.value === "whole_volume") waterU = g * units(c.rate_baisa);
    else throw new Error("pricing_rule_invalid: tariff_basis");
  } else {
    waterU = g * units(c.rate_baisa);
  }

  const d = chargeFor(c.id, zoneId, tariff.charges);
  if (!d) throw new Error(`delivery_charge_missing: ${type} ${c.code}`);
  const water = roundDiv(waterU, U);
  const fee = roundDiv(units(d.amount_omr) * 1000, U);
  const vat = roundDiv((water + fee) * units(rule("vat_rate").value), U);
  const driverEarnings = roundDiv(fee * units(rule("driver_share").value), U);

  const fs = d.status;
  const vs = worst(rule("vat_rate").status, ws, fs);
  return {
    water,
    fee,
    vat,
    total: water + fee + vat,
    driverEarnings,
    status: { water: ws, fee: fs, vat: vs, total: worst(ws, fs, vs), earnings: worst(fs, rule("driver_share").status) },
    rulesUsed: [...used, "vat_rate", "driver_share"],
    classCode: c.code,
    chargeId: d.id,
  };
}

/** A class's capacity range, digits only ("1–650", "651+"); screens localise the digits. */
export const classRange = (c: Pick<TariffClass, "min_gal" | "max_gal">) => (c.max_gal == null ? `${c.min_gal}+` : `${c.min_gal}–${c.max_gal}`);

/** Rule value as a plain number (for explanatory copy). */
export const ruleNumber = (rules: PricingRules, k: string) => (rules[k] ? Number(rules[k].value) : NaN);

export const omr = (baisa: number) => `${(baisa / 1000).toFixed(3)} OMR`;

// Postgres numeric(10,3) arrives as a string or number of OMR.
export const omrValue = (v: string | number) => `${Number(v).toFixed(3)} OMR`;
