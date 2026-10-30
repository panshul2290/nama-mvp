"use client";

// Driver safety during a job or an online shift (0042): SOS (with a confirm step) raises a
// high-severity alert to NWS live operations with the position, plays nothing, and offers the ROP
// emergency number 9999; "Share my live route" makes a time-limited, revocable link to a public
// page with the tanker's position and the destination area only.
import { useCallback, useEffect, useState } from "react";
import { useDriver } from "@/components/DriverContext";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { publicBase, useSupport } from "@/lib/support";
import { DICT, useErrText, useFmt } from "./i18n";
import { Sheet } from "./Sheet";

const ROP = "9999";
type Share = { id: string; token: string; expires_at: string; created_at: string };

export function SafetyBar() {
  const { tanker, job } = useDriver();
  const t = useT(DICT);
  const [open, setOpen] = useState<"sos" | "share" | null>(null);
  if (!tanker.is_online && !job) return null;
  return (
    <>
      <div className="safety">
        <button type="button" className="sos-btn" onClick={() => setOpen("sos")}>
          {t("sosBtn")}
        </button>
        <button type="button" className="btn sm" onClick={() => setOpen("share")}>
          {t("shareBtn")}
        </button>
      </div>
      {open === "sos" && <SosSheet onClose={() => setOpen(null)} />}
      {open === "share" && <ShareSheet onClose={() => setOpen(null)} />}
    </>
  );
}

function SosSheet({ onClose }: { onClose: () => void }) {
  const { me } = useDriver();
  const t = useT(DICT);
  const errText = useErrText();
  const [note, setNote] = useState("");
  const [state, setState] = useState<"confirm" | "sending" | "sent">("confirm");
  const [err, setErr] = useState<string | null>(null);
  async function send() {
    setState("sending");
    setErr(null);
    const { error } = await supabase().rpc("driver_sos", { p_lat: me?.lat ?? null, p_lng: me?.lng ?? null, p_note: note.trim() || null });
    if (error) {
      setErr(errText(error));
      return setState("confirm");
    }
    setState("sent");
  }
  return (
    <Sheet label={t("sosT")} onClose={onClose}>
      <h3>{t("sosT")}</h3>
      {state === "sent" ? (
        <div className="banner okb" role="status">
          <b>{t("sosSent")}</b> {t("sosSentS")}
        </div>
      ) : (
        <>
          <p className="mut small">{t("sosS")}</p>
          <div className="fld">
            <label htmlFor="sosN">{t("sosNote")}</label>
            <input id="sosN" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {err && <div className="banner badb">{err}</div>}
          <button type="button" className="cta sos-btn" disabled={state === "sending"} onClick={send}>
            {state === "sending" ? t("sending") : t("sosConfirm")}
          </button>
        </>
      )}
      <div className="banner" style={{ marginTop: 12 }}>
        {t("sosRop")}{" "}
        <bdi dir="ltr" className="sel">
          {ROP}
        </bdi>{" "}
        <a className="lk" href={`tel:${ROP}`}>
          {t("sosCall")}
        </a>
      </div>
      <button type="button" className="cta sec" onClick={onClose}>
        {t("close")}
      </button>
    </Sheet>
  );
}

function ShareSheet({ onClose }: { onClose: () => void }) {
  const { profile, toast } = useDriver();
  const t = useT(DICT);
  const f = useFmt();
  const errText = useErrText();
  const support = useSupport();
  const [hours, setHours] = useState(4);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      supabase()
        .from("route_shares")
        .select("id, token, expires_at, created_at")
        .eq("driver_id", profile.id)
        .is("revoked_at", null)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .then(({ data }) => setShares((data ?? []) as Share[])),
    [profile.id],
  );
  useEffect(() => {
    load();
  }, [load]);
  const link = (s: Share) => `${publicBase(support)}/share/route?t=${s.token}`;

  async function create() {
    setBusy(true);
    const { error } = await supabase().rpc("driver_share_route", { p_hours: hours });
    setBusy(false);
    if (error) return toast(errText(error));
    load();
  }
  async function revoke(id: string) {
    const { error } = await supabase().rpc("driver_revoke_route_share", { p_id: id });
    if (error) return toast(errText(error));
    toast(t("shareRevoked"));
    load();
  }
  async function send(s: Share) {
    const url = link(s);
    try {
      if (navigator.share) await navigator.share({ title: t("shareTitle"), text: t("shareText"), url });
      else {
        await navigator.clipboard.writeText(url);
        toast(t("shareCopied"));
      }
    } catch {
      /* the share sheet was dismissed */
    }
  }

  return (
    <Sheet label={t("shareT")} onClose={onClose}>
      <h3>{t("shareT")}</h3>
      <p className="mut small">{t("shareS")}</p>
      <div className="opts">
        {[1, 4, 8, 12].map((h) => (
          <button key={h} type="button" className={`opt ${hours === h ? "on" : ""}`} onClick={() => setHours(h)}>
            {t("shareHours", { n: f.d(h) })}
          </button>
        ))}
      </div>
      <button type="button" className="cta" disabled={busy} onClick={create}>
        {busy ? t("saving") : t("shareCreate")}
      </button>
      {(shares ?? []).map((s) => (
        <div key={s.id} className="lrow" style={{ marginTop: 10 }}>
          <span>
            <small dir="ltr" className="sel" style={{ wordBreak: "break-all" }}>
              {link(s)}
            </small>
            <small>{t("shareUntil", { time: f.time(s.expires_at) })}</small>
          </span>
          <span style={{ display: "flex", gap: 6 }}>
            <button type="button" className="btn sm" onClick={() => send(s)}>
              {t("shareSend")}
            </button>
            <button type="button" className="btn sm" onClick={() => revoke(s.id)}>
              {t("shareRevoke")}
            </button>
          </span>
        </div>
      ))}
      <button type="button" className="cta sec" onClick={onClose}>
        {t("close")}
      </button>
    </Sheet>
  );
}
