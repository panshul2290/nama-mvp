"use client";

// "Invite owners by SMS": queues the registry_invite template (EN/AR) to registry owners through
// the notification outbox (0026/0033). The database throttles (daily cap, per-minute rate),
// skips owners without a number, already on the platform, opted out or invited recently, and
// respects an account's SMS switch. The provider is simulated until the SMS gateway is connected.
import { useState } from "react";
import { REG } from "@/components/nws/i18n/register";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { useLang, useT } from "@/lib/i18n";
import { inviteLoop, SKIP_LABEL, type RegFilter } from "./data";

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
  const t = useT(REG);
  const f = useFmt();
  const { lang: uiLang } = useLang();
  // Language of the SMS itself (not the screen's).
  const [lang, setLang] = useState<"ar" | "en">("ar");
  const [progress, setProgress] = useState<number | null>(null);
  return (
    <ReasonDialog
      title={t("invTitle")}
      body={t("invBody", { who })}
      confirm={progress != null ? t("invWorking", { n: f.n(progress) }) : t("invConfirm")}
      defaultReason={t("invReason")}
      extra={
        <div className="fld">
          <label htmlFor="inv-lang">{t("invLang")}</label>
          <select id="inv-lang" className="in" value={lang} onChange={(e) => setLang(e.target.value as "ar" | "en")}>
            <option value="ar">{t("invAr")}</option>
            <option value="en">{t("invEn")}</option>
          </select>
        </div>
      }
      onCancel={onClose}
      onConfirm={async (reason) => {
        setProgress(0);
        const res = await inviteLoop({ owners, batch, filter, lang, reason, uiLang }, setProgress);
        setProgress(null);
        if (res.error) return toast(res.error, true);
        const skipped = Object.entries(res.skipped).filter(([, n]) => n > 0).map(([k, n]) => `${f.n(n)} ${REG[`skip.${k}`]?.[uiLang] ?? SKIP_LABEL[k] ?? k}`);
        const done = res.queued ? t("invDone", { n: f.n(res.queued) }) : t("invNone");
        toast(`${done}${skipped.length ? ` · ${t("invSkipped")}: ${skipped.join(uiLang === "ar" ? "، " : ", ")}` : ""}`);
        onDone?.();
        onClose();
      }}
    />
  );
}
