"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useDriver, type IssueKind } from "@/components/DriverContext";
import { DICT, useFmt } from "@/components/driver/i18n";
import { Sheet } from "@/components/driver/Sheet";
import { Icon } from "@/components/icons";
import { distanceKm } from "@/lib/geo";
import { useT } from "@/lib/i18n";
import { nativeCamera, nativePhoto, PhotoError, shrinkPhoto, type PhotoSource } from "@/lib/photo";
import { POD_FAR_M } from "@/lib/podLocation";
import { supabase } from "@/lib/supabase/client";
import type { Fix } from "@/lib/tracking";

const SIG_W = 300;
const SIG_H = 120;
const SIG_MAX = 58_000; // pods.signature_svg allows 60,000 characters

/** SHA-256 of the photo, hex — recorded with the proof so a re-used photo is detectable. */
async function sha256Hex(file: Blob): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Finger signature captured with pointer events as an SVG path ("M x y L x y …" in a 300×120 box). */
function SignaturePad({ value, setValue, label }: { value: string; setValue: Dispatch<SetStateAction<string>>; label: string }) {
  const drawing = useRef(false);
  const pt = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * SIG_W);
    const y = Math.round(((e.clientY - r.top) / r.height) * SIG_H);
    return `${Math.min(SIG_W, Math.max(0, x))} ${Math.min(SIG_H, Math.max(0, y))}`;
  };
  return (
    <svg
      className="d-sig"
      viewBox={`0 0 ${SIG_W} ${SIG_H}`}
      role="img"
      aria-label={label}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drawing.current = true;
        const p = pt(e);
        setValue((v) => (v.length < SIG_MAX ? `${v}M${p}` : v));
      }}
      onPointerMove={(e) => {
        if (!drawing.current) return;
        const p = pt(e);
        setValue((v) => (v.length < SIG_MAX ? `${v}L${p}` : v));
      }}
      onPointerUp={() => (drawing.current = false)}
      onPointerCancel={() => (drawing.current = false)}
    >
      <path d={value || "M0 0"} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Proof of delivery (DW/TE) or of collection (WW): photo (live camera or gallery), flow-meter reading
 * and signature, with the phone's location when the photo is added and again on submit (0024).
 */
