"use client";

// "New order for a caller" (Genesys call centre): the agent finds the caller, drops a pin and
// places the order on their behalf through staff_place_order (cash on delivery).
import { useEffect, useMemo, useState } from "react";
import { Map } from "@/components/Map";
import { OPS } from "@/components/nws/i18n/ops";
import { maskPhone, Modal } from "@/components/nws/ops";
import { useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { friendlyError } from "@/lib/errors";
import { localDigits, useLang, useT, type Lang } from "@/lib/i18n";
import { serviceLabel } from "@/lib/labels";
import { VOLUME_PRESETS, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import type { LngLat } from "@/lib/types";

type Caller = { id: string; full_name: string; phone: string | null; account_blocked: boolean };
type Property = { id: string; label: string; address: string; area: string; lat: number; lng: number; tank_gal: number };
type Zone = { name: string; center_lat: number; center_lng: number; radius_km: number };
type Placed = { id: string; order_no: number };

const MUSCAT: LngLat = { lat: 23.588, lng: 58.3829 };

// Two-hour delivery windows, 8 am – 8 pm Muscat time (UTC+4), today and tomorrow; past ones left out.
// `label` is the English slot label stored on the order; `day`/`hour` word it on screen.
type Win = { label: string; start: string; end: string; day: 0 | 1; hour: number };
function windows(now: number): Win[] {
  const MCT = 4 * 3_600_000;
  const local = new Date(now + MCT);
  const day0 = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - MCT; // Muscat midnight, as UTC ms
  const fmt = (h: number) => (h === 12 ? "12 pm" : h > 12 ? `${h - 12} pm` : `${h} am`);
  const out: Win[] = [];
  for (const [d, name] of [[0, "Today"], [1, "Tomorrow"]] as const)
    for (let h = 8; h < 20; h += 2) {
      const start = day0 + d * 86_400_000 + h * 3_600_000;
      if (start + 2 * 3_600_000 <= now + 30 * 60_000) continue;
      out.push({ label: `${name} ${fmt(h)}–${fmt(h + 2)}`, start: new Date(start).toISOString(), end: new Date(start + 2 * 3_600_000).toISOString(), day: d, hour: h });
    }
  return out;
}

/** "8 ص–10 ص" in Arabic (the English label otherwise). */
function winText(w: Win, lang: Lang, t: (k: string) => string) {
  if (lang !== "ar") return w.label;
  const h12 = (h: number) => `${localDigits(h > 12 ? h - 12 : h, lang)} ${h >= 12 ? "م" : "ص"}`;
  return `${t(w.day === 0 ? "coToday" : "coTomorrow")} ${h12(w.hour)}–${h12(w.hour + 2)}`;
}

function km(a: LngLat, b: LngLat) {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export function CallerOrderModal({ genesysId, onClose, onPlaced }: { genesysId: string; onClose: () => void; onPlaced: (o: Placed) => void }) {
  const { toast } = useStaff();
  const t = useT(OPS);
  const f = useFmt();
  const { lang } = useLang();
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
  const [wins] = useState(() => windows(Date.now()));
  const [win, setWin] = useState(""); // "" = as soon as possible
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

  const chosen = wins.find((x) => x.start === win) ?? null;

  async function submit() {
    if (!caller || caller.account_blocked) return;
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
      p_slot_start: chosen?.start ?? null,
      p_slot_end: chosen?.end ?? null,
      p_slot_label: chosen?.label ?? null,
    });
    setBusy(false);
    if (error) return toast(friendlyError(error, lang), true);
    onPlaced(data as Placed);
  }

  return (
    <Modal title={t("coTitle")} wide onClose={onClose}>
      <p>{t("coIntro")}</p>
      <div className="grid2">
        <div>
          <div className="fld">
            <label htmlFor="cq">{t("coCaller")}</label>
            <input id="cq" className="in" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("coCallerPh")} autoFocus />
          </div>
          <div className="picklist" role="listbox" aria-label={t("coCustomers")}>
            {callers.length === 0 && <span className="mut" style={{ fontSize: 13 }}>{t("coNoCustomers")}</span>}
            {callers.map((c) => (
              <button key={c.id} type="button" className={`pickrow ${caller?.id === c.id ? "on" : ""}`} disabled={c.account_blocked} title={c.account_blocked ? t("coBlockedTip") : undefined} onClick={() => choose(c)}>
                <span>
                  <b>{c.full_name || t("customer")}</b> {c.account_blocked && <span className="st bad ptag">{t("coBlocked")}</span>}
                </span>
                <small className="mut" dir="ltr">{maskPhone(c.phone)}</small>
              </button>
            ))}
          </div>
          {props.length > 0 && (
            <div className="fld">
              <label>{t("coProps")}</label>
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
            <label htmlFor="gx">{t("coGx")}</label>
            <input id="gx" className="in" dir="ltr" value={gx} onChange={(e) => setGx(e.target.value)} />
          </div>
        </div>
        <div>
          <div className="minimap">
            <Map center={center} pick={pick} hint={t("coMapHint")} theme="dark" />
          </div>
          <p className="mut" style={{ fontSize: 12.5, margin: "-4px 0 12px" }}>
            <span dir="ltr">
              {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}
            </span>{" "}
            · {zone ? t("coZone", { zone: zone.name }) : <span style={{ color: "var(--bad)" }}>{t("coOutside")}</span>}
          </p>
        </div>
      </div>
      <div className="grid2">
        <div className="fld">
          <label htmlFor="sv">{t("service")}</label>
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
            {(["DW", "WW", "TE"] as ServiceType[]).map((s) => (
              <option key={s} value={s}>
                {serviceLabel(s, lang)}
              </option>
            ))}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="gl">{t("gallons")}</label>
          <input id="gl" className="in" type="number" min={1} max={20000} value={gallons} onChange={(e) => setGallons(Number(e.target.value))} />
          <div className="chips" style={{ marginTop: 6 }}>
            {VOLUME_PRESETS[type].map((v) => (
              <button key={v} type="button" className={`chip ${gallons === v ? "on" : ""}`} onClick={() => setGallons(v)}>
                {f.n(v)}
              </button>
            ))}
          </div>
        </div>
        <div className="fld">
          <label htmlFor="ar">{t("coArea")}</label>
          <input id="ar" className="in" value={area} onChange={(e) => setArea(e.target.value)} placeholder={zone?.name ?? t("coAreaPh")} />
        </div>
        <div className="fld">
          <label htmlFor="ad">{t("coAddress")}</label>
          <input id="ad" className="in" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t("coAddressPh")} />
        </div>
        <div className="fld">
          <label htmlFor="wn">{t("coWindow")}</label>
          <select id="wn" className="in" value={win} onChange={(e) => setWin(e.target.value)}>
            <option value="">{t("coAsap")}</option>
            {wins.map((x) => (
              <option key={x.start} value={x.start}>
                {winText(x, lang, t)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label className="mut" style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 14 }}>
        <input type="checkbox" checked={emergency} onChange={(e) => setEmergency(e.target.checked)} /> {t("coEmergency")}
      </label>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose} disabled={busy}>
          {t("cancel")}
        </button>
        <button className="btn pri" disabled={busy || !caller || caller.account_blocked || !zone || gallons < 1} onClick={submit}>
          {busy ? t("coPlacing") : t("coPlace")}
        </button>
      </div>
    </Modal>
  );
}
