"use client";

// How the delivery fee was worked out (quote_order factors, 0026): the base fee and each
// multiplier — evening peak, emergency, distance from the station or plant, and demand in the zone.
import { localDigits } from "@/lib/i18n";
import { useCx } from "./i18n";
import { omr3 } from "./fmt";

export type Factors = {
  base_fee?: number | string | null;
  multiplier?: number | string | null;
  peak_mult?: number | string | null;
  priority_mult?: number | string | null;
  distance_km?: number | string | null;
  distance_mult?: number | string | null;
  demand_ratio?: number | string | null;
  demand_mult?: number | string | null;
  located?: boolean;
};

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));

export function FeeFactors({ factors }: { factors?: Factors | null }) {
  const { t, lang } = useCx();
  if (!factors) return null;
  const x = (m: number) => `× ${localDigits(String(Math.round(m * 1000) / 1000), lang)}`;
  const rows: [string, string][] = [];
  const base = num(factors.base_fee);
  if (base != null) rows.push([t("ffBase"), omr3(base, lang)]);
  const peak = num(factors.peak_mult);
  if (peak != null && peak !== 1) rows.push([t("ffPeak"), x(peak)]);
  const prio = num(factors.priority_mult);
  if (prio != null && prio !== 1) rows.push([t("ffPriority"), x(prio)]);
  const km = num(factors.distance_km);
  const dm = num(factors.distance_mult);
  if (dm != null) rows.push([km != null ? t("ffDistanceKm", { km: localDigits(km.toFixed(1), lang) }) : t("ffDistance"), dm === 1 ? t("ffNone") : x(dm)]);
  const em = num(factors.demand_mult);
  if (em != null) rows.push([t("ffDemand"), em === 1 ? t("ffNone") : x(em)]);
  const total = num(factors.multiplier);
  if (total != null) rows.push([t("ffTotal"), x(total)]);
  if (!rows.length) return null;
  return (
    <details className="ff">
      <summary>{t("ffT")}</summary>
      {rows.map(([k, v]) => (
        <div key={k} className="rq-kv">
          <span>{k}</span>
          <b dir="ltr">{v}</b>
        </div>
      ))}
      {factors.located === false && <p className="mut small">{t("ffNoPoint")}</p>}
    </details>
  );
}
