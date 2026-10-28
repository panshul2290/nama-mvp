"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useDriver, type IssueKind } from "@/components/DriverContext";
import { DICT, useFmt } from "@/components/driver/i18n";
import { Sheet } from "@/components/driver/Sheet";
import { Icon } from "@/components/icons";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

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

/** Proof of delivery (DW/TE) or of collection (WW): photo, flow-meter reading and signature. */
export function PodSheet({ onClose }: { onClose: () => void }) {
  const { job, profile, jobAction, getPosition, toast } = useDriver();
  const t = useT(DICT);
  const f = useFmt();
  const o = job!.order;
  const ww = o.service_type === "WW";
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [meter, setMeter] = useState(String(o.gallons));
  const [sig, setSig] = useState("");
  const [noSig, setNoSig] = useState(false);
  const [leftAtTank, setLeftAtTank] = useState(false);
  const [busy, setBusy] = useState(false);
  // The photo must be in Storage before submit_pod: the server rejects a proof without it.
  const [uploaded, setUploaded] = useState<{ file: File; path: string } | null>(null);
  const [uploadFailed, setUploadFailed] = useState(false);

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

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
    const at = getPosition();
    const done = await jobAction("submit_pod", {
      p_meter_gal: meterN,
      p_photo_path: path,
      p_photo_hash: hash,
      p_signature_svg: noSig ? null : sig,
      p_no_signature: noSig,
      p_left_at_tank: noSig && leftAtTank,
      p_lat: at?.lat ?? null,
      p_lng: at?.lng ?? null,
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

      <label className="d-photo">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt={t("photoAlt")} />
        ) : (
          <span className="btn">
            <Icon name="camera" />
            {t("takePhoto")}
          </span>
        )}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="d-file"
          onChange={(e) => {
            const fl = e.target.files?.[0];
            if (!fl) return;
            setFile(fl);
            setPreview(URL.createObjectURL(fl));
          }}
        />
      </label>
      {preview && <p className="mut small">{t("retakeHint")}</p>}
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
