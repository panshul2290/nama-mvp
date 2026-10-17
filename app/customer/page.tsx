"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Map } from "@/components/Map";
import { PriceLines, StatusPill, TypeTag } from "@/components/OrderBits";
import { Loading, TopBar } from "@/components/Shell";
import { useProfile } from "@/components/useProfile";
import { friendlyError } from "@/lib/errors";
import { currentPosition, DEFAULT_CENTER, reverseGeocodeArea } from "@/lib/geo";
import { omrValue, quote, SERVICE_LABEL, VOLUME_PRESETS, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { ACTIVE_STATUSES, type LngLat, type Order } from "@/lib/types";

export default function CustomerHome() {
  const router = useRouter();
  const profile = useProfile("customer");
  const [checking, setChecking] = useState(true);
  const [recent, setRecent] = useState<Order[]>([]);

  const [center, setCenter] = useState<LngLat>(DEFAULT_CENTER);
  const [point, setPoint] = useState<LngLat>(DEFAULT_CENTER);
  const [gpsNote, setGpsNote] = useState<string | null>(null);
  const [type, setType] = useState<ServiceType>("DW");
  const [gallons, setGallons] = useState(1000);
  const [area, setArea] = useState("");
  const areaTouched = useRef(false);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // An order in progress takes over the screen.
  useEffect(() => {
    if (!profile) return;
    supabase()
      .from("orders")
      .select("*")
      .eq("customer_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(6)
      .then(({ data }) => {
        const orders = (data ?? []) as Order[];
        const active = orders.find((o) => ACTIVE_STATUSES.includes(o.status));
        if (active) return router.replace(`/customer/orders/${active.id}`);
        setRecent(orders);
        setChecking(false);
      });
  }, [profile, router]);

  function applyPosition(p: LngLat | null) {
    if (!p) return setGpsNote("Couldn’t get your location — drag the pin or tap the map instead.");
    setGpsNote(null);
    setCenter(p);
    setPoint(p);
  }
  const locate = () => currentPosition().then(applyPosition);

  // Default the pin to the current GPS fix.
  useEffect(() => {
    currentPosition().then(applyPosition);
  }, []);

  // Suggest the area name from the pin; the customer can overwrite it.
  useEffect(() => {
    if (areaTouched.current) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      const name = await reverseGeocodeArea(point, ctl.signal);
      if (name && !areaTouched.current) setArea(name);
    }, 600);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [point]);

  const q = useMemo(() => quote(type, gallons || 0), [type, gallons]);
  const validGallons = Number.isInteger(gallons) && gallons >= 1 && gallons <= 20000;

  function pickType(t: ServiceType) {
    setType(t);
    if (!VOLUME_PRESETS[t].includes(gallons)) setGallons(VOLUME_PRESETS[t][0]);
  }

  async function place() {
    setBusy(true);
    setError(null);
    const { data, error } = await supabase()
      .rpc("place_order", {
        p_service_type: type,
        p_gallons: gallons,
        p_lat: point.lat,
        p_lng: point.lng,
        p_area: area,
        p_address: address,
      })
      .single<Order>();
    setBusy(false);
    if (error || !data) return setError(friendlyError(error));
    router.push(`/customer/orders/${data.id}`);
  }

  if (!profile || checking) return <Loading />;

  return (
    <>
      <TopBar subtitle={profile.full_name || "Customer"} />
      <main className="screen flush">
        <Map
          center={center}
          pick={{ value: point, onChange: setPoint }}
          hint="Drag the pin or tap the map to set the delivery point"
          onLocate={locate}
        />
        <section className="sheet">
          <div className="ptop">
            <h3>Request a tanker</h3>
          </div>
          {gpsNote && <div className="note">{gpsNote}</div>}

          <div className="fld">
            <span className="lbl">Service</span>
            <div className="seg" role="radiogroup" aria-label="Service type">
              {(Object.keys(SERVICE_LABEL) as ServiceType[]).map((t) => (
                <button key={t} type="button" role="radio" aria-checked={type === t} className={type === t ? "on" : ""} onClick={() => pickType(t)}>
                  {t}
                </button>
              ))}
            </div>
            <p className="small" style={{ marginTop: -6 }}>
              <TypeTag type={type} long />
            </p>
          </div>

          <div className="fld">
            <label htmlFor="gal">Volume (gallons)</label>
            <div className="opts" style={{ marginBottom: 8 }}>
              {VOLUME_PRESETS[type].map((v) => (
                <button key={v} type="button" className={`opt ${gallons === v ? "on" : ""}`} onClick={() => setGallons(v)}>
                  {v.toLocaleString()}
                </button>
              ))}
            </div>
            <input id="gal" type="number" inputMode="numeric" min={1} max={20000} step={1} value={gallons || ""} onChange={(e) => setGallons(Math.floor(Number(e.target.value)))} />
          </div>

          <div className="fld">
            <label htmlFor="area">Area</label>
            <input
              id="area"
              required
              maxLength={120}
              placeholder="e.g. Al Khoud"
              value={area}
              onChange={(e) => {
                areaTouched.current = true;
                setArea(e.target.value);
              }}
            />
          </div>
          <div className="fld">
            <label htmlFor="addr">Building, villa or landmark</label>
            <input id="addr" maxLength={300} placeholder="Shared with your driver after they accept" value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>

          <div className="card">
            <PriceLines quote={q} gallons={gallons || 0} />
          </div>

          {error && <div className="note bad">{error}</div>}
          <button className="cta" disabled={busy || !validGallons || !area.trim()} onClick={place}>
            {busy ? "Placing request…" : "Place request"}
          </button>

          {recent.length > 0 && (
            <>
              <h4 style={{ margin: "18px 0 8px" }}>Recent orders</h4>
              {recent.map((o) => (
                <Link key={o.id} href={`/customer/orders/${o.id}`} className="card" style={{ color: "inherit", fontWeight: 400 }}>
                  <div className="row">
                    <h4>
                      <TypeTag type={o.service_type} /> {o.gallons.toLocaleString()} gal
                    </h4>
                    <StatusPill status={o.status} />
                  </div>
                  <p>
                    {o.area} · {new Date(o.created_at).toLocaleDateString()} · {omrValue(o.total)}
                  </p>
                </Link>
              ))}
            </>
          )}
        </section>
      </main>
    </>
  );
}
