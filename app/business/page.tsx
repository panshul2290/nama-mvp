"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ORDER_COLS, useBiz, type BizOrder, type BizProperty } from "@/components/business/BizContext";
import { OPEN, slotText } from "@/components/business/data";
import { BIZ } from "@/components/business/i18n";
import { SiteNotices } from "@/components/business/Notices";
import { StatusPill, TypeTag } from "@/components/OrderBits";
import { useFmt } from "@/components/portal/i18n";
import { Bars, Kpis, monthStart, useLive } from "@/components/portal/kit";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { ref } from "@/lib/types";

const ORDER_CAP = 1000;

export default function BusinessDashboard() {
  const { org } = useBiz();
  const [sites, setSites] = useState<BizProperty[]>([]);
  const [orders, setOrders] = useState<BizOrder[]>([]);
  const [activeContracts, setActiveContracts] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cut, setCut] = useState<{ shown: number; total: number } | null>(null);
  const t = useT(BIZ);
  const f = useFmt();

  const load = useCallback(async () => {
    const db = supabase();
    const since = new Date(Math.min(monthStart().getTime(), Date.now() - 2 * 86_400_000)).toISOString();
    const [p, o, c, up] = await Promise.all([
      db.from("properties").select("id, label, address, area, lat, lng, tank_gal, created_at").eq("org_id", org.id).order("label"),
      db.from("orders").select(ORDER_COLS, { count: "exact" }).eq("org_id", org.id).gte("created_at", since).order("created_at", { ascending: false }).limit(ORDER_CAP),
      db.from("contracts").select("id", { count: "exact", head: true }).eq("org_id", org.id).eq("status", "active"),
      db.from("orders").select(ORDER_COLS).eq("org_id", org.id).in("status", OPEN).order("slot_start", { ascending: true, nullsFirst: true }).limit(50),
    ]);
    const failed = p.error ?? o.error ?? c.error ?? up.error;
    setError(failed ? failed.message : null);
    if (failed) return setLoaded(true); // keep the figures already on screen
    const shown = o.data?.length ?? 0;
    setCut(o.count != null && o.count > shown ? { shown, total: o.count } : null);
    setSites((p.data ?? []) as BizProperty[]);
    const map = new Map<string, BizOrder>();
    for (const r of [...((o.data ?? []) as BizOrder[]), ...((up.data ?? []) as BizOrder[])]) map.set(r.id, r);
    setOrders([...map.values()]);
    setActiveContracts(c.count ?? 0);
    setLoaded(true);
  }, [org.id]);

  useLive("biz-dash", ["orders", "contracts", "properties"], load);

  const ms = monthStart().getTime();
  const month = orders.filter((o) => Date.parse(o.created_at) >= ms && o.status !== "cancelled");
  const delivered = month.filter((o) => o.status === "delivered");
  // Delivered this month (what will be invoiced), net of short-delivery credits.
  const spend = delivered.reduce((s, o) => s + Number(o.total) - Number(o.short_credit ?? 0), 0);
  const used = Number(org.credit_used);
  const limit = Number(org.credit_limit);
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
  const siteName = (id: string | null) => sites.find((s) => s.id === id)?.label ?? "—";

  const bySite = sites
    .map((s) => ({ label: s.label, value: delivered.filter((o) => o.property_id === s.id).reduce((t, o) => t + o.gallons, 0) }))
    .sort((a, b) => b.value - a.value);
  const upcoming = orders
    .filter((o) => OPEN.includes(o.status))
    .sort((a, b) => (a.slot_start ?? a.created_at).localeCompare(b.slot_start ?? b.created_at))
    .slice(0, 8);

  return (
    <>
      <SiteNotices />
      {error && (
        <div className="banner badb" role="alert">
          {t("errDash", { error })}
        </div>
      )}
      {cut && (
        <div className="banner info" role="status">
          {t("cutNote", { n: f.n(cut.shown), total: f.n(cut.total) })}
        </div>
      )}
      <Kpis
        items={[
          { label: t("kSites"), value: loaded ? f.n(sites.length) : "…" },
          { label: t("kActiveContracts"), value: loaded ? f.n(activeContracts) : "…" },
          { label: t("kDeliveriesMonth"), value: loaded ? f.n(delivered.length) : "…", sub: t("kMoreBooked", { n: f.n(month.length - delivered.length) }) },
          { label: t("kSpendMonth"), value: f.omr(spend), sub: t("kSpendSub") },
          {
            label: limit > 0 ? t("kCreditUsedOf", { limit: f.omr(limit) }) : t("kCreditUsed"),
            value: limit > 0 ? f.ratio(pct, 100) : "—",
            sub: limit > 0 ? t("kOutstanding", { amt: f.omr(used) }) : t("kCreditByNws"),
            tone: pct >= 90 ? "bad" : pct >= 70 ? "warn" : undefined,
          },
        ]}
      />
      <div className="half">
        <div className="panel">
          <h2>
            {t("useBySite")} <small>{t("useBySiteSub")}</small>
          </h2>
          <Bars rows={bySite} unit={` ${t("galUnit")}`} empty={sites.length ? t("noDelMonth") : t("addFirstSite")} />
        </div>
        <div className="panel">
          <h2>
            {t("upcoming")}
            <Link className="lk" href="/business/orders" style={{ fontSize: 13 }}>
              {t("allOrders")}
            </Link>
          </h2>
          <div className="tblwrap">
            <table>
              <tbody>
                {upcoming.map((o) => (
                  <tr key={o.id}>
                    <td>{f.ar && o.slot_start ? slotText(o.slot_start, o.slot_end, f.lang) : (o.slot_label ?? (o.slot_start ? f.dateTime(o.slot_start) : t("asap")))}</td>
                    <td>{siteName(o.property_id)}</td>
                    <td>
                      {f.gal(o.gallons)} <TypeTag type={o.service_type} />
                    </td>
                    <td className="mut">{o.contract_id ? t("contractWord") : <bdi dir="ltr">{ref.order(o.order_no)}</bdi>}</td>
                    <td>
                      <StatusPill status={o.status} type={o.service_type} />
                    </td>
                  </tr>
                ))}
                {loaded && !upcoming.length && (
                  <tr>
                    <td className="empty" colSpan={5}>
                      {t("nothingBooked")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
