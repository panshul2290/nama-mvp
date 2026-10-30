"use client";

import { BarList, Donut, LineChart, SERVICE_COLOR } from "@/components/nws/admin/charts";
import { dayKeys, Kpi } from "@/components/nws/admin/ui";
import { REPORT_VALUES, REPORTS } from "@/components/nws/i18n/reports";
import { useFmt } from "@/components/portal/i18n";
import { useLang, useT } from "@/lib/i18n";
import { serviceLabel } from "@/lib/labels";
import type { ServiceType } from "@/lib/pricing";
import { CHANNEL_LABEL } from "./data";
import { ReportState, useReport } from "./report";

const SERVICES: ServiceType[] = ["DW", "WW", "TE"];
// Annual trips in the tender's tables; drinking water is still to be confirmed by NWS.
const TENDER_ANNUAL: Record<ServiceType, number | null> = { DW: null, WW: 718745, TE: 77668 };

/** report_operations (0029): counted in the database over every order in range. */
type Ops = {
  placed: number; delivered: number; cancelled: number; on_time: number; timed: number; median_assign_min: number | null;
  per_day: { day: string; service_type: ServiceType; n: number }[];
  by_service: Partial<Record<ServiceType, number>>;
  by_zone: { zone: string; n: number; on_time: number; timed: number }[];
  by_channel: { channel: string; n: number }[];
  year: Record<ServiceType, number>;
};

export default function Operations({ days }: { days: number }) {
  const { data: s, error } = useReport<Ops>("report_operations", days);
  const t = useT(REPORTS);
  const tv = useT(REPORT_VALUES);
  const f = useFmt();
  const { lang } = useLang();
  if (!s) return <ReportState error={error} what={t("whatOps")} />;

  const keys = dayKeys(days);
  const at = new Map(s.per_day.map((d) => [`${d.day}|${d.service_type}`, d.n]));
  const series = SERVICES.map((sv) => ({ name: serviceLabel(sv, lang), color: SERVICE_COLOR[sv], values: keys.map((k) => at.get(`${k}|${sv}`) ?? 0) }));
  const total = { name: t("allTrips"), color: "var(--accent)", values: keys.map((_, i) => series.reduce((a, x) => a + (x.values[i] ?? 0), 0)) };
  const onPct = s.timed ? s.on_time / s.timed : null;
  const assign = s.median_assign_min;

  return (
    <>
      <div className="okpis">
        <Kpi label={t("tripsCompleted")} value={f.n(s.delivered)} sub={t("ofPlaced", { n: f.n(s.placed) })} />
        <Kpi label={t("onTimeDelivery")} value={onPct == null ? "—" : f.pct(onPct)} sub={t("onTimeSub")} tone={onPct == null ? undefined : onPct >= 0.9 ? "ok" : "warn"} />
        <Kpi label={t("medianAssign")} value={assign == null ? "—" : assign < 60 ? t("minN", { n: f.n(assign) }) : t("hoursN", { n: f.n(assign / 60, 1) })} sub={t("medianAssignSub")} />
        <Kpi label={t("cancellations")} value={f.n(s.cancelled)} sub={s.placed ? t("pctOfOrders", { p: f.pct(s.cancelled / s.placed) }) : "—"} tone={s.placed && s.cancelled / s.placed > 0.1 ? "bad" : undefined} />
      </div>

      <div className="panel">
        <h2>{t("tripsPerDay")} <small>{t("tripsPerDaySub")}</small></h2>
        <LineChart labels={keys.map((k) => f.day(k))} series={[total, ...series]} />
      </div>

      <div className="grid3">
        <div className="panel">
          <h2>{t("tripsByService")}</h2>
          <Donut slices={SERVICES.map((sv) => ({ label: serviceLabel(sv, lang), value: s.by_service[sv] ?? 0, color: SERVICE_COLOR[sv] }))} sub={t("trips")} />
        </div>
        <div className="panel">
          <h2>{t("tripsByZone")}</h2>
          <BarList rows={s.by_zone.map((z) => ({ label: tv(z.zone), value: z.n, key: z.zone }))} />
        </div>
        <div className="panel">
          <h2>{t("ordersByChannel")}</h2>
          <BarList rows={s.by_channel.map((c) => ({ label: tv(CHANNEL_LABEL[c.channel] ?? c.channel), value: c.n, key: c.channel }))} />
        </div>
      </div>

      <div className="half">
        <div className="panel">
          <h2>{t("withinSlot")} <small>{t("byZone")}</small></h2>
          <BarList
            max={100}
            fmt={(v) => f.pct(v / 100)}
            rows={s.by_zone.filter((z) => z.timed > 0).sort((a, b) => b.on_time / b.timed - a.on_time / a.timed).map((z) => ({ label: tv(z.zone), key: z.zone, value: (z.on_time / z.timed) * 100, color: z.on_time / z.timed >= 0.9 ? "var(--ok)" : "var(--warn)" }))}
          />
        </div>
        <div className="panel">
          <h2>{t("annualTrips")} <small>{t("tenderFigures")}</small></h2>
          <BarList
            max={TENDER_ANNUAL.WW!}
            fmt={(v) => (v >= 1e6 ? t("millionsN", { n: f.n(v / 1e6, 1) }) : t("thousandsN", { n: f.n(v / 1e3) }))}
            rows={SERVICES.map((sv) => ({ label: serviceLabel(sv, lang), key: sv, value: TENDER_ANNUAL[sv], color: SERVICE_COLOR[sv] }))}
          />
          <div className="tblwrap">
            <table>
              <thead>
                <tr><th>{t("thService")}</th><th className="num">{t("thTender")}</th><th className="num">{t("thPlatform12")}</th></tr>
              </thead>
              <tbody>
                {SERVICES.map((sv) => (
                  <tr key={sv}>
                    <td><span className={`tag ${sv}`}>{serviceLabel(sv, lang)}</span></td>
                    <td className="num">{TENDER_ANNUAL[sv] == null ? <span className="st warn">{t("tbc")}</span> : f.n(TENDER_ANNUAL[sv]!)}</td>
                    <td className="num">{f.n(s.year[sv] ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">{t("dwNote")}</p>
        </div>
      </div>
    </>
  );
}
