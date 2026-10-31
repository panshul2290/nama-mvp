"use client";

// Driver profile additions: the photo customers see (0040), the tier and what the next one needs
// (0041), and the tanker's Naql vehicle and insurance papers (0041; the independent driver edits
// them, a company's driver sees them).
import { useCallback, useEffect, useRef, useState } from "react";
import { useDriver } from "@/components/DriverContext";
import { initials } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { shrinkPhoto } from "@/lib/photo";
import { supabase } from "@/lib/supabase/client";
import type { Tanker } from "@/lib/types";
import { DICT, useErrText, useFmt } from "./i18n";
import { Sheet } from "./Sheet";

export function DriverPhoto() {
  const { profile, toast } = useDriver();
  const t = useT(DICT);
  const errText = useErrText();
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const { data } = await supabase().from("driver_profiles").select("photo_path").eq("driver_id", profile.id).maybeSingle();
    const path = (data as { photo_path: string | null } | null)?.photo_path;
    if (!path) return setUrl(null);
    const s = await supabase().storage.from("driver-photos").createSignedUrl(path, 600);
    setUrl(s.data?.signedUrl ?? null);
  }, [profile.id]);
  useEffect(() => {
    const tm = setTimeout(load, 0);
    return () => clearTimeout(tm);
  }, [load]);

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const img = await shrinkPhoto(file);
      const path = `${profile.id}/${crypto.randomUUID()}.jpg`;
      const up = await supabase().storage.from("driver-photos").upload(path, img, { contentType: img.type || "image/jpeg" });
      if (up.error) throw new Error(t("uploadFailed"));
      const { error } = await supabase().rpc("set_driver_photo", { p_path: path });
      if (error) throw new Error(errText(error));
      toast(t("photoSaved"));
      load();
    } catch (e) {
      toast((e as Error).message || t("uploadFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="d-photo">
      {url ? (
        <span className="av photo">
          {/* eslint-disable-next-line @next/next/no-img-element -- a signed Storage link */}
          <img src={url} alt={t("myPhotoAlt")} />
        </span>
      ) : (
        <span className="av">{initials(profile.full_name)}</span>
      )}
      <button type="button" className="lk small" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? t("sending") : url ? t("photoChange") : t("photoAdd")}
      </button>
      <input ref={input} type="file" accept="image/*" capture="user" hidden onChange={(e) => pick(e.target.files?.[0])} />
    </span>
  );
}

type Tier = { tier: "bronze" | "silver" | "gold"; next: string | null; needs: { metric: string; have: number | null; need: number }[]; stats: Record<string, number | null> };

