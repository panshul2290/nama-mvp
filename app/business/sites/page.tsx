"use client";

import { AddressDetailsForm } from "@/components/AddressDetailsForm";
import { contactPhoneOk, detailsFromRow, detailsPayload, type DetailsForm } from "@/lib/address";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useBiz, type BizProperty } from "@/components/business/BizContext";
import { BIZ } from "@/components/business/i18n";
import { Map as PinMap } from "@/components/Map";
import { Sparkline } from "@/components/nws/admin/charts";
import { useFmt } from "@/components/portal/i18n";
import { Dialog, useAction, useLive } from "@/components/portal/kit";
import { DEFAULT_CENTER } from "@/lib/geo";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { ref, type LngLat } from "@/lib/types";

type SiteStats = { contract: string | null; last: string | null; deliveries: number; first: string | null };
/** org_sites_trends (0029): weekly gallons per site for the last 12 weeks (F5), within the member's sites. */
type Trend = { property_id: string; weeks: number[]; total_gal: number; deliveries: number; avg_gap_days: number | null; next_due_at: string | null };

export default function BusinessSites() {
  const { org, canOrder } = useBiz();
  const [sites, setSites] = useState<BizProperty[]>([]);
  const [stats, setStats] = useState<Record<string, SiteStats>>({});
  const [loaded, setLoaded] = useState(false);
  const [edit, setEdit] = useState<BizProperty | "new" | null>(null);
  const [del, setDel] = useState<BizProperty | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [trends, setTrends] = useState<Map<string, Trend>>(new Map());
  const { busy, run } = useAction();
  const t = useT(BIZ);
  const f = useFmt();

  const load = useCallback(async () => {
    const db = supabase();
    const [p, c, o, tr] = await Promise.all([
      db.from("properties").select("*").eq("org_id", org.id).order("label"),
      db.from("contracts").select("property_id, contract_no, status").eq("org_id", org.id).in("status", ["pending_owner", "active", "paused"]),
      db.from("orders").select("property_id, delivered_at").eq("org_id", org.id).eq("status", "delivered").order("delivered_at", { ascending: false }).limit(1000),
      db.rpc("org_sites_trends", { p_weeks: 12 }),
    ]);
    setTrends(new Map(((tr.data ?? []) as Trend[]).map((x) => [x.property_id, x])));
    setLoadError(p.error?.message ?? o.error?.message ?? null);
    if (p.error) return setLoaded(true); // keep what is on screen
    const s: Record<string, SiteStats> = {};
    for (const x of (p.data ?? []) as BizProperty[]) s[x.id] = { contract: null, last: null, deliveries: 0, first: null };
    for (const k of (c.data ?? []) as { property_id: string; contract_no: number }[]) if (s[k.property_id]) s[k.property_id].contract = ref.contract(k.contract_no);
    for (const r of (o.data ?? []) as { property_id: string | null; delivered_at: string | null }[]) {
      const t = r.property_id ? s[r.property_id] : null;
      if (!t) continue;
      t.deliveries += 1;
      t.last ??= r.delivered_at;
      t.first = r.delivered_at; // newest first, so the last one seen is the oldest
    }
    setSites((p.data ?? []) as BizProperty[]);
    setStats(s);
    setLoaded(true);
  }, [org.id]);

  useLive("biz-sites", ["properties", "contracts"], load);

  return (
    <>
      {loadError && (
        <div className="banner badb" role="alert">
          {t("errPage", { error: loadError })}
        </div>
      )}
      <div className="panel">
        <div className="toolbar">
          <span className="mut" style={{ fontSize: 13 }}>
            {t("sitesIntro")}
          </span>
          {canOrder && (
            <button className="btn pri" onClick={() => setEdit("new")}>
              {t("addSite")}
            </button>
          )}
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("hSite")}</th>
                <th>{t("hArea")}</th>
                <th className="num">{t("hTank")}</th>
                <th className="num">{t("hDeliveries")}</th>
                <th>{t("hLastDel")}</th>
                <th>{t("hLast12")}</th>
                <th>{t("hInterval")}</th>
                <th>{t("hNextRefill")}</th>
                <th>{t("hContract")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.id}>
                  <td>
                    <b>{s.label}</b>
                    {s.address && <small className="stack">{s.address}</small>}
                  </td>
                  <td>{s.area || "—"}</td>
                  <td className="num">{f.n(s.tank_gal)}</td>
                  <td className="num">{f.n(stats[s.id]?.deliveries ?? 0)}</td>
                  <td>{f.day(stats[s.id]?.last)}</td>
                  <td>
                    {trends.get(s.id) ? (
                      <span title={trends.get(s.id)!.weeks.map((g) => f.n(Number(g))).join(" · ")}>
                        <Sparkline values={trends.get(s.id)!.weeks.map(Number)} width={90} />{" "}
                        <small className="mut">{t("perWeek", { gal: f.n(Math.round(Number(trends.get(s.id)!.total_gal) / 12)) })}</small>
                      </span>
                    ) : <span className="mut">—</span>}
                  </td>
                  {(() => {
                    // Average days between deliveries; the next refill is expected one interval after the last.
                    const st = stats[s.id];
                    const days = st && st.deliveries > 1 && st.first && st.last ? (Date.parse(st.last) - Date.parse(st.first)) / 86_400_000 / (st.deliveries - 1) : null;
                    return (
                      <>
                        <td>{days ? t("everyDays", { n: f.n(Math.max(1, Math.round(days))) }) : <span className="mut">—</span>}</td>
                        <td>{days && st?.last ? f.day(new Date(Date.parse(st.last) + days * 86_400_000).toISOString()) : <span className="mut">—</span>}</td>
                      </>
                    );
                  })()}
                  <td>{stats[s.id]?.contract ? <bdi dir="ltr">{stats[s.id]?.contract}</bdi> : <span className="mut">—</span>}</td>
                  <td>
                    {canOrder && (
                      <div className="btns">
                        <button className="btn sm" onClick={() => setEdit(s)}>
                          {t("edit")}
                        </button>
                        <button className="btn sm" disabled={!!busy} onClick={() => setDel(s)}>
                          {t("delete")}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {loaded && !sites.length && (
                <tr>
                  <td className="empty" colSpan={10}>
                    {t("noSites")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="note">{t("sitesNote")}</p>
      </div>
      {edit && <SiteDialog site={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={load} />}
      {del && (
        <Dialog title={t("deleteQ", { name: del.label })} body={t("deleteBody")} onClose={() => setDel(null)}>
          <div className="btns" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setDel(null)}>
              {t("cancel")}
            </button>
            <button
              className="btn bad"
              disabled={!!busy}
              onClick={() =>
                run("del", async () => supabase().rpc("delete_property", { p_id: del.id }), t("deletedT", { name: del.label }), () => {
                  setDel(null);
                  load();
                })
              }
            >
              {t("deleteSite")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function SiteDialog({ site, onClose, onSaved }: { site: BizProperty | null; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(site?.label ?? "");
  const [address, setAddress] = useState(site?.address ?? "");
  const [area, setArea] = useState(site?.area ?? "");
  const [tank, setTank] = useState(site?.tank_gal ?? 10000);
  const [details, setDetails] = useState<DetailsForm>(() => detailsFromRow(site));
  const [point, setPoint] = useState<LngLat>(site ? { lat: site.lat, lng: site.lng } : DEFAULT_CENTER);
  const center = useMemo(() => (site ? { lat: site.lat, lng: site.lng } : DEFAULT_CENTER), [site]);
  const pick = useMemo(() => ({ value: point, onChange: setPoint }), [point]);
  const { busy, run } = useAction();
  const t = useT(BIZ);
  // save_property accepts any pin, but orders to a pin outside every zone are refused: warn early.
  const [outside, setOutside] = useState(false);
  useEffect(() => {
    const t = setTimeout(async () => {
      const { data, error } = await supabase().rpc("zone_at", { p_lat: point.lat, p_lng: point.lng });
      setOutside(!error && !(data as { id: string | null } | null)?.id);
    }, 400);
    return () => clearTimeout(t);
  }, [point]);

  return (
    <Dialog title={site ? t("editQ", { name: site.label }) : t("addSite")} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(
            "save",
            async () => {
              const r = await supabase()
                .rpc("save_property", {
                  p_id: site?.id ?? null,
                  p_label: label.trim(),
                  p_address: address.trim(),
                  p_area: area.trim(),
                  p_lat: point.lat,
                  p_lng: point.lng,
                  p_tank_gal: tank,
                })
                .single<{ id: string }>();
              if (r.error || !r.data) return r;
              return supabase().rpc("set_property_details", { p_id: r.data.id, p_details: detailsPayload(details) });
            },
            site ? t("siteUpdated") : t("siteAdded"),
            () => {
              onSaved();
              onClose();
            },
          );
        }}
      >
        <div className="mapbox">
          <PinMap center={center} pick={pick} hint={t("pinHint")} theme="dark" />
        </div>
        <p className="mut" style={{ fontSize: 12.5, margin: "-4px 0 12px" }}>
          {t("pinLabel")}{" "}
          <bdi dir="ltr">
            {point.lat.toFixed(5)}, {point.lng.toFixed(5)}
          </bdi>
        </p>
        {outside && (
          <div className="banner" role="status">
            {t("outsideArea")}
          </div>
        )}
        <div className="form">
          <div className="fld">
            <label htmlFor="sLabel">{t("lSiteName")}</label>
            <input id="sLabel" className="in" required maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("phSiteName")} />
          </div>
          <div className="fld">
            <label htmlFor="sArea">{t("hArea")}</label>
            <input id="sArea" className="in" maxLength={120} value={area} onChange={(e) => setArea(e.target.value)} placeholder={t("phArea")} />
          </div>
          <div className="fld full">
            <label htmlFor="sAddr">{t("lAddr")}</label>
            <input id="sAddr" className="in" maxLength={300} value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t("phAddr")} />
          </div>
          <div className="fld">
            <label htmlFor="sTank">{t("lTankSize")}</label>
            <input id="sTank" className="in" type="number" min={100} max={100000} step={100} required value={tank} onChange={(e) => setTank(Number(e.target.value))} />
          </div>
        </div>
        <AddressDetailsForm value={details} onChange={setDetails} portal />
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn pri" disabled={busy === "save" || !contactPhoneOk(details)}>
            {busy === "save" ? t("saving") : t("saveSite")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
