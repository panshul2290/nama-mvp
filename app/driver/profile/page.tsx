"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useDriver } from "@/components/DriverContext";
import { DICT, useErrText, useFmt } from "@/components/driver/i18n";
import { permitState, usePermits } from "@/components/driver/permit";
import { Sheet } from "@/components/driver/Sheet";
import { useNow } from "@/components/driver/useNow";
import { LangToggle, useT } from "@/lib/i18n";
import { initials } from "@/lib/format";
import { supabase } from "@/lib/supabase/client";
import type { Device, TankerDocument } from "@/lib/types";

const DOC_KINDS = ["heavy_licence", "mulkiya", "tank_cleanliness", "rop_inspection", "insurance", "ivms_certificate", "water_test"] as const;
type DocKind = (typeof DOC_KINDS)[number];
type Shift = "day" | "evening" | "night";
type Avail = { weekday: number; available: boolean; shift: Shift };
const TRAINING = ["train0", "train1", "train2", "train3"];
const DAY = 86_400_000;

export default function DriverProfile() {
  const router = useRouter();
  const { profile, tanker, prefs, savePrefs, toast } = useDriver();
  const t = useT(DICT);
  const f = useFmt();
  const errText = useErrText();
  const now = useNow(60_000);
  const { rows: permits, reload: reloadPermits } = usePermits(tanker.id);
  const permit = permits && now ? permitState(permits, tanker.service_type, now) : null;
  const [company, setCompany] = useState<string | null>(null);
  const [device, setDevice] = useState<Device | null | undefined>(undefined);
  const [docs, setDocs] = useState<TankerDocument[]>([]);
  const [avail, setAvail] = useState<Avail[]>([]);
  const [upload, setUpload] = useState<DocKind | null>(null);
  const [busy, setBusy] = useState(false);

  const loadDocs = useCallback(() => {
    supabase()
      .from("tanker_documents")
      .select("*")
      .order("uploaded_at", { ascending: false })
      .then(({ data }) => setDocs((data ?? []) as TankerDocument[]));
  }, []);

  useEffect(() => {
    const db = supabase();
    if (tanker.company_id)
      db.from("companies")
        .select("name")
        .eq("id", tanker.company_id)
        .maybeSingle()
        .then(({ data }) => setCompany(data?.name ?? null));
    db.from("devices")
      .select("*")
      .eq("tanker_id", tanker.id)
      .maybeSingle()
      .then(({ data }) => setDevice((data as Device) ?? null));
    db.from("driver_availability")
      .select("weekday, available, shift")
      .eq("driver_id", profile.id)
      .then(({ data }) => setAvail((data ?? []) as Avail[]));
    const t0 = setTimeout(loadDocs, 0);
    return () => clearTimeout(t0);
  }, [tanker.id, tanker.company_id, profile.id, loadDocs]);

  async function renew() {
    setBusy(true);
    const { error } = await supabase().rpc("apply_permit");
    setBusy(false);
    if (error) return toast(errText(error));
    toast(t("renewalSent"));
    reloadPermits();
  }

  // Days without a row are available on the day shift (the table defaults).
  const dayOf = (d: number): Avail => avail.find((a) => a.weekday === d) ?? { weekday: d, available: true, shift: "day" };
  async function setDay(d: number, patch: Partial<Avail>) {
    const next = { ...dayOf(d), ...patch };
    setAvail((as) => [...as.filter((a) => a.weekday !== d), next]);
    const { error } = await supabase().rpc("set_availability", { p_weekday: d, p_available: next.available, p_shift: next.shift });
    if (error) toast(errText(error));
  }

  const watched = prefs.training ?? [];
  async function watch(i: number) {
    toast(t("trainingPlays"));
    if (!watched.includes(i)) await savePrefs({ training: [...watched, i] });
  }

  async function signOut() {
    await supabase().auth.signOut();
    router.replace("/login");
  }

  const docState = (d: TankerDocument | undefined): [string, string] => {
    if (!d) return [t("docMissing"), "bad"];
    if (d.status === "pending_review") return [t("docPending"), "warn"];
    if (d.status === "rejected") return [t("docRejected"), "bad"];
    const left = now ? (Date.parse(d.valid_to) - now) / DAY : 99;
    if (left < 0) return [t("docExpired"), "bad"];
    if (left <= 30) return [t("docExpiring"), "warn"];
    return [t("docValid"), "ok"];
  };
  const permitTone = permit?.key === "valid" ? "ok" : permit?.key === "expiring" ? "warn" : "bad";
  const sensors = device ? Object.values(device.sensors ?? {}) : [];

  return (
    <main className="screen">
      <div className="ptop">
        <h3>{t("tProfile")}</h3>
        <LangToggle />
      </div>
      <div className="dcard">
        <div className="dc-top">
          <span className="av">{initials(profile.full_name)}</span>
          <div>
            <b>{profile.full_name || t("driver")}</b>
            <small>
              {company ? `${company} · ` : ""}
              <span dir="ltr">{profile.phone || t("noPhone")}</span>
            </small>
          </div>
        </div>
      </div>

      <h4 className="ch-sec">{t("tanker")}</h4>
      <div className="ch-list">
        <div className="lrow">
          <span>
            {t("plate")}
            <small>{t(`svc_${tanker.service_type}`)}</small>
          </span>
          <span className="plate">{tanker.plate}</span>
        </div>
        <div className="lrow">
          <span>
            {t("capacity")}
            <small>
              {f.n(tanker.capacity_gal)} {t("gallons")}
            </small>
          </span>
          <span className={`tag ${tanker.service_type}`}>{t(`svc_${tanker.service_type}`)}</span>
        </div>
        <div className="lrow">
          <span>
            {t("ivms")}
            <small>
              {device === undefined
                ? t("loading")
                : device
                  ? t("ivmsX", { id: device.id, fw: device.firmware, n: f.d(sensors.filter(Boolean).length), m: f.d(sensors.length), date: f.date(device.installed_at) })
                  : t("noDevice")}
            </small>
          </span>
          {device && <span className="st ok">{t("reporting")}</span>}
        </div>
      </div>

      <div className="card" id="permit">
        <div className="row">
          <h4>{permit?.current ? t("permitX", { no: permit.current.permit_no }) : t("permit")}</h4>
          {permit && <span className={`st ${permitTone}`}>{t(`permit_${permit.key}`)}</span>}
        </div>
        <p>
          <bdi>{tanker.plate}</bdi> · {t(`svc_${tanker.service_type}`)}
          {permit?.current ? ` · ${t(permit.key === "expired" ? "expiredOn" : "validUntil", { date: f.date(permit.current.expires_at) })}` : ""}
        </p>
        {permit?.pending && (
          <p style={{ marginTop: 6 }}>
            <span className="st warn">{t("renewalStage", { stage: t(`stage_${permit.pending.stage ?? "submitted"}`) })}</span>
            {permit.pending.info_requested && <span className="d-block small">{t("infoRequested", { text: permit.pending.info_requested })}</span>}
          </p>
        )}
        {permit && !permit.pending && (
          <button className="btn pri" style={{ marginTop: 10 }} disabled={busy} onClick={renew}>
            {busy ? t("sending") : t("submitRenewal")}
          </button>
        )}
      </div>

      <h4 className="d-h4">{t("documents")}</h4>
      {DOC_KINDS.map((k) => {
        const d = docs.find((x) => x.kind === k && (k === "heavy_licence" ? x.driver_id === profile.id : x.tanker_id === tanker.id));
        const [label, tone] = docState(d);
        return (
          <div key={k} className="lrow">
            <span>
              {t(`doc_${k}`)}
              <small>{d ? `${d.ref_no ? `${d.ref_no} · ` : ""}${t("validTo", { date: f.date(d.valid_to) })}` : t("notOnFile")}</small>
            </span>
            <span className="d-docact">
              <span className={`st ${tone}`}>{label}</span>
              <button className="btn sm" onClick={() => setUpload(k)}>
                {t("uploadNew")}
              </button>
            </span>
          </div>
        );
      })}

      <h4 className="d-h4">{t("availability")}</h4>
      <div className="opts">
        {[0, 1, 2, 3, 4, 5, 6].map((d) => (
          <button key={d} type="button" className={`opt ${dayOf(d).available ? "on" : ""}`} aria-pressed={dayOf(d).available} onClick={() => setDay(d, { available: !dayOf(d).available })}>
            {t(`wd${d}`)}
          </button>
        ))}
      </div>
      {[0, 1, 2, 3, 4, 5, 6]
        .filter((d) => dayOf(d).available)
        .map((d) => (
          <div key={d} className="lrow">
            <span>{t(`wdLong${d}`)}</span>
            <select className="d-sel" aria-label={t("shiftFor", { day: t(`wdLong${d}`) })} value={dayOf(d).shift} onChange={(e) => setDay(d, { shift: e.target.value as Shift })}>
              {(["day", "evening", "night"] as Shift[]).map((s) => (
                <option key={s} value={s}>
                  {t(`shift_${s}`)}
                </option>
              ))}
            </select>
          </div>
        ))}
      <p className="mut small">{t("availNote")}</p>

      <h4 className="d-h4">{t("training")}</h4>
      {TRAINING.map((k, i) => (
        <button key={k} type="button" className="lrow" onClick={() => watch(i)}>
          <span>{t(k)}</span>
          {watched.includes(i) ? <span className="st ok">{t("watched")}</span> : <span className="st warn">{t("watch")}</span>}
        </button>
      ))}

      <h4 className="d-h4">{t("language")}</h4>
      <div className="lrow">
        <span>
          {t("languageS")}
          <small>English · العربية</small>
        </span>
        <LangToggle />
      </div>

      <button className="cta danger" style={{ marginTop: 18 }} onClick={signOut}>
        {t("signOut")}
      </button>

      {upload && (
        <UploadSheet
          kind={upload}
          onClose={() => setUpload(null)}
          onDone={() => {
            setUpload(null);
            loadDocs();
          }}
        />
      )}
    </main>
  );
}

