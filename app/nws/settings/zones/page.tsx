"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { Empty, PageHead, ReadOnlyNote, Switch, useAudited } from "@/components/nws/admin/ui";
import { SETTINGS_OPS } from "@/components/nws/i18n/settingsOps";
import { useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { useLang, useT } from "@/lib/i18n";
import { serviceLabel } from "@/lib/labels";
import { supabase } from "@/lib/supabase/client";
import type { Site, Zone } from "@/lib/types";

const ZoneMap = dynamic(() => import("@/components/nws/admin/ZoneMap"), { ssr: false });

export default function ZonesPage() {
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const { lang } = useLang();
  const t = useT(SETTINGS_OPS);
  const f = useFmt();
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [sites, setSites] = useState<Site[] | null>(null);
  const editor = can("admin", "operator");

  const load = useCallback(() => {
    const db = supabase();
    db.from("zones").select("*").order("governorate").order("name").then(({ data }) => setZones((data ?? []) as Zone[]));
    db.from("sites").select("*").order("kind", { ascending: false }).order("code").then(({ data }) => setSites((data ?? []) as Site[]));
  }, []);
  useEffect(load, [load]);

  function toggle(kind: "zone" | "site", id: string, name: string, active: boolean) {
    const zone = kind === "zone";
    const test = zone && zones?.find((z) => z.id === id)?.is_test;
    ask({
      title: t(active ? "znDisableT" : "znEnableT", { name }),
      body: active
        ? t(test ? "znOffTest" : zone ? "znOffZone" : "znOffSite")
        : t(test ? "znOnTest" : zone ? "znOnZone" : "znOnSite"),
      confirm: active ? t("znDisable") : t("znEnable"),
      danger: active,
      ok: t(active ? "znDisabledOk" : "znEnabledOk", { name }),
      run: (reason) => supabase().rpc("staff_set_active", { p_kind: kind, p_id: id, p_active: !active, p_reason: reason }),
      done: load,
    });
  }

  // Auto-dispatch (0026): offer each request to the best-ranked tanker first.
  function dispatch(z: Zone, on: boolean) {
    let secs = String(z.offer_seconds ?? 45);
    ask({
      title: `${on ? t("znAutoOn") : t("znAutoOff")} — ${z.name}`,
      body: on ? t("znAutoOnB") : t("znAutoOffB"),
      extra: on ? (
        <div className="fld">
          <label htmlFor="zo-s">{t("znSecs")}</label>
          <input id="zo-s" className="in" type="number" dir="ltr" min={10} max={600} defaultValue={secs} onChange={(e) => (secs = e.target.value)} />
        </div>
      ) : undefined,
      confirm: on ? t("znTurnOn") : t("znTurnOff"),
      ok: t(on ? "znAutoOnOk" : "znAutoOffOk", { name: z.name }),
      run: (reason) => supabase().rpc("staff_set_zone_dispatch", { p_zone_id: z.id, p_auto_offer: on, p_offer_seconds: Number(secs) || 45, p_reason: reason }),
      done: load,
    });
  }

  return (
    <>
      <PageHead title={t("znTitle")} sub={t("znSub")} />
      {!editor && <ReadOnlyNote who={t("whoAdminOps")} />}
      {zones?.some((z) => z.is_test && z.active) && (
        <div className="banner">
          <b>{t("znTestB")}</b> {t("znTestBody", { names: zones.filter((z) => z.is_test && z.active).map((z) => z.name).join(lang === "ar" ? "، " : ", ") })}
        </div>
      )}
      <div className="two">
        <div className="panel">
          <div className="mapcard zonemap" style={{ borderRadius: "16px 16px 0 0", border: 0 }}>
            {zones && sites && <ZoneMap zones={zones} sites={sites} />}
            <div className="ov ov-bl">
              <div className="legend2">
                <span><i style={{ background: "#17b3c6" }} />{t("znLgArea")}</span>
                <span><i style={{ background: "#e5484d" }} />{t("znLgDisabledArea")}</span>
                <span><i className="sq" style={{ background: "var(--dw)" }} />{t("znLgDw")}</span>
                <span><i className="sq" style={{ background: "var(--te)" }} />{t("znLgTe")}</span>
                <span><i className="sq" style={{ background: "var(--ww)" }} />{t("znLgWw")}</span>
                <span><i className="sq" style={{ background: "#8A9A9E" }} />{t("znLgDisabledGeo")}</span>
              </div>
            </div>
          </div>
          <p className="note">{t("znMapNote")}</p>
        </div>

        <div className="stack">
          <div className="panel">
            <h2>{t("znAreas")}</h2>
            <div className="tblwrap">
              <table>
                <thead><tr><th>{t("area")}</th><th>{t("znGov")}</th><th className="num">{t("znRadius")}</th><th className="num">{t("znAuto")}</th><th className="num">{t("active")}</th></tr></thead>
                <tbody>
                  {!zones && <Empty cols={5}>{t("loading")}</Empty>}
                  {zones?.map((z) => (
                    <tr key={z.id}>
                      <td>{z.name}{z.is_test && <span className="st warn ptag">{t("testTag")}</span>}</td>
                      <td>{z.governorate}</td>
                      <td className="num">{z.min_lat != null ? t("znBox") : `${f.n(Number(z.radius_km), Number(z.radius_km) % 1 ? 1 : 0)} ${t("uKm")}`}</td>
                      <td className="num">
                        <Switch on={Boolean(z.auto_offer)} disabled={!editor} label={z.auto_offer ? t("znAutoOn") : t("znAutoOff")} onClick={() => dispatch(z, !z.auto_offer)} />
                        {z.auto_offer && <small style={{ display: "block" }}>{t("znSecsEach", { n: f.n(z.offer_seconds ?? 45) })}</small>}
                      </td>
                      <td className="num"><Switch on={z.active} disabled={!editor} label={z.active ? t("active") : t("znDisabled")} onClick={() => toggle("zone", z.id, z.name, z.active)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="panel">
            <h2>{t("znGeofences")}</h2>
            <div className="tblwrap">
              <table>
                <thead><tr><th>{t("znSite")}</th><th>{t("znKind")}</th><th>{t("znServices")}</th><th className="num">{t("znRadius")}</th><th className="num">{t("active")}</th></tr></thead>
                <tbody>
                  {!sites && <Empty cols={5}>{t("loading")}</Empty>}
                  {sites?.map((s) => (
                    <tr key={s.id}>
                      <td>{s.name}{s.is_test && <span className="st warn ptag">{t("testTag")}</span>}<small style={{ display: "block" }}><bdi dir="ltr">{s.code}</bdi> · {s.operator}{s.is_test ? ` · ${t("znTestSite")}` : ""}</small></td>
                      <td>{s.kind === "fill" ? t("znFilling") : t("znDischarge")}</td>
                      <td>{s.service_types.map((st) => <span key={st} className={`tag ${st}`} title={serviceLabel(st, lang)} style={{ marginInlineEnd: 4 }}>{st}</span>)}</td>
                      <td className="num">{f.n(s.radius_m)} {t("uM")}</td>
                      <td className="num"><Switch on={s.active} disabled={!editor} label={s.active ? t("active") : t("znDisabled")} onClick={() => toggle("site", s.id, s.name, s.active)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      {dialog}
    </>
  );
}
