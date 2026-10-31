"use client";

// Staff wallet credits above STAFF_CREDIT_LIMITS need a second staff member (0051, security
// review SEC-08). useCreditRpc runs a refund / goodwill RPC and, when the database answers
// second_approval_required, files the same credit with staff_request_credit instead.
// CreditApprovals is the finance/admin panel (Settings → Payments) that approves or rejects them.
import { useCallback, useEffect, useState } from "react";
import { CREDITS } from "@/components/nws/i18n/credits";
import { St, useRpc } from "@/components/nws/ops";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { errorCode, friendlyError } from "@/lib/errors";
import { useLang, useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

export type CreditRequest = { kind: "goodwill" | "complaint_refund" | "order_refund"; customer: string | null; amount: number; reason: string; complaint?: string | null; order?: string | null };

export function useCreditRpc() {
  const { toast } = useStaff();
  const { lang } = useLang();
  const t = useT(CREDITS);
  return useCallback(
    async (name: string, args: Record<string, unknown>, ok: string, request: CreditRequest) => {
      const db = supabase();
      const { error } = await db.rpc(name, args);
      if (!error) {
        toast(ok);
        return true;
      }
      if (errorCode(error) === "second_approval_required" && request.customer) {
        const { data, error: e2 } = await db.rpc("staff_request_credit", {
          p_kind: request.kind, p_customer: request.customer, p_amount: request.amount, p_reason: request.reason,
          p_complaint: request.complaint ?? null, p_order: request.order ?? null,
        });
        if (e2) {
          toast(friendlyError(e2, lang), true);
          return false;
        }
        toast(t("crRequested", { no: String((data as { request_no?: number } | null)?.request_no ?? "") }));
        return true;
      }
      toast(friendlyError(error, lang), true);
      return false;
    },
    [toast, lang, t],
  );
}

type Row = {
  id: string; request_no: number; kind: CreditRequest["kind"]; amount: string; reason: string; created_at: string; requested_by: string;
  customer: { full_name: string } | null; requester: { full_name: string } | null;
};

export function CreditApprovals() {
  const t = useT(CREDITS);
  const f = useFmt();
  const { can, staff } = useStaff();
  const run = useRpc();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [dlg, setDlg] = useState<{ r: Row; approve: boolean } | null>(null);
  const canDecide = can("finance");

  const load = useCallback(() => {
    supabase()
      .from("staff_credit_requests")
      .select("id, request_no, kind, amount, reason, created_at, requested_by, customer:profiles!staff_credit_requests_customer_id_fkey(full_name), requester:profiles!staff_credit_requests_requested_by_fkey(full_name)")
      .eq("status", "pending")
      .order("created_at")
      .then(({ data, error }) => setRows(error ? [] : ((data ?? []) as unknown as Row[])));
  }, []);
  useEffect(() => {
    const id = setTimeout(load, 0);
    return () => clearTimeout(id);
  }, [load]);

  if (!rows || rows.length === 0) return null;
  return (
    <div className="panel" role="region" aria-label={t("crTitle")}>
      <h2>
        {t("crTitle")} <small>{t("crSub")}</small>
      </h2>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>{t("crNo")}</th>
              <th>{t("crCustomer")}</th>
              <th>{t("crKind")}</th>
              <th className="num">{t("crAmount")}</th>
              <th>{t("crBy")}</th>
              <th>{t("crReason")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const own = r.requested_by === staff.id;
              const why = !canDecide ? t("crRoles") : own ? t("crOwn") : undefined;
              return (
                <tr key={r.id}>
                  <td>
                    <bdi dir="ltr">CR-{r.request_no}</bdi>
                    <small className="d-block mut">{f.date(r.created_at)}</small>
                  </td>
                  <td>{r.customer?.full_name ?? "—"}</td>
                  <td>
                    <St tone="warn">{t(`crKind.${r.kind}`)}</St>
                  </td>
                  <td className="num">{f.omr3(r.amount)}</td>
                  <td>{r.requester?.full_name ?? "—"}</td>
                  <td dir="auto">{r.reason}</td>
                  <td>
                    <span className="btns" style={{ flexWrap: "nowrap" }}>
                      <button className="btn sm pri" disabled={!!why} title={why} onClick={() => setDlg({ r, approve: true })}>
                        {t("crApprove")}
                      </button>
                      <button className="btn sm bad" disabled={!!why} title={why} onClick={() => setDlg({ r, approve: false })}>
                        {t("crReject")}
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {dlg && (
        <ReasonDialog
          title={dlg.approve ? t("crApproveT", { no: String(dlg.r.request_no), amount: f.omr3(dlg.r.amount), name: dlg.r.customer?.full_name ?? "—" }) : t("crRejectT", { no: String(dlg.r.request_no) })}
          body={t(dlg.approve ? "crApproveB" : "crRejectB")}
          confirm={t(dlg.approve ? "crApprove" : "crReject")}
          danger={!dlg.approve}
          onCancel={() => setDlg(null)}
          onConfirm={async (reason) => {
            if (await run("staff_decide_credit", { p_request: dlg.r.id, p_approve: dlg.approve, p_reason: reason }, t(dlg.approve ? "crApproved" : "crRejected"))) {
              setDlg(null);
              load();
            }
          }}
        />
      )}
    </div>
  );
}
