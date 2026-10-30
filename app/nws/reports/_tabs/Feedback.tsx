"use client";

import { BarList, LineChart } from "@/components/nws/admin/charts";
import { dayKeys, Empty, Kpi } from "@/components/nws/admin/ui";
import { REPORTS } from "@/components/nws/i18n/reports";
import { useFmt } from "@/components/portal/i18n";
import { useT } from "@/lib/i18n";
import { ReportState, useReport } from "./report";

export const stars = (n: number) => "★".repeat(Math.round(n)) + "☆".repeat(5 - Math.round(n));

/** report_feedback (0029): feedback insights over every rating and complaint in range (F8). */
type Fb = {
  ratings: number; average: number | null; delivered: number;
  distribution: { "5": number; "4": number; "3": number; "1-2": number };
  per_day: { day: string; n: number; average: number }[];
  per_week: { week: string; n: number; average: number }[];
  by_company: { company: string; n: number; average: number; low: number }[];
  worst_drivers: { driver_id: string; name: string | null; company: string; n: number; average: number; low: number }[];
  comments: { id: string; order_no: number; rating: number; comment: string; driver: string | null; area: string; rated_at: string | null }[];
  complaints: number; resolved: number; reopened: number; reopen_rate: number | null;
  by_category: { category: string; label: string; n: number; open: number }[];
};

const tone = (avg: number) => (avg < 3.5 ? "bad" : avg < 4.3 ? "warn" : "ok");

export default function Feedback({ days }: { days: number }) {
  const { data: s, error } = useReport<Fb>("report_feedback", days);
  const t = useT(REPORTS);
  const f = useFmt();
  if (!s) return <ReportState error={error} what={t("whatFb")} />;

  const keys = dayKeys(days);
  const byDay = new Map(s.per_day.map((d) => [d.day, Number(d.average)]));
  const dist = [
    { label: t("stars5"), key: "5", value: s.distribution["5"] },
    { label: t("stars4"), key: "4", value: s.distribution["4"] },
    { label: t("stars3"), key: "3", value: s.distribution["3"] },
    { label: t("stars12"), key: "1-2", value: s.distribution["1-2"] },
  ];
  const five = s.ratings ? s.distribution["5"] / s.ratings : null;

  return (
    <>
      <div className="okpis">
        <Kpi label={t("avgRating")} value={s.average == null ? "—" : `${f.n(Number(s.average), 2)} ★`} sub={t("ratingsSub", { n: f.n(s.ratings), p: five == null ? "—" : f.pct(five, 0) })} tone={s.average == null ? undefined : s.average >= 4.5 ? "ok" : s.average < 4 ? "bad" : "warn"} />
        <Kpi label={t("ratedDeliveries")} value={s.delivered ? f.pct(s.ratings / s.delivered, 0) : "—"} sub={t("ofDelivered")} />
        <Kpi label={t("complaints")} value={f.n(s.complaints)} sub={t("stillOpen", { n: f.n(s.by_category.reduce((a, c) => a + c.open, 0)) })} tone={s.complaints ? "warn" : undefined} />
        <Kpi label={t("reopenRate")} value={s.reopen_rate == null ? "—" : f.pct(Number(s.reopen_rate))} sub={t("reopenSub", { a: f.n(s.reopened), b: f.n(s.resolved) })} tone={s.reopen_rate != null && s.reopen_rate > 0.1 ? "warn" : undefined} />
      </div>

      <div className="half">
        <div className="panel">
          <h2>{t("ratingOverTime")} <small>{t("perDay")}</small></h2>
          <LineChart labels={keys.map((k) => f.day(k))} series={[{ name: t("avgRating"), color: "var(--warn)", values: keys.map((k) => byDay.get(k) ?? null) }]} yMax={5} fmt={(v) => f.n(v, 1)} height={170} />
          {s.per_week.length > 1 && (
            <p className="note">{t("byWeek", { list: s.per_week.map((w) => `${f.day(w.week)} ${f.n(Number(w.average), 2)} (${f.n(w.n)})`).join(" · ") })}</p>
          )}
        </div>
        <div className="panel">
          <h2>{t("driverRatings")} <small>{t("distribution")}</small></h2>
          <BarList rows={dist.map((d, i) => ({ ...d, color: i === 3 ? "var(--bad)" : i === 2 ? "var(--warn)" : "var(--accent)" }))} fmt={(v) => (s.ratings ? f.pct(v / s.ratings, 0) : f.pct(0, 0))} empty={t("noRatings")} />
        </div>
      </div>

      <div className="half">
        <div className="panel">
          <h2>{t("byCompany")}</h2>
          <div className="tblwrap">
            <table>
              <thead><tr><th>{t("thCompany")}</th><th className="num">{t("thRatings")}</th><th className="num">{t("thAverage")}</th><th className="num">{t("stars12")}</th></tr></thead>
              <tbody>
                {s.by_company.length === 0 && <Empty cols={4}>{t("noRatings")}</Empty>}
                {s.by_company.map((c) => (
                  <tr key={c.company}>
                    <td>{c.company}</td>
                    <td className="num">{f.n(c.n)}</td>
                    <td className="num"><span className={`st ${tone(Number(c.average))}`}>{f.n(Number(c.average), 2)}</span></td>
                    <td className="num">{f.n(c.low)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <h2>{t("worstDrivers")} <small>{t("lowestFirst")}</small></h2>
          <div className="tblwrap">
            <table>
              <thead><tr><th>{t("thDriver")}</th><th>{t("thCompany")}</th><th className="num">{t("thRatings")}</th><th className="num">{t("thAverage")}</th><th className="num">{t("stars12")}</th></tr></thead>
              <tbody>
                {s.worst_drivers.length === 0 && <Empty cols={5}>{t("noRatings")}</Empty>}
                {s.worst_drivers.map((d) => (
                  <tr key={d.driver_id}>
                    <td>{d.name || t("driverFallback")}</td>
                    <td>{d.company}</td>
                    <td className="num">{f.n(d.n)}</td>
                    <td className="num"><span className={`st ${tone(Number(d.average))}`}>{f.n(Number(d.average), 2)}</span></td>
                    <td className="num">{f.n(d.low)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="half">
        <div className="panel">
          <h2>{t("byCategory")}</h2>
          <BarList rows={s.by_category.map((c) => ({ label: c.label, key: c.category, value: c.n, color: "var(--warn)" }))} empty={t("noComplaints")} />
        </div>
        <div className="panel">
          <h2>{t("mention")} <small>{t("latestComments")}</small></h2>
          {s.comments.length === 0 && <div className="empty">{t("noComments")}</div>}
          {s.comments.map((o) => (
            <div className="quote" key={o.id}>
              <span className="stars">{stars(o.rating)}</span> “{o.comment}”
              <small>
                <bdi dir="ltr">TO-{o.order_no}</bdi> · {o.driver ?? t("driverFallback")} · {o.area} · {f.dateTime(o.rated_at)}
              </small>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
