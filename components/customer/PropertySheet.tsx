"use client";

import { useEffect, useRef, useState } from "react";
import { AddressDetailsForm } from "@/components/AddressDetailsForm";
import { Map } from "@/components/Map";
import { contactPhoneOk, detailsFromRow, detailsPayload, type DetailsForm } from "@/lib/address";
import { friendlyError } from "@/lib/errors";
import { currentPosition, DEFAULT_CENTER, reverseGeocodeArea } from "@/lib/geo";
import { supabase } from "@/lib/supabase/client";
import type { LngLat, Property } from "@/lib/types";
import { useCx } from "./i18n";
import { Sheet } from "./ui";

const TANKS = [1000, 3000, 5000, 10000];

/** Add (or edit) a property: map pin, label, address, tank size → save_property; optional details → set_property_details. */
export function PropertySheet({ initial, onClose, onSaved }: { initial?: Property | null; onClose: () => void; onSaved: (p: Property) => void }) {
  const { t } = useCx();
  const start = initial ? { lat: initial.lat, lng: initial.lng } : DEFAULT_CENTER;
  const [center, setCenter] = useState<LngLat>(start);
  const [point, setPoint] = useState<LngLat>(start);
  const [label, setLabel] = useState(initial?.label ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [area, setArea] = useState(initial?.area ?? "");
  const areaTouched = useRef(Boolean(initial));
  const [tank, setTank] = useState(initial?.tank_gal ?? 3000);
  const [details, setDetails] = useState<DetailsForm>(() => detailsFromRow(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locate = () =>
    currentPosition().then((p) => {
      if (!p) return;
      setCenter(p);
      setPoint(p);
    });

  // A new property starts at the current GPS fix.
  const isNew = !initial;
  useEffect(() => {
    if (!isNew) return;
    currentPosition().then((p) => {
      if (!p) return;
      setCenter(p);
      setPoint(p);
    });
  }, [isNew]);

  useEffect(() => {
    if (areaTouched.current) return;
    const ctl = new AbortController();
    const tm = setTimeout(async () => {
      const name = await reverseGeocodeArea(point, ctl.signal);
      if (name && !areaTouched.current) setArea(name);
    }, 600);
    return () => {
      clearTimeout(tm);
      ctl.abort();
    };
  }, [point]);

  async function save() {
    setBusy(true);
    setError(null);
    const { data, error } = await supabase()
      .rpc("save_property", {
        p_id: initial?.id ?? null,
        p_label: label.trim(),
        p_address: address.trim(),
        p_area: area.trim(),
        p_lat: point.lat,
        p_lng: point.lng,
        p_tank_gal: tank,
      })
      .single<Property>();
    if (error || !data) {
      setBusy(false);
      return setError(friendlyError(error));
    }
    const d = await supabase().rpc("set_property_details", { p_id: data.id, p_details: detailsPayload(details) }).single<Property>();
    setBusy(false);
    if (d.error) return setError(friendlyError(d.error));
    onSaved(d.data ?? data);
  }

  return (
    <Sheet title={initial ? t("editProp") : t("addProp")} onClose={onClose}>
      <div className="rq-map" style={{ height: 200 }}>
        <Map center={center} pick={{ value: point, onChange: setPoint }} hint={t("pin")} onLocate={locate} />
      </div>
      <div className="fld">
        <label htmlFor="npL">{t("profName")}</label>
        <input id="npL" maxLength={80} placeholder={t("profNamePh")} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="fld">
        <label htmlFor="npA">{t("address")}</label>
        <input id="npA" maxLength={300} placeholder={t("addressPh")} value={address} onChange={(e) => setAddress(e.target.value)} />
      </div>
      <div className="fld">
        <label htmlFor="npR">{t("area")}</label>
        <input
          id="npR"
          maxLength={120}
          value={area}
          onChange={(e) => {
            areaTouched.current = true;
            setArea(e.target.value);
          }}
        />
      </div>
      <div className="fld">
        <span className="lbl">{t("tank")}</span>
        <div className="opts">
          {TANKS.map((v) => (
            <button key={v} type="button" className={`opt ${tank === v ? "on" : ""}`} onClick={() => setTank(v)}>
              {v.toLocaleString("en-US")}
            </button>
          ))}
        </div>
      </div>
      <AddressDetailsForm value={details} onChange={setDetails} />
      {error && <div className="banner badb">{error}</div>}
      <button className="cta" disabled={busy || !label.trim() || !contactPhoneOk(details)} onClick={save}>
        {busy ? t("saving") : t("save")}
      </button>
    </Sheet>
  );
}