/** Upload a new document: the file goes to storage (evidence/<uid>/<uuid>), then add_document() records it for NWS review. */
function UploadSheet({ kind, onClose, onDone }: { kind: DocKind; onClose: () => void; onDone: () => void }) {
  const { profile, toast } = useDriver();
  const t = useT(DICT);
  const errText = useErrText();
  const [refNo, setRefNo] = useState("");
  const [validTo, setValidTo] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
    const path = `${profile.id}/${crypto.randomUUID()}.${ext}`;
    const up = await supabase().storage.from("evidence").upload(path, file, { contentType: file.type || undefined });
    if (up.error) {
      setBusy(false);
      return toast(t("uploadFailed"));
    }
    const { error } = await supabase().rpc("add_document", { p_kind: kind, p_ref_no: refNo.trim(), p_valid_to: validTo, p_file_path: path });
    setBusy(false);
    if (error) return toast(errText(error));
    toast(t("docSent"));
    onDone();
  }

  return (
    <Sheet label={t("uploadX", { doc: t(`doc_${kind}`) })} onClose={onClose}>
      <form onSubmit={save}>
        <div className="row">
          <h3 className="d-st">{t(`doc_${kind}`)}</h3>
          <button type="button" className="btn sm" onClick={onClose}>
            {t("close")}
          </button>
        </div>
        <p className="mut small">{t("uploadNote")}</p>
        <div className="fld">
          <label htmlFor="doc-ref">{t("refNo")}</label>
          <input id="doc-ref" maxLength={60} value={refNo} onChange={(e) => setRefNo(e.target.value)} />
        </div>
        <div className="fld">
          <label htmlFor="doc-valid">{t("validToL")}</label>
          <input id="doc-valid" type="date" required value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        </div>
        <div className="fld">
          <label htmlFor="doc-file">{t("file")}</label>
          <input id="doc-file" type="file" accept="image/*,application/pdf" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <button className="cta" disabled={busy || !file || !validTo}>
          {busy ? t("sending") : t("submitDoc")}
        </button>
      </form>
    </Sheet>
  );
}
