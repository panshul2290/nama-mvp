"use client";

import { useCallback, useEffect, useState } from "react";
import { OPS } from "@/components/nws/i18n/ops";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import { useLang, useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import type { DispatchCandidate } from "@/lib/types";

// Auto-dispatch ranking (dispatch_candidates, 0026) with one-click assignment through
// staff_order_action('assign'). Used by the order detail and the dispatch queue.
// The ranking reasons and blockers are written by the database (dispatch_candidates) and shown as sent.

export function useDispatchCandidates(orderId: string | null, limit = 8) {
  const [rows, setRows] = useState<DispatchCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { lang } = useLang();
  const load = useCallback(() => {
    if (!orderId) return;
    supabase()
      .rpc("dispatch_candidates", { p_order: orderId, p_limit: limit })
      .then(({ data, error: e }) => {
        setError(e ? friendlyError(e, lang) : null);
        setRows((data ?? []) as DispatchCandidate[]);
      });
  }, [orderId, limit, lang]);
  useEffect(load, [load]);
  return { rows, error, reload: load };
}

export function DispatchSuggestions({ orderId, orderLabel, canAssign, compact, onAssigned }: {
  orderId: string;
  orderLabel: string;
  canAssign: boolean;
  /** Fewer rows and no heading, for a table row in the dispatch queue. */
  compact?: boolean;
  onAssigned?: () => void;
}) {
  const { toast } = useStaff();
  const { lang } = useLang();
  const t = useT(OPS);
  const { rows, error, reload } = useDispatchCandidates(orderId, compact ? 3 : 8);
  const [pick, setPick] = useState<DispatchCandidate | null>(null);

  const list = (
    <>
      {error && <div className="banner badb">{error}</div>}
      {!rows && !error && <p className="mut" style={{ fontSize: 13 }}>{t("dsLoading")}</p>}
      {rows?.length === 0 && <p className="mut" style={{ fontSize: 13 }}>{t("dsNone")}</p>}
      {rows && rows.length > 0 && !rows.some((r) => r.eligible) && <p className="mut" style={{ fontSize: 13 }}>{t("dsNoneEligible")}</p>}
      <div className="picklist" role="list" aria-label={t("dsTitle")}>
        {rows?.map((c, i) => (
          <div key={c.tanker_id} role="listitem" className={`pickrow ${c.eligible ? "" : "off"}`} style={{ opacity: c.eligible ? 1 : 0.6, cursor: "default" }}>
            <span>
              <b dir="ltr">{c.plate}</b> · {c.driver_name || t("dsNoDriver")}{` · ${c.company_name || t("dsIndependent")}`}
              {c.eligible && i === 0 && <span className="st ok ptag">{t("dsBest")}</span>}
              {c.offered && <span className="st act ptag">{t("dsOffered")}</span>}
              <small className="mut" style={{ display: "block" }}>
                {c.eligible ? c.reasons.join(" · ") : c.blockers.join(" · ")}
              </small>
            </span>
            {c.eligible && canAssign && (
              <button type="button" className={`btn sm ${i === 0 ? "pri" : ""}`} onClick={() => setPick(c)}>{t("dsAssign")}</button>
            )}
          </div>
        ))}
      </div>
    </>
  );

  return (
    <>
      {compact ? list : (
        <div className="panel">
          <h2>{t("dsTitle")} <small>{t("dsSub")}</small></h2>
          <div className="pad">
            {list}
            <p className="note" style={{ margin: "8px 0 0" }}>{t("dsBasis")}</p>
          </div>
        </div>
      )}
      {pick && (
        <ReasonDialog
          title={t("dsAssignTitle", { order: orderLabel, plate: pick.plate })}
          body={t("dsAssignBody", { driver: pick.driver_name ?? t("dsTheDriver"), reasons: pick.reasons.join(" · ") })}
          confirm={t("dsAssign")}
          defaultReason={`Dispatch suggestion: ${pick.reasons.slice(0, 2).join(", ")}`}
          onCancel={() => setPick(null)}
          onConfirm={async (reason) => {
            const { error: e } = await supabase().rpc("staff_order_action", { p_order_id: orderId, p_action: "assign", p_reason: reason, p_tanker_id: pick.tanker_id });
            if (e) {
              toast(friendlyError(e, lang), true);
              reload();
              return;
            }
            toast(t("dsAssigned", { order: orderLabel, plate: pick.plate }));
            setPick(null);
            onAssigned?.();
          }}
        />
      )}
    </>
  );
}
