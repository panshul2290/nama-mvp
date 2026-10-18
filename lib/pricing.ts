// Client-side price preview, computed from public.pricing_rules exactly as
// public.price_quote() does. The database prices every order itself (insert
// trigger); this copy only powers the live quote. No tariff numbers are
// hard-coded here — they all come from the rules table.

export type ServiceType = "DW" | "WW" | "TE";
export type RuleStatus = "confirmed" | "pending_clarification" | "assumption";
export type PricingRule = { rule_key: string; value: string; status: RuleStatus; source: string; notes: string };
export type PricingRules = Record<string, PricingRule>;

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
};

const RANK: Record<RuleStatus, number> = { confirmed: 0, assumption: 1, pending_clarification: 2 };
export const worst = (...s: RuleStatus[]): RuleStatus => s.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "confirmed");

// Rule values are decimals like "0.05"; work in units of 1/10000 so all maths stays integer.
const U = 10_000;
const units = (v: string) => Math.round(Number(v) * U);
// Half away from zero for positives, matching Postgres round(numeric).
const roundDiv = (n: number, d: number) => Math.floor((n * 2 + d) / (2 * d));

export function feeKey(type: ServiceType) {
  return `fee_${type.toLowerCase()}_omr`;
}

export function quote(type: ServiceType, gallons: number, rules: PricingRules): Quote {
  const g = Math.max(0, Math.floor(gallons));
  const rule = (k: string) => {
    const r = rules[k];
    if (!r) throw new Error(`pricing_rule_missing: ${k}`);
    return r;
  };

  let waterRules: string[];
  let waterU: number; // water charge in baisa × U
  if (type === "DW") {
    const thr = Number(rule("dw_tier_threshold_gal").value);
    waterRules = ["dw_tier_threshold_gal", "dw_rate_upto_650"];
    if (g <= thr) {
      waterU = g * units(rule("dw_rate_upto_650").value);
    } else {
      waterRules.push("dw_rate_above_650", "dw_above_650_basis");
      const basis = rule("dw_above_650_basis").value;
      if (basis === "slab") waterU = thr * units(rule("dw_rate_upto_650").value) + (g - thr) * units(rule("dw_rate_above_650").value);
      else if (basis === "whole_volume") waterU = g * units(rule("dw_rate_above_650").value);
      else throw new Error("pricing_rule_invalid: dw_above_650_basis");
    }
  } else {
    const k = type === "WW" ? "ww_rate" : "te_rate";
    waterRules = [k];
    waterU = g * units(rule(k).value);
  }

  const fk = feeKey(type);
  const water = roundDiv(waterU, U);
  const fee = roundDiv(units(rule(fk).value) * 1000, U);
  const vat = roundDiv((water + fee) * units(rule("vat_rate").value), U);
  const driverEarnings = roundDiv(fee * units(rule("driver_share").value), U);

  const ws = worst(...waterRules.map((k) => rule(k).status));
  const fs = rule(fk).status;
  const vs = worst(rule("vat_rate").status, ws, fs);
  return {
    water,
    fee,
    vat,
    total: water + fee + vat,
    driverEarnings,
    status: { water: ws, fee: fs, vat: vs, total: worst(ws, fs, vs), earnings: worst(fs, rule("driver_share").status) },
    rulesUsed: [...waterRules, fk, "vat_rate", "driver_share"],
  };
}

/** Rule value as a plain number (for explanatory copy). */
export const ruleNumber = (rules: PricingRules, k: string) => (rules[k] ? Number(rules[k].value) : NaN);

export const omr = (baisa: number) => `${(baisa / 1000).toFixed(3)} OMR`;

// Postgres numeric(10,3) arrives as a string or number of OMR.
export const omrValue = (v: string | number) => `${Number(v).toFixed(3)} OMR`;
