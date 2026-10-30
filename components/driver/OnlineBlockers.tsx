"use client";

// "You can't go online yet": what's missing and what to do, next to the online toggle on
// Home and Jobs. Stays on screen until every blocker is cleared (the toggle is disabled
// meanwhile). The list comes from onlineBlockers() in ./blockers.ts.
import Link from "next/link";
import { useCallback, useState } from "react";
import { useDriver } from "@/components/DriverContext";
import { LESSONS } from "./training";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { onlineBlockers, PERMIT_STAGES, type Blocker } from "./blockers";
import { DICT, useErrText, useFmt } from "./i18n";
import { permitState, usePermits } from "./permit";
import { useNow } from "./useNow";
import { omanToday } from "@/lib/time";

export const BLOCKERS_ID = "go-online-blockers";

/** The tanker's permit state and what keeps the driver offline (empty: free to go online). */
export function useOnlineBlockers() {
  const { tanker, companySuspended, shiftChecked, training } = useDriver();
  const now = useNow(60_000);
  const { rows, reload } = usePermits(tanker.id);
  const permit = rows && now ? permitState(rows, tanker.service_type, now) : null;
  const req = training.required && training.loaded ? { done: LESSONS.filter((l) => training.done.includes(l.key)).length, total: LESSONS.length } : null;
  const today = now ? omanToday(now) : null;
  const vehicle = today ? { opCardExpiry: tanker.op_card_expiry ?? null, insuranceExpiry: tanker.insurance_expiry ?? null, today } : null;
  const blockers = onlineBlockers({ blocked: Boolean(tanker.blocked), blockedReason: tanker.blocked_reason ?? null, companySuspended, permit, shiftChecked, training: req, vehicle });
  return { permit, blockers, reloadPermits: reload };
}

/** One line per blocker (the panel's headings; also the disabled toggle's label). */
export function useBlockerTitle() {
  const { tanker } = useDriver();
  const t = useT(DICT);
  const f = useFmt();
  return useCallback(
    (b: Blocker) => {
      const svc = t(`svc_${tanker.service_type}`);
      switch (b.kind) {
        case "blocked":
          return t("blockedT");
        case "company":
          return t("companySuspendedT");
        case "permit_none":
          return t(b.wrong ? "blkWrongT" : "blkNoneT", { svc });
        case "permit_pending":
          return t("blkPendingT", { n: f.d(b.stage), m: f.d(PERMIT_STAGES.length), stage: t(`stage_${b.stageKey}`) });
        case "permit_rejected":
          return t("blkRejectedT");
        case "permit_expired":
          return t("blkExpiredT", { date: f.date(b.expiredAt) });
        case "check":
          return t("blkCheckT");
        case "training":
          return t("blkTrainingT", { n: f.d(b.done), m: f.d(b.total) });
        case "vehicle":
          return b.what.map((w) => t(w === "op_card" ? "blkOpCardT" : "blkInsuranceT")).join(" · ");
      }
    },
    [t, f, tanker.service_type],
  );
}

export function OnlineBlockers({ blockers, onApplied, checkHref }: { blockers: Blocker[]; onApplied: () => void; checkHref: string }) {
  const { toast } = useDriver();
  const t = useT(DICT);
  const errText = useErrText();
  const title = useBlockerTitle();
  const [busy, setBusy] = useState(false);

  // A new application, a renewal or a resubmission: apply_permit() opens one for the tanker's service.
  async function apply(sent: string) {
    setBusy(true);
    const { error } = await supabase().rpc("apply_permit");
    setBusy(false);
    if (error) return toast(errText(error));
    toast(t(sent));
    onApplied();
  }

  if (!blockers.length) return null;
  const docs = (
    <Link className="lk" href="/driver/profile#permit">
      {t("docsInProfile")}
    </Link>
  );

  return (
    <div className="banner badb" id={BLOCKERS_ID} role="status">
      <b>{t("blkT")}</b>
      <p className="small" style={{ margin: "2px 0 0" }}>
        {t("blkS")}
      </p>
      <ul style={{ margin: "8px 0 0", paddingInlineStart: 18, display: "grid", gap: 10 }}>
        {blockers.map((b) => (
          <li key={b.kind}>
            <b>{title(b)}</b>
            <span className="d-block">
              {b.kind === "blocked" && (
                <>
                  {b.reason ? `${t("reasonX", { reason: b.reason })} ` : ""}
                  {t("blockedS")} {t("blkBlockedDo")}
                </>
              )}
              {b.kind === "company" && `${t("companySuspendedS")} ${t("blkCompanyDo")}`}
              {b.kind === "permit_none" && t("blkNoneS")}
              {b.kind === "permit_pending" && (
                <>
                  {b.info ? `${t("infoRequested", { text: b.info })} ` : `${t("blkPendingS")} `}
                  {b.info && docs}
                </>
              )}
              {b.kind === "permit_rejected" && (
                <>
                  {b.reason ? `${t("reasonX", { reason: b.reason })} ` : ""}
                  {t("blkRejectedS")} {docs}
                </>
              )}
              {b.kind === "permit_expired" && t("blkExpiredS")}
              {b.kind === "check" && t("blkCheckS")}
              {b.kind === "training" && t("blkTrainingS")}
              {b.kind === "vehicle" && (
                <>
                  {t("blkVehicleS")}{" "}
                  <Link className="lk" href="/driver/profile#vehicle">
                    {t("docsInProfile")}
                  </Link>
                </>
              )}
            </span>
            {(b.kind === "permit_none" || b.kind === "permit_rejected" || b.kind === "permit_expired") && (
              <button
                className="btn pri sm"
                style={{ marginTop: 6 }}
                disabled={busy}
                onClick={() => apply(b.kind === "permit_expired" ? "renewalSent" : "permitApplied")}
              >
                {busy ? t("sending") : t(b.kind === "permit_none" ? "applyPermit" : b.kind === "permit_rejected" ? "resubmit" : "submitRenewal")}
              </button>
            )}
            {b.kind === "training" && (
              <Link className="btn pri sm" style={{ marginTop: 6, display: "inline-block" }} href="/driver/training">
                {t("startTraining")}
              </Link>
            )}
            {b.kind === "check" && (
              <Link className="btn pri sm" style={{ marginTop: 6, display: "inline-block" }} href={checkHref}>
                {t("startCheck")}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
