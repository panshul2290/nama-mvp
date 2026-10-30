"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useBiz, type BizProperty } from "@/components/business/BizContext";
import { Map as PinMap } from "@/components/Map";
import { Dialog, fmtShort, gal, useAction, useLive } from "@/components/portal/kit";
import { DEFAULT_CENTER } from "@/lib/geo";
import { supabase } from "@/lib/supabase/client";
import { ref, type LngLat } from "@/lib/types";

type SiteStats = { contract: string | null; last: string | null; deliveries: number; first: string | null };

export default function BusinessSites() {
  const { org, canOrder } = useBiz();
  const [sites, setSites] = useState<BizProperty[]>([]);
  const [stats, setStats] = useState<Record<string, SiteStats>>({});
  const [loaded, setLoaded] = useState(false);
  const [edit, setEdit] = useState<BizProperty | "new" | null>(null);
  const [del, setDel] = useState<BizProperty | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, run } = useAction();

  const load = useCallback(async () => {
    const db = supabase();
    const [p, c, o] = await Promise.all([
      db.from("properties").select("id, label, address, area, lat, lng, tank_gal, created_at").eq("org_id", org.id).order("label"),
      db.from("contracts").select("property_id, contract_no, status").eq("org_id", org.id).in("status", ["pending_owner", "active", "paused"]),
      db.from("orders").select("property_id, delivered_at").eq("org_id", org.id).eq("status", "delivered").order("delivered_at", { ascending: false }).limit(1000),
    ]);
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
          Couldn’t load this page: {loadError}. It retries automatically.
        </div>
      )}
      <div className="panel">
        <div className="toolbar">
          <span className="mut" style={{ fontSize: 13 }}>
            Delivery sites on this account. Each site has its own map pin and tank size.
          </span>
          {canOrder && (
            <button className="btn pri" onClick={() => setEdit("new")}>
              Add site
            </button>
          )}
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th>Area</th>
                <th className="num">Tank (gal)</th>
                <th className="num">Deliveries</th>
                <th>Last delivery</th>
                <th>Usual interval</th>
                <th>Next refill (predicted)</th>
                <th>Contract</th>
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
                  <td className="num">{gal(s.tank_gal)}</td>
                  <td className="num">{stats[s.id]?.deliveries ?? 0}</td>
                  <td>{fmtShort(stats[s.id]?.last)}</td>
                  {(() => {
                    // Average days between deliveries; the next refill is expected one interval after the last.
                    const st = stats[s.id];
                    const days = st && st.deliveries > 1 && st.first && st.last ? (Date.parse(st.last) - Date.parse(st.first)) / 86_400_000 / (st.deliveries - 1) : null;
                    return (
                      <>
                        <td>{days ? `Every ~${Math.max(1, Math.round(days))} days` : <span className="mut">—</span>}</td>
                        <td>{days && st?.last ? fmtShort(new Date(Date.parse(st.last) + days * 86_400_000).toISOString()) : <span className="mut">—</span>}</td>
                      </>
                    );
                  })()}
                  <td>{stats[s.id]?.contract ?? <span className="mut">—</span>}</td>
                  <td>
                    {canOrder && (
                      <div className="btns">
                        <button className="btn sm" onClick={() => setEdit(s)}>
                          Edit
                        </button>
                        <button className="btn sm" disabled={!!busy} onClick={() => setDel(s)}>
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {loaded && !sites.length && (
                <tr>
                  <td className="empty" colSpan={9}>
                    No sites yet. Add your hotel, compound, farm or office to start ordering.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="note">Site managers order and track for their sites. Sites with an active contract can&apos;t be deleted — end the contract first.</p>
      </div>
      {edit && <SiteDialog site={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={load} />}
      {del && (
        <Dialog title={`Delete ${del.label}?`} body="Past orders keep their address, but the site’s ended or declined contracts are deleted with it. This can’t be undone." onClose={() => setDel(null)}>
          <div className="btns" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setDel(null)}>
              Cancel
            </button>
            <button
              className="btn bad"
              disabled={!!busy}
              onClick={() =>
                run("del", async () => supabase().rpc("delete_property", { p_id: del.id }), `${del.label} deleted`, () => {
                  setDel(null);
                  load();
                })
              }
            >
              Delete site
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
  const [point, setPoint] = useState<LngLat>(site ? { lat: site.lat, lng: site.lng } : DEFAULT_CENTER);
  const center = useMemo(() => (site ? { lat: site.lat, lng: site.lng } : DEFAULT_CENTER), [site]);
  const pick = useMemo(() => ({ value: point, onChange: setPoint }), [point]);
  const { busy, run } = useAction();
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
    <Dialog title={site ? `Edit ${site.label}` : "Add site"} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(
            "save",
            async () =>
              supabase().rpc("save_property", {
                p_id: site?.id ?? null,
                p_label: label.trim(),
                p_address: address.trim(),
                p_area: area.trim(),
                p_lat: point.lat,
                p_lng: point.lng,
                p_tank_gal: tank,
              }),
            site ? "Site updated" : "Site added",
            () => {
              onSaved();
              onClose();
            },
          );
        }}
      >
        <div className="mapbox">
          <PinMap center={center} pick={pick} hint="Drag the pin or click the map to the delivery point" theme="dark" />
        </div>
        <p className="mut" style={{ fontSize: 12.5, margin: "-4px 0 12px" }}>
          Pin: {point.lat.toFixed(5)}, {point.lng.toFixed(5)}
        </p>
        {outside && (
          <div className="banner" role="status">
            This pin is outside the NWS service area — orders to it will be refused. Move the pin to the delivery point.
          </div>
        )}
        <div className="form">
          <div className="fld">
            <label htmlFor="sLabel">Site name</label>
            <input id="sLabel" className="in" required maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Al Noor Hotel, Ruwi" />
          </div>
          <div className="fld">
            <label htmlFor="sArea">Area</label>
            <input id="sArea" className="in" maxLength={120} value={area} onChange={(e) => setArea(e.target.value)} placeholder="Ruwi" />
          </div>
          <div className="fld full">
            <label htmlFor="sAddr">Address and access notes</label>
            <input id="sAddr" className="in" maxLength={300} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Way 3109, service gate at the back" />
          </div>
          <div className="fld">
            <label htmlFor="sTank">Tank size (gallons)</label>
            <input id="sTank" className="in" type="number" min={100} max={100000} step={100} required value={tank} onChange={(e) => setTank(Number(e.target.value))} />
          </div>
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" disabled={busy === "save"}>
            {busy === "save" ? "Saving…" : "Save site"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