export function PodSheet({ onClose }: { onClose: () => void }) {
  const { job, profile, jobAction, locate, toast } = useDriver();
  const t = useT(DICT);
  const f = useFmt();
  const o = job!.order;
  const pin = job!.loc;
  const ww = o.service_type === "WW";
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [source, setSource] = useState<PhotoSource | null>(null);
  const [photoFix, setPhotoFix] = useState<Fix | null | undefined>(undefined); // undefined = still locating
  const [photoErr, setPhotoErr] = useState<string | null>(null);
  const [meter, setMeter] = useState(String(o.gallons));
  const [sig, setSig] = useState("");
  const [noSig, setNoSig] = useState(false);
  const [leftAtTank, setLeftAtTank] = useState(false);
  const [busy, setBusy] = useState(false);
  // The photo must be in Storage before submit_pod: the server rejects a proof without it.
  const [uploaded, setUploaded] = useState<{ file: File; path: string } | null>(null);
  const [uploadFailed, setUploadFailed] = useState(false);

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  // A photo arrives (camera or gallery): shrink it if large, show it, and record where the phone is.
  async function takeIn(raw: File, from: PhotoSource) {
    setPhotoErr(null);
    setPhotoFix(undefined);
    const img = await shrinkPhoto(raw);
    setFile(img);
    setSource(from);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(img);
    });
    setPhotoFix(await locate());
  }
  async function openNative(from: PhotoSource) {
    try {
      await takeIn(await nativePhoto(from), from);
    } catch (e) {
      const why = e instanceof PhotoError ? e.reason : "failed";
      if (why === "denied") setPhotoErr(t("cameraDenied"));
      else if (why === "failed") setPhotoErr(t("photoFailed"));
    }
  }

  const meterN = Number(meter);
  const meterOk = meter.trim() !== "" && Number.isInteger(meterN) && meterN >= 0 && meterN <= 20000;
  const ready = Boolean(file) && meterOk && (noSig || sig.length > 0) && !busy;

  async function submit() {
    if (!file) return;
    setBusy(true);
    setUploadFailed(false);
    const hash = await sha256Hex(file);
    // Photos go to the private evidence bucket, in the driver's own folder. A photo already
    // uploaded on an earlier attempt (when only the submit failed) isn't sent again.
    let path = uploaded?.file === file ? uploaded.path : null;
    if (!path) {
      const bucket = supabase().storage.from("evidence");
      const opts = { contentType: file.type || "image/jpeg", upsert: false };
      path = `${profile.id}/${o.id}-pod.jpg`;
      let up = await bucket.upload(path, file, opts);
      if (up.error) {
        path = `${profile.id}/${o.id}-pod-${Date.now()}.jpg`; // a retake after an earlier attempt
        up = await bucket.upload(path, file, opts);
      }
      if (up.error) {
        // No proof without the photo: keep the sheet open so the driver can retry.
        setBusy(false);
        setUploadFailed(true);
        return;
      }
      setUploaded({ file, path });
    }
    // The submit fix; without one the server records the tanker's last reported position.
    const at = await locate();
    const iso = (ms: number) => new Date(Math.min(ms, Date.now())).toISOString();
    const done = await jobAction("submit_pod", {
      p_meter_gal: meterN,
      p_photo_path: path,
      p_photo_hash: hash,
      p_signature_svg: noSig ? null : sig,
      p_no_signature: noSig,
      p_left_at_tank: noSig && leftAtTank,
      p_lat: at?.lat ?? null,
      p_lng: at?.lng ?? null,
      p_accuracy_m: at ? Math.round(at.accuracy) : null,
      p_fix_at: at ? iso(at.at) : null,
      p_photo_lat: photoFix?.lat ?? null,
      p_photo_lng: photoFix?.lng ?? null,
      p_photo_accuracy_m: photoFix ? Math.round(photoFix.accuracy) : null,
      p_photo_at: photoFix ? iso(photoFix.at) : null,
      p_photo_source: source,
    });
    setBusy(false);
    if (done) {
      toast(ww ? t("collectedToast") : t("deliveredToast", { amt: f.omr(Number(done.driver_earnings)) }));
      onClose();
    }
  }

  return (
    <Sheet label={ww ? t("podCollection") : t("podDelivery")} onClose={onClose}>
      <div className="row">
        <h3 className="d-st">{ww ? t("podCollection") : t("podDelivery")}</h3>
        <button type="button" className="btn sm" onClick={onClose}>
          {t("close")}
        </button>
      </div>
      <p className="mut small">{t("podNote")}</p>

      <div className="d-photo">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt={t("photoAlt")} />
        ) : (
          <span className="mut small">{t("takePhoto")}</span>
        )}
      </div>
      <PhotoButtons native={nativeCamera()} has={!!preview} busy={busy} onNative={openNative} onFile={takeIn} labels={{ camera: preview ? t("photoRetake") : t("photoCamera"), gallery: preview ? t("photoOther") : t("photoGallery") }} />
      {photoErr && (
        <p className="d-warn small" role="alert">
          {photoErr}
        </p>
      )}
      {preview && source === "gallery" && <p className="mut small">{t("photoFromGallery")}</p>}
      {preview && <LocationLine fix={photoFix} pin={pin} />}
      {uploadFailed && (
        <div className="banner badb" role="alert">
          <b>{t("photoNotUploaded")}</b> {t("photoRetryS")}
          <button type="button" className="btn sm" style={{ marginTop: 8 }} disabled={busy} onClick={submit}>
            {t("retry")}
          </button>
        </div>
      )}

      <div className="fld">
        <label htmlFor="meter">{t("meterReading")}</label>
        <input id="meter" type="number" inputMode="numeric" min={0} max={20000} value={meter} onChange={(e) => setMeter(e.target.value)} />
        {meterOk && meterN < o.gallons * 0.95 && <small className="d-warn">{t("shortWarn", { n: f.n(o.gallons) })}</small>}
      </div>

      {!noSig && (
        <div className="fld">
          <span className="lbl">{t("signature")}</span>
          <SignaturePad value={sig} setValue={setSig} label={t("signature")} />
          <button type="button" className="lk small" style={{ marginTop: 6 }} onClick={() => setSig("")}>
            {t("clearSig")}
          </button>
        </div>
      )}
      <button type="button" className="d-check" role="checkbox" aria-checked={noSig} onClick={() => setNoSig((v) => !v)}>
        <span className={`d-box ${noSig ? "on" : ""}`}>{noSig && <Icon name="check" size={14} />}</span>
        {t("noSig")}
      </button>
      {noSig && (
        <button type="button" className="d-check" role="checkbox" aria-checked={leftAtTank} onClick={() => setLeftAtTank((v) => !v)}>
          <span className={`d-box ${leftAtTank ? "on" : ""}`}>{leftAtTank && <Icon name="check" size={14} />}</span>
          {ww ? t("collectedFromTank") : t("leftAtTank")}
        </button>
      )}

      <button className="cta" style={{ marginTop: 14 }} disabled={!ready} onClick={submit}>
        {busy ? t("saving") : ww ? t("confirmCollection") : t("confirmDelivery")}
      </button>
    </Sheet>
  );
}

