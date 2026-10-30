"use client";

import { useEffect, useState } from "react";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { PERMITS } from "@/components/nws/i18n/permits";
import { useRpc } from "@/components/nws/ops";
import { useFmt } from "@/components/portal/i18n";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

type Rule = { code: string; label: string; amount: number; amount_kind: "omr" | "pct"; compensation: string };

/** Issue a driver penalty from the framework (staff_issue_penalty) for a tanker and/or an order. */
export function PenaltyDialog({
  title,
  tankerId,
  orderId,
  defaultRule,
  onClose,
  onDone,
}: {
  title: string;
  tankerId: string | null;
  orderId: string | null;
  defaultRule?: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const rpc = useRpc();
  const { toast } = useStaff();
  const t = useT(PERMITS);
  const f = useFmt();
  const [rules, setRules] = useState<Rule[]>([]);
  const [code, setCode] = useState(defaultRule ?? "");
  const [amount, setAmount] = useState("");

  useEffect(() => {
    supabase()
      .from("penalty_rules")
      .select("code, label, amount, amount_kind, compensation")
      .eq("party", "driver")
      .eq("active", true)
      .order("amount")
      .then(({ data }) => {
        const list = (data ?? []) as Rule[];
        setRules(list);
        setCode((c) => c || list[0]?.code || "");
      });
  }, []);

  const rule = rules.find((r) => r.code === code);
  return (
    <ReasonDialog
      title={title}
      body={t("penBody")}
      confirm={t("issuePenalty")}
      danger
      extra={
        <>
          <div className="fld">
            <label htmlFor="pr">{t("violation")}</label>
            <select id="pr" className="in" value={code} onChange={(e) => setCode(e.target.value)}>
              {rules.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label} · {r.amount_kind === "pct" ? f.pct(Number(r.amount) / 100, 0) : f.omr3(r.amount)}
                </option>
              ))}
            </select>
            {rule?.compensation && <small className="mut">{rule.compensation}</small>}
          </div>
          <div className="fld">
            <label htmlFor="pa">{t("amountOverrideShort")}</label>
            <input id="pa" className="in" dir="ltr" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={rule ? Number(rule.amount).toFixed(3) : ""} />
          </div>
        </>
      }
      onCancel={onClose}
      onConfirm={async (reason) => {
        const amt = amount.trim() ? Number(amount) : null;
        if (amt != null && !(amt >= 0)) return toast(t("validAmount"), true);
        const ok = await rpc("staff_issue_penalty", { p_rule: code, p_tanker_id: tankerId, p_order_id: orderId, p_reason: reason, p_amount: amt }, t("penIssued"));
        if (ok) {
          onDone?.();
          onClose();
        }
      }}
    />
  );
}
