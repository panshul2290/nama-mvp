"use client";

// "Invite owners by SMS": queues the registry_invite template (EN/AR) to registry owners through
// the notification outbox (0026/0033). The database throttles (daily cap, per-minute rate),
// skips owners without a number, already on the platform, opted out or invited recently, and
// respects an account's SMS switch. The provider is simulated until the SMS gateway is connected.
import { useState } from "react";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { inviteLoop, SKIP_LABEL, type RegFilter } from "./data";

const T = {
  title: "Invite owners by SMS",
  body: (who: string) =>
    `Sends the register invitation to ${who}. Owners without a mobile number, already on the platform, opted out or invited in the last few days are skipped; the database limits how many go out a day and spreads them over time.`,
  lang: "Message language",
  ar: "Arabic",
  en: "English",
  confirm: "Queue invitations",
  done: (n: number) => (n ? `${n.toLocaleString()} invitations queued — they go out gradually at the configured rate` : "No invitations queued"),
  skipped: "Skipped",
  working: (n: number) => `Queuing… ${n.toLocaleString()}`,
};

export function InviteDialog({
  who, owners, batch, filter, onClose, onDone,
}: {
  who: string;
  owners?: string[];
  batch?: string;
  filter?: RegFilter;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { toast } = useStaff();
  const [lang, setLang] = useState<"ar" | "en">("ar");
  const [progress, setProgress] = useState<number | null>(null);
  return (
    <ReasonDialog
      title={T.title}
      body={T.body(who)}
      confirm={progress != null ? T.working(progress) : T.confirm}
      defaultReason="Permit campaign: invite registry owners to register"
      extra={
        <div className="fld">
          <label htmlFor="inv-lang">{T.lang}</label>
          <select id="inv-lang" className="in" value={lang} onChange={(e) => setLang(e.target.value as "ar" | "en")}>
            <option value="ar">{T.ar}</option>
            <option value="en">{T.en}</option>
          </select>
        </div>
      }
      onCancel={onClose}
      onConfirm={async (reason) => {
        setProgress(0);
        const res = await inviteLoop({ owners, batch, filter, lang, reason }, setProgress);
        setProgress(null);
        if (res.error) return toast(res.error, true);
        const skipped = Object.entries(res.skipped).filter(([, n]) => n > 0).map(([k, n]) => `${n.toLocaleString()} ${SKIP_LABEL[k] ?? k}`);
        toast(`${T.done(res.queued)}${skipped.length ? ` · ${T.skipped}: ${skipped.join(", ")}` : ""}`);
        onDone?.();
        onClose();
      }}
    />
  );
}