/**
 * "Take photo" and "Choose from gallery". In the Android app the camera plugin opens the camera or
 * the photo picker; in a browser two file inputs do (capture opens the rear camera on phones).
 */
function PhotoButtons({
  native, has, busy, onNative, onFile, labels,
}: {
  native: boolean;
  has: boolean;
  busy: boolean;
  onNative: (from: PhotoSource) => void;
  onFile: (file: File, from: PhotoSource) => void;
  labels: { camera: string; gallery: string };
}) {
  const pick = (from: PhotoSource) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const fl = e.target.files?.[0];
    e.target.value = ""; // the same photo can be chosen again after a failed upload
    if (fl) onFile(fl, from);
  };
  const cls = `btn ${has ? "sm" : ""}`;
  if (native)
    return (
      <div className="btns d-photo-btns">
        <button type="button" className={`${cls} ${has ? "" : "pri"}`} disabled={busy} onClick={() => onNative("camera")}>
          <Icon name="camera" />
          {labels.camera}
        </button>
        <button type="button" className={cls} disabled={busy} onClick={() => onNative("gallery")}>
          {labels.gallery}
        </button>
      </div>
    );
  return (
    <div className="btns d-photo-btns">
      <label className={`${cls} ${has ? "" : "pri"}`} aria-disabled={busy}>
        <Icon name="camera" />
        {labels.camera}
        <input type="file" accept="image/*" capture="environment" className="d-file" disabled={busy} onChange={pick("camera")} />
      </label>
      <label className={cls} aria-disabled={busy}>
        {labels.gallery}
        <input type="file" accept="image/*" className="d-file" disabled={busy} onChange={pick("gallery")} />
      </label>
    </div>
  );
}

/** Where the phone was when the photo was added, and how far that is from the customer's pin. */
function LocationLine({ fix, pin }: { fix: Fix | null | undefined; pin: { lat: number; lng: number } | null }) {
  const t = useT(DICT);
  const f = useFmt();
  if (fix === undefined) return <p className="mut small">{t("locating")}</p>;
  if (!fix) return <p className="d-warn small">{t("locNone")}</p>;
  const acc = f.km(fix.accuracy / 1000);
  if (!pin) return <p className="mut small">{t("locOkNoPin", { acc })}</p>;
  const km = distanceKm(fix, pin);
  if (km * 1000 > POD_FAR_M) return <p className="d-warn small" role="status">{t("locFar", { dist: f.km(km) })}</p>;
  return <p className="mut small">{t("locOk", { acc, dist: f.km(km) })}</p>;
}

const ISSUES: IssueKind[] = ["breakdown", "customer_unreachable", "wrong_address", "station_closed", "accident"];
const RELEASES: IssueKind[] = ["breakdown", "accident", "station_closed"];

/** Report a problem. Breakdown, accident and station closed release the job back to dispatch. */
export function IssueSheet({ onClose }: { onClose: () => void }) {
  const { reportIssue, acting } = useDriver();
  const t = useT(DICT);
  const [kind, setKind] = useState<IssueKind | null>(null);
  const [note, setNote] = useState("");

  async function send() {
    if (!kind) return;
    if (await reportIssue(kind, note.trim())) onClose();
  }

  return (
    <Sheet label={t("reportProblem")} onClose={onClose}>
      <h3 className="d-st" style={{ marginBottom: 6 }}>
        {t("reportProblem")}
      </h3>
      {ISSUES.map((k) => (
        <button key={k} type="button" className={`lrow d-pick ${kind === k ? "on" : ""}`} aria-pressed={kind === k} onClick={() => setKind(k)}>
          <span>
            {t(`issue_${k}`)}
            <small>{RELEASES.includes(k) ? t("issueReleases") : t("issueAlerts")}</small>
          </span>
          {kind === k && <Icon name="check" />}
        </button>
      ))}
      <div className="fld" style={{ marginTop: 12 }}>
        <label htmlFor="issue-note">{t("issueNote")}</label>
        <input id="issue-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <p className="mut small">{t("issueExplain")}</p>
      <button className="cta" disabled={!kind || acting} onClick={send}>
        {acting ? t("sending") : kind && RELEASES.includes(kind) ? t("sendRelease") : t("sendReport")}
      </button>
      <button className="cta sec" onClick={onClose}>
        {t("close")}
      </button>
    </Sheet>
  );
}
