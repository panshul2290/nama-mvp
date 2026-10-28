"use client";

import { useEffect, useState } from "react";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { n3, useRpc } from "@/components/nws/ops";
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
      body="Fines on tanker companies are deducted from their earnings. The company and driver are notified and can dispute it."
      confirm="Issue penalty"
      danger
      extra={
        <>
          <div className="fld">
            <label htmlFor="pr">Violation</label>
            <select id="pr" className="in" value={code} onChange={(e) => setCode(e.target.value)}>
              {rules.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label} · {r.amount_kind === "pct" ? `${r.amount}%` : `${n3(r.amount)} OMR`}
                </option>
              ))}
            </select>
            {rule?.compensation && <small className="mut">{rule.compensation}</small>}
          </div>
          <div className="fld">
            <label htmlFor="pa">Amount override (OMR, optional)</label>
            <input id="pa" className="in" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={rule ? n3(rule.amount) : ""} />
          </div>
        </>
      }
      onCancel={onClose}
      onConfirm={async (reason) => {
        const amt = amount.trim() ? Number(amount) : null;
        if (amt != null && !(amt >= 0)) return toast("Enter a valid amount.", true);
        const ok = await rpc("staff_issue_penalty", { p_rule: code, p_tanker_id: tankerId, p_order_id: orderId, p_reason: reason, p_amount: amt }, "Penalty issued");
        if (ok) {
          onDone?.();
          onClose();
        }
      }}
    />
  );
}
