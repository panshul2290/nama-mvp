"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { Empty, PageHead, ReadOnlyNote, Switch, useAudited } from "@/components/nws/admin/ui";
import { useStaff } from "@/components/nws/StaffContext";
import { SERVICE_LABEL } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import type { Site, Zone } from "@/lib/types";

const ZoneMap = dynamic(() => import("@/components/nws/admin/ZoneMap"), { ssr: false });

export default function ZonesPage() {
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
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
      title: `${active ? "Disable" : "Enable"} ${name}`,
      body: active
        ? test ? "Developers and testers outside Oman can no longer place orders or use their GPS in the apps. Test orders in progress continue." : zone ? "New requests from this area will be refused (“Tanker service is paused in this area”). Orders in progress continue." : "Filling or discharging here will no longer be accepted as verified and will raise an alert."
        : test ? "Developers and testers in this area can place orders and run trips again. Keep it off in production." : zone ? "Customers in this area can order again." : "This geofence becomes an approved site again.",
      confirm: active ? "Disable" : "Enable",
      danger: active,
      ok: `${name} ${active ? "disabled" : "enabled"}`,
      run: (reason) => supabase().rpc("staff_set_active", { p_kind: kind, p_id: id, p_active: !active, p_reason: reason }),
      done: load,
    });
  }

  // Auto-dispatch (0026): offer each request to the best-ranked tanker first.
  function dispatch(z: Zone, on: boolean) {
    let secs = String(z.offer_seconds ?? 45);
    ask({
      title: `${on ? "Auto-offer on" : "Auto-offer off"} — ${z.name}`,
      body: on
        ? "Each new request is offered to the best tanker (nearest, fairest workload, best rating, eligible) for the time below, then the next one, then it goes to every driver's open list. Operators can still assign by hand."
        : "Requests go straight to every eligible driver's open list, nearest first.",
      extra: on ? (
        <div className="fld">
          <label htmlFor="zo-s">Seconds each tanker has to accept (10–600)</label>
          <input id="zo-s" className="in" type="number" min={10} max={600} defaultValue={secs} onChange={(e) => (secs = e.target.value)} />
        </div>
      ) : undefined,
      confirm: on ? "Turn on" : "Turn off",
      ok: `Auto-offer ${on ? "on" : "off"} in ${z.name}`,
      run: (reason) => supabase().rpc("staff_set_zone_dispatch", { p_zone_id: z.id, p_auto_offer: on, p_offer_seconds: Number(secs) || 45, p_reason: reason }),
      done: load,
    });
  }

  return (
    <>
      <PageHead title="Zones and geofences" sub="Where tanker service is offered, and the approved filling stations and discharge plants trips are verified against." />
      {!editor && <ReadOnlyNote who="Super admins and control room operators" />}
      {zones?.some((z) => z.is_test && z.active) && (
        <div className="banner">
          <b>A test zone is active.</b> {zones.filter((z) => z.is_test && z.active).map((z) => z.name).join(", ")} lets developers and testers run the apps outside Oman: orders there are tagged TEST, left out of KPIs, reports and invoices, never penalised, and fill / discharge at the tanker&apos;s position. Switch it off for production.
        </div>
      )}
      <div className="two">
        <div className="panel">
          <div className="mapcard zonemap" style={{ borderRadius: "16px 16px 0 0", border: 0 }}>
            {zones && sites && <ZoneMap zones={zones} sites={sites} />}
            <div className="ov ov-bl">
              <div className="legend2">
                <span><i style={{ background: "#17b3c6" }} />Service area</span>
                <span><i style={{ background: "#e5484d" }} />Disabled area</span>
                <span><i className="sq" style={{ background: "var(--dw)" }} />DW filling</span>
                <span><i className="sq" style={{ background: "var(--te)" }} />TE outlet</span>
                <span><i className="sq" style={{ background: "var(--ww)" }} />WW discharge</span>
                <span><i className="sq" style={{ background: "#8A9A9E" }} />Disabled geofence</span>
              </div>
            </div>
          </div>
          <p className="note">Disabled service areas are shaded red; requests from them are refused. Disabled geofences are grey; filling or discharge there raises an alert. Click a shape for details.</p>
        </div>

        <div className="stack">
          <div className="panel">
            <h2>Service areas</h2>
            <div className="tblwrap">
              <table>
                <thead><tr><th>Area</th><th>Governorate</th><th className="num">Radius</th><th className="num">Auto-offer</th><th className="num">Active</th></tr></thead>
                <tbody>
                  {!zones && <Empty cols={5}>Loading…</Empty>}
                  {zones?.map((z) => (
                    <tr key={z.id}>
                      <td>{z.name}{z.is_test && <span className="st warn ptag">TEST</span>}</td>
                      <td>{z.governorate}</td>
                      <td className="num">{z.min_lat != null ? "box" : `${Number(z.radius_km)} km`}</td>
                      <td className="num">
                        <Switch on={Boolean(z.auto_offer)} disabled={!editor} label={z.auto_offer ? "Auto-offer on" : "Auto-offer off"} onClick={() => dispatch(z, !z.auto_offer)} />
                        {z.auto_offer && <small style={{ display: "block" }}>{z.offer_seconds} s each</small>}
                      </td>
                      <td className="num"><Switch on={z.active} disabled={!editor} label={z.active ? "Active" : "Disabled"} onClick={() => toggle("zone", z.id, z.name, z.active)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="panel">
            <h2>Approved filling and discharge geofences</h2>
            <div className="tblwrap">
              <table>
                <thead><tr><th>Site</th><th>Kind</th><th>Services</th><th className="num">Radius</th><th className="num">Active</th></tr></thead>
                <tbody>
                  {!sites && <Empty cols={5}>Loading…</Empty>}
                  {sites?.map((s) => (
                    <tr key={s.id}>
                      <td>{s.name}{s.is_test && <span className="st warn ptag">TEST</span>}<small style={{ display: "block" }}>{s.code} · {s.operator}{s.is_test ? " · accepted at the tanker’s position on test orders" : ""}</small></td>
                      <td>{s.kind === "fill" ? "Filling" : "Discharge"}</td>
                      <td>{s.service_types.map((t) => <span key={t} className={`tag ${t}`} title={SERVICE_LABEL[t]} style={{ marginRight: 4 }}>{t}</span>)}</td>
                      <td className="num">{s.radius_m} m</td>
                      <td className="num"><Switch on={s.active} disabled={!editor} label={s.active ? "Active" : "Disabled"} onClick={() => toggle("site", s.id, s.name, s.active)} /></td>
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