export function TierCard() {
  const t = useT(DICT);
  const f = useFmt();
  const [tier, setTier] = useState<Tier | null>(null);
  useEffect(() => {
    supabase()
      .rpc("my_driver_tier")
      .then(({ data }) => setTier((data as Tier) ?? null));
  }, []);
  if (!tier) return null;
  const v = (x: number | null | undefined) => (x == null ? "—" : f.d(String(x)));
  const pct = (x: number | null | undefined) => (x == null ? "—" : `${f.d(String(x))}%`);
  return (
    <div className="card" id="tier">
      <div className="row">
        <h4>{t("tierT")}</h4>
        <span className={`tier ${tier.tier}`}>{t(`tier_${tier.tier}`)}</span>
      </div>
      <p className="small">
        {t("tierStats", {
          jobs: v(tier.stats.jobs_30d),
          ontime: pct(tier.stats.on_time_pct),
          rating: v(tier.stats.rating),
          acc: pct(tier.stats.acceptance_pct),
        })}
      </p>
      {tier.next ? (
        <>
          <p className="small" style={{ marginTop: 6 }}>
            <b>{t("tierNext", { tier: t(`tier_${tier.next}`) })}</b>
          </p>
          <ul className="small" style={{ margin: "4px 0 0", paddingInlineStart: 18 }}>
            {tier.needs.map((n) => (
              <li key={n.metric}>{t(`tierNeed_${n.metric}`, { have: v(n.have), need: v(n.need) })}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="small okt">{t("tierTop")}</p>
      )}
      <p className="mut small" style={{ marginTop: 6 }}>
        {t("tierNote")}
      </p>
    </div>
  );
}

const VFIELDS: [keyof Tanker, string, "text" | "date" | "number"][] = [
  ["naql_reg_no", "vNaql", "text"],
  ["op_card_no", "vOpCard", "text"],
  ["op_card_expiry", "vOpCardExp", "date"],
  ["vin", "vVin", "text"],
  ["make", "vMake", "text"],
  ["model", "vModel", "text"],
  ["model_year", "vYear", "number"],
  ["tank_capacity_gal", "vCap", "number"],
  ["insurance_company", "vInsCo", "text"],
  ["insurance_policy_no", "vInsNo", "text"],
  ["insurance_expiry", "vInsExp", "date"],
  ["tracking_device_id", "vDevice", "text"],
];

export function VehicleCard() {
  const { tanker, refreshTanker, toast } = useDriver();
  const t = useT(DICT);
  const f = useFmt();
  const [edit, setEdit] = useState(false);
  const own = !tanker.company_id;
  const show = (k: keyof Tanker, kind: string) => {
    const x = tanker[k];
    if (x == null || x === "") return "—";
    return kind === "date" ? f.date(String(x)) : String(x);
  };
  return (
    <div className="card" id="vehicle">
      <div className="row">
        <h4>{t("vehicleT")}</h4>
        <span className={`st ${tanker.vehicle_status === "verified" ? "ok" : tanker.vehicle_status === "rejected" ? "bad" : "warn"}`}>{t(`vs_${tanker.vehicle_status ?? "unverified"}`)}</span>
      </div>
      {tanker.vehicle_note && <p className="small">{tanker.vehicle_note}</p>}
      {VFIELDS.map(([k, label, kind]) => (
        <div key={k} className="lrow">
          <span>{t(label)}</span>
          <small dir={kind === "text" ? "ltr" : undefined}>{show(k, kind)}</small>
        </div>
      ))}
      {tanker.capacity_verified_gal != null && <p className="small okt">{t("vCapVerified", { n: f.n(tanker.capacity_verified_gal) })}</p>}
      {own ? (
        <button className="btn pri" style={{ marginTop: 10 }} onClick={() => setEdit(true)}>
          {t("vEdit")}
        </button>
      ) : (
        <p className="mut small">{t("vOwnerEdits")}</p>
      )}
      {edit && (
        <VehicleSheet
          onClose={() => setEdit(false)}
          onSaved={() => {
            setEdit(false);
            refreshTanker();
            toast(t("vSaved"));
          }}
        />
      )}
    </div>
  );
}

function VehicleSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { tanker } = useDriver();
  const t = useT(DICT);
  const errText = useErrText();
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(VFIELDS.map(([k]) => [k, tanker[k] == null ? "" : String(tanker[k])])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const { error } = await supabase().rpc("save_tanker_vehicle", { p_tanker: tanker.id, p_v: v });
    setBusy(false);
    if (error) return setErr(errText(error));
    onSaved();
  }
  return (
    <Sheet label={t("vehicleT")} onClose={onClose}>
      <form onSubmit={save}>
        <h3>{t("vehicleT")}</h3>
        <p className="mut small">{t("vNote")}</p>
        {VFIELDS.map(([k, label, kind]) => (
          <div key={k} className="fld">
            <label htmlFor={`v-${k}`}>{t(label)}</label>
            <input id={`v-${k}`} type={kind} dir={kind === "text" ? "ltr" : undefined} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
          </div>
        ))}
        {err && <div className="banner badb">{err}</div>}
        <button className="cta" disabled={busy}>
          {busy ? t("saving") : t("vSend")}
        </button>
      </form>
    </Sheet>
  );
}
