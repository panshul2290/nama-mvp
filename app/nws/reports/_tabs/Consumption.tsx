"use client";

import { BarList, Donut, PALETTE, SERVICE_COLOR, Sparkline } from "@/components/nws/admin/charts";
import { Empty, Kpi } from "@/components/nws/admin/ui";
import { REPORT_VALUES, REPORTS } from "@/components/nws/i18n/reports";
import { useFmt, type Fmt } from "@/components/portal/i18n";
import { useLang, useT } from "@/lib/i18n";
import { serviceLabel } from "@/lib/labels";
import type { ServiceType } from "@/lib/pricing";
import { ReportState, useReport } from "./report";

const SEGMENT_LABEL: Record<string, string> = { household: "Residential", commercial: "Commercial", farm: "Farms", government: "Government" };

type Pred = { key: string; customer_id: string; name: string | null; property_id: string | null; label: string | null; area: string; due_in: number | null; next_at: string | null };
/** report_consumption (0029): totals over every delivery in range; refill predictions over 180 days. */
type Cons = {
  trips: number; gallons: number; tracked: number; alerts_count: number;
  by_area: { area: string; gallons: number }[];
  by_service: Partial<Record<ServiceType, number>>;
  segments: Record<string, number>;
  top_consumers: { customer_id: string; name: string | null; segment: string | null; trips: number; gallons: number; omr: number }[];
  alerts: (Pred & { avg_days: number; last_at: string })[];
  top_properties: (Pred & { tank_gal: number | null; per_week: number; weeks: number[]; deliveries: number })[];
};

type T = (key: string, vars?: Record<string, string | number>) => string;
const due = (d: number | null, t: T, f: Fmt) =>
  d == null ? <span className="mut">—</span> : d < 0 ? <span className="st bad">{t("overdue", { n: f.n(Math.ceil(-d)) })}</span> : d <= 3 ? <span className="st warn">{t("dueIn", { n: f.n(Math.max(0, Math.round(d))) })}</span> : <span className="st ok">{t("inN", { n: f.n(Math.round(d)) })}</span>;
const place = (p: Pred, t: T) => (p.property_id ? (p.label ?? t("propertyFallback")) : t("noProperty"));

export default function Consumption({ days }: { days: number }) {
  const { data: s, error } = useReport<Cons>("report_consumption", days);
  const t = useT(REPORTS);
  const tv = useT(REPORT_VALUES);
  const f = useFmt();
  const { lang } = useLang();
  if (!s) return <ReportState error={error} what={t("whatCons")} />;
  const total = s.gallons;
  const seg = (k: string | null | undefined) => (k && SEGMENT_LABEL[k] ? tv(SEGMENT_LABEL[k]) : "");

  return (
    <>
      <div className="okpis">
        <Kpi label={t("waterDelivered")} value={f.gal(total)} sub={t("tripsInRange", { n: f.n(s.trips) })} />
        <Kpi label={t("avgPerTrip")} value={s.trips ? f.gal(Math.round(total / s.trips)) : "—"} />
        <Kpi label={t("refillDue")} value={f.n(s.alerts_count)} sub={t("within3")} tone={s.alerts_count ? "warn" : undefined} />
        <Kpi label={t("tracked")} value={f.n(s.tracked)} sub={t("trackedSub")} />
      </div>

      <div className="grid3">
        <div className="panel">
          <h2>{t("byArea")} <small>{t("gallonsSmall")}</small></h2>
          <BarList rows={s.by_area.map((a) => ({ label: a.area, value: a.gallons }))} />
        </div>
        <div className="panel">
          <h2>{t("byService")} <small>{t("gallonsSmall")}</small></h2>
          <Donut
            slices={(["DW", "WW", "TE"] as ServiceType[]).map((sv) => ({ label: serviceLabel(sv, lang), value: s.by_service[sv] ?? 0, color: SERVICE_COLOR[sv] }))}
            center={total >= 1e6 ? t("millionsN", { n: f.n(total / 1e6, 1) }) : t("thousandsN", { n: f.n(total / 1e3) })}
            sub={t("gallonsSmall")}
          />
        </div>
        <div className="panel">
          <h2>{t("segments")} <small>{t("accounts")}</small></h2>
          <Donut slices={Object.entries(s.segments).map(([k, v], i) => ({ label: seg(k) || k, value: v, color: PALETTE[i % PALETTE.length] }))} sub={t("customersSmall")} />
        </div>
      </div>

      <div className="half">
        <div className="panel">
          <h2>{t("topConsumers")} <small>{t("deliveredInRange")}</small></h2>
          <div className="tblwrap">
            <table>
              <thead><tr><th>{t("thCustomer")}</th><th className="num">{t("thTrips")}</th><th className="num">{t("thGallons")}</th><th className="num">{t("thOmr")}</th></tr></thead>
              <tbody>
                {s.top_consumers.length === 0 && <Empty cols={4}>{t("noDeliveries")}</Empty>}
                {s.top_consumers.map((c) => (
                  <tr key={c.customer_id}>
                    <td>{c.name || t("customerFallback")}<small style={{ display: "block" }}>{seg(c.segment)}</small></td>
                    <td className="num">{f.n(c.trips)}</td>
                    <td className="num">{f.n(c.gallons)}</td>
                    <td className="num">{f.n3(c.omr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <h2>{t("predictive")} <small>{t("within3")}</small></h2>
          <div className="tblwrap scroll">
            <table>
              <thead><tr><th>{t("thCustProp")}</th><th className="num">{t("thEvery")}</th><th>{t("thLastDelivery")}</th><th>{t("thExpected")}</th><th>{t("thAlert")}</th></tr></thead>
              <tbody>
                {s.alerts.length === 0 && <Empty cols={5}>{t("noRefills")}</Empty>}
                {s.alerts.map((p) => (
                  <tr key={p.key}>
                    <td>{p.name || t("customerFallback")}<small style={{ display: "block" }}>{place(p, t)} · {p.area}</small></td>
                    <td className="num">{t("daysN", { n: f.n(Number(p.avg_days), 1) })}</td>
                    <td>{f.date(p.last_at)}</td>
                    <td>{p.next_at ? f.date(p.next_at) : "—"}</td>
                    <td>{due(p.due_in, t, f)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">{t("refillNote")}</p>
        </div>
      </div>

      <div className="panel">
        <h2>{t("byProperty")} <small>{t("byPropertySub")}</small></h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr><th>{t("thProperty")}</th><th>{t("thCustomer")}</th><th className="num">{t("thGalWeek")}</th><th>{t("thTrend")}</th><th className="num">{t("thDeliveries")}</th><th>{t("thNextRefill")}</th><th>{t("thAlert")}</th></tr>
            </thead>
            <tbody>
              {s.top_properties.length === 0 && <Empty cols={7}>{t("noHistory")}</Empty>}
              {s.top_properties.map((p) => (
                <tr key={p.key}>
                  <td>{place(p, t)}<small style={{ display: "block" }}>{p.area}{p.tank_gal ? t("tankN", { n: f.gal(p.tank_gal) }) : ""}</small></td>
                  <td>{p.name || t("customerFallback")}</td>
                  <td className="num">{f.n(p.per_week)}</td>
                  <td><Sparkline values={p.weeks.map(Number)} /></td>
                  <td className="num">{f.n(p.deliveries)}</td>
                  <td>{p.next_at ? f.date(p.next_at) : "—"}</td>
                  <td>{due(p.due_in, t, f)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
