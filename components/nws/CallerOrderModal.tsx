"use client";

// "New order for a caller" (Genesys call centre): the agent finds the caller, drops a pin and
// places the order on their behalf through staff_place_order (cash on delivery).
import { useEffect, useMemo, useState } from "react";
import { Map } from "@/components/Map";
import { maskPhone, Modal } from "@/components/nws/ops";
import { useStaff } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import { SERVICE_LABEL, VOLUME_PRESETS, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import type { LngLat } from "@/lib/types";

type Caller = { id: string; full_name: string; phone: string | null; account_blocked: boolean };
type Property = { id: string; label: string; address: string; area: string; lat: number; lng: number; tank_gal: number };
type Zone = { name: string; center_lat: number; center_lng: number; radius_km: number };
type Placed = { id: string; order_no: number };

const MUSCAT: LngLat = { lat: 23.588, lng: 58.3829 };

function km(a: LngLat, b: LngLat) {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export function CallerOrderModal({ genesysId, onClose, onPlaced }: { genesysId: string; onClose: () => void; onPlaced: (o: Placed) => void }) {
  const { toast } = useStaff();
  const [q, setQ] = useState("");
  const [callers, setCallers] = useState<Caller[]>([]);
  const [caller, setCaller] = useState<Caller | null>(null);
  const [props, setProps] = useState<Property[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [pin, setPin] = useState<LngLat>(MUSCAT);
  const [center, setCenter] = useState<LngLat>(MUSCAT);
  const [type, setType] = useState<ServiceType>("DW");
  const [gallons, setGallons] = useState(3000);
  const [area, setArea] = useState("");
  const [address, setAddress] = useState("");
  const [gx, setGx] = useState(genesysId);
  const [emergency, setEmergency] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase()
      .from("zones")
      .select("name, center_lat, center_lng, radius_km")
      .eq("active", true)
      .eq("is_test", false) // call-centre callers are in Oman
      .then(({ data }) => setZones((data ?? []) as Zone[]));
  }, []);

  // Caller lookup by name or mobile (screen pop would prefill this from Genesys).
  useEffect(() => {
    const s = q.trim().replace(/[,()%]/g, "");
    const t = setTimeout(async () => {
      let query = supabase().from("profiles").select("id, full_name, phone, account_blocked").eq("role", "customer").order("full_name").limit(8);
      if (s) query = query.or(`full_name.ilike.%${s}%,phone.ilike.%${s}%`);
      const { data } = await query;
      setCallers((data ?? []) as Caller[]);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  async function choose(c: Caller) {
    setCaller(c);
    const { data } = await supabase().from("properties").select("id, label, address, area, lat, lng, tank_gal").eq("customer_id", c.id).order("created_at");
    const list = (data ?? []) as Property[];
    setProps(list);
    if (list[0]) applyProperty(list[0]);
  }
  function applyProperty(p: Property) {
    setPin({ lat: p.lat, lng: p.lng });
    setCenter({ lat: p.lat, lng: p.lng });
    setArea(p.area || p.label);
    setAddress(p.address);
  }

  const zone = useMemo(
    () =>
      zones
        .map((z) => ({ z, d: km(pin, { lat: z.center_lat, lng: z.center_lng }) }))
        .filter((x) => x.d <= x.z.radius_km)
        .sort((a, b) => a.d - b.d)[0]?.z ?? null,
    [zones, pin],
  );
  const pick = useMemo(() => ({ value: pin, onChange: setPin }), [pin]);

  async function submit() {
    if (!caller) return;
    setBusy(true);
    const { data, error } = await supabase().rpc("staff_place_order", {
      p_customer_id: caller.id,
      p_service_type: type,
      p_gallons: gallons,
      p_lat: pin.lat,
      p_lng: pin.lng,
      p_area: area.trim() || zone?.name || "",
      p_address: address,
      p_genesys_id: gx,
      p_emergency: emergency,
    });
    setBusy(false);
    if (error) return toast(friendlyError(error), true);
    onPlaced(data as Placed);
  }

  return (
    <Modal title="New order for a caller" wide onClose={onClose}>
      <p>Genesys call centre: the order is placed for the caller’s account, priced from the tariff and paid in cash on delivery.</p>
      <div className="grid2">
        <div>
          <div className="fld">
            <label htmlFor="cq">Caller (name or mobile)</label>
            <input id="cq" className="in" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Fatma or 9123" autoFocus />
          </div>
          <div className="picklist" role="listbox" aria-label="Customers">
            {callers.length === 0 && <span className="mut" style={{ fontSize: 13 }}>No customers match.</span>}
            {callers.map((c) => (
              <button key={c.id} type="button" className={`pickrow ${caller?.id === c.id ? "on" : ""}`} onClick={() => choose(c)}>
                <span>
                  <b>{c.full_name || "Customer"}</b> {c.account_blocked && <span className="st bad ptag">Blocked</span>}
                </span>
                <small className="mut">{maskPhone(c.phone)}</small>
              </button>
            ))}
          </div>
          {props.length > 0 && (
            <div className="fld">
              <label>Saved properties</label>
              <div className="chips">
                {props.map((p) => (
                  <button key={p.id} type="button" className="chip" onClick={() => applyProperty(p)}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="fld">
            <label htmlFor="gx">Genesys interaction ID</label>
            <input id="gx" className="in" value={gx} onChange={(e) => setGx(e.target.value)} />
          </div>
        </div>
        <div>
          <div className="minimap">
            <Map center={center} pick={pick} hint="Click the map or drag the pin to the delivery point" theme="dark" />
          </div>
          <p className="mut" style={{ fontSize: 12.5, margin: "-4px 0 12px" }}>
            {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)} · {zone ? `Zone: ${zone.name}` : <span style={{ color: "var(--bad)" }}>Outside active service zones</span>}
          </p>
        </div>
      </div>
      <div className="grid2">
        <div className="fld">
          <label htmlFor="sv">Service</label>
          <select
            id="sv"
            className="in"
            value={type}
            onChange={(e) => {
              const t = e.target.value as ServiceType;
              setType(t);
              setGallons(VOLUME_PRESETS[t][1] ?? VOLUME_PRESETS[t][0]);
            }}
          >
            {(["DW", "WW", "TE"] as ServiceType[]).map((t) => (
              <option key={t} value={t}>
                {SERVICE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="gl">Gallons</label>
          <input id="gl" className="in" type="number" min={1} max={20000} value={gallons} onChange={(e) => setGallons(Number(e.target.value))} />
          <div className="chips" style={{ marginTop: 6 }}>
            {VOLUME_PRESETS[type].map((v) => (
              <button key={v} type="button" className={`chip ${gallons === v ? "on" : ""}`} onClick={() => setGallons(v)}>
                {v.toLocaleString()}
              </button>
            ))}
          </div>
        </div>
        <div className="fld">
          <label htmlFor="ar">Area</label>
          <input id="ar" className="in" value={area} onChange={(e) => setArea(e.target.value)} placeholder={zone?.name ?? "Neighbourhood"} />
        </div>
        <div className="fld">
          <label htmlFor="ad">Address / directions</label>
          <input id="ad" className="in" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Building, way number, landmark" />
        </div>
      </div>
      <label className="mut" style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 14 }}>
        <input type="checkbox" checked={emergency} onChange={(e) => setEmergency(e.target.checked)} /> Emergency / priority request (priority multiplier on the delivery fee)
      </label>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn pri" disabled={busy || !caller || !zone || gallons < 1} onClick={submit}>
          {busy ? "Placing…" : "Place order"}
        </button>
      </div>
    </Modal>
  );
}
