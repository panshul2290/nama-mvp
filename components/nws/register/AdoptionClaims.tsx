"use client";

// NWS → Permits → Register: register tankers claimed by a driver or owner whose mobile number
// doesn't match the register (0048, security review SEC-03). The tanker can't work under its
// permit until a permit officer (or admin) approves the claim; a rejection gives the plate back
// to the register. Both are audited (staff_review_adoption).
import { useCallback, useEffect, useState } from "react";
import { REG } from "@/components/nws/i18n/register";
import { St, useRpc } from "@/components/nws/ops";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { useLang, useT } from "@/lib/i18n";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";

type Claim = {
  tanker_id: string; plate: string; service_type: string; adopter_name: string | null; adopter_role: string | null; adopter_phone: string | null;
  company_name: string | null; requested_at: string | null; register_owner: string | null; register_owner_phone: string | null;
  permit_no: string | null; permit_expires_at: string | null;
};

export function AdoptionClaims() {
  const t = useT(REG);
  const f = useFmt();
  const { lang } = useLang();
  const { can } = useStaff();
  const run = useRpc();
  const [rows, setRows] = useState<Claim[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dlg, setDlg] = useState<{ c: Claim; approve: boolean } | null>(null);
  const canReview = can("permit_officer");

  const load = useCallback(() => {
    supabase()
      .rpc("staff_adoption_claims")
      .then(({ data, error: e }) => {
        setError(e ? friendlyError(e, lang) : null);
        setRows((data ?? []) as Claim[]);
      });
  }, [lang]);
  useEffect(() => {
    const id = setTimeout(load, 0);
    return () => clearTimeout(id);
  }, [load]);

  if (error || !rows || rows.length === 0) return null;
  return (
    <div className="panel" role="region" aria-label={t("adoptT")}>
      <h2>
        {t("adoptT")} <small>{t("adoptS")}</small>
      </h2>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>{t("colTanker")}</th>
              <th>{t("adoptBy")}</th>
              <th>{t("colOwner")}</th>
              <th>{t("colPermitNo")}</th>
              <th>{t("adoptAt")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.tanker_id}>
                <td>
                  <bdi dir="ltr">{c.plate}</bdi> <small className="mut">{c.service_type}</small>
                </td>
                <td>
                  {c.adopter_name ?? "—"}
                  <small className="d-block mut">
                    {[c.company_name, c.adopter_phone].filter(Boolean).map((x, i) => (
                      <bdi key={i} dir="auto">{i ? " · " : ""}{x}</bdi>
                    ))}
                  </small>
                </td>
                <td>
                  {c.register_owner ?? "—"}
                  <small className="d-block mut">{c.register_owner_phone ? <bdi dir="ltr">{c.register_owner_phone}</bdi> : t("adoptNoPhone")}</small>
                </td>
                <td>
                  {c.permit_no ? <bdi dir="ltr">{c.permit_no}</bdi> : "—"}
                  {c.permit_expires_at && <small className="d-block mut">{f.date(c.permit_expires_at)}</small>}
                </td>
                <td>{c.requested_at ? f.date(c.requested_at) : "—"}</td>
                <td>
                  <span className="btns" style={{ flexWrap: "nowrap" }}>
                    <St tone="warn">{t("adoptPending")}</St>
                    <button className="btn sm pri" disabled={!canReview} title={canReview ? undefined : t("adoptRoles")} onClick={() => setDlg({ c, approve: true })}>
                      {t("adoptApprove")}
                    </button>
                    <button className="btn sm bad" disabled={!canReview} title={canReview ? undefined : t("adoptRoles")} onClick={() => setDlg({ c, approve: false })}>
                      {t("adoptReject")}
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dlg && (
        <ReasonDialog
          title={t(dlg.approve ? "adoptApproveT" : "adoptRejectT", { plate: dlg.c.plate })}
          body={t(dlg.approve ? "adoptApproveB" : "adoptRejectB")}
          confirm={t(dlg.approve ? "adoptApprove" : "adoptReject")}
          danger={!dlg.approve}
          onCancel={() => setDlg(null)}
          onConfirm={async (reason) => {
            const ok = await run("staff_review_adoption", { p_tanker: dlg.c.tanker_id, p_approve: dlg.approve, p_reason: reason }, t(dlg.approve ? "adoptApproved" : "adoptRejected"));
            if (ok) {
              setDlg(null);
              load();
            }
          }}
        />
      )}
    </div>
  );
}
