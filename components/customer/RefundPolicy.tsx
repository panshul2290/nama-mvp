"use client";

// The refund policy (lib/refundPolicy.ts) as the customer app shows it:
//   <RefundPolicy />                     the whole policy (wallet; a terms page)
//   <RefundPolicy part="cancel" fee=…/>  the lines for the cancel sheet (fee already formatted)
//   <RefundPolicy part="complaint" amount=… />  the result of a refunded complaint
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { REFUND_LINES, REFUND_POLICY } from "@/lib/refundPolicy";

export function RefundPolicy({ part = "full", fee, amount }: { part?: "full" | "cancel" | "complaint"; fee?: string; amount?: string }) {
  const t = useT(REFUND_POLICY);
  const [open, setOpen] = useState(part === "full");
  if (part === "complaint") {
    return (
      <div className="banner info" role="note">
        {amount ? t("rpWalletDone", { amount }) : t("rpComplaint")} {t("rpCard")}
      </div>
    );
  }
  if (part === "cancel") {
    return (
      <div className="mut small" role="note">
        <p style={{ margin: "6px 0" }}>{t("rpWhere")}</p>
        <button type="button" className="lk" onClick={() => setOpen((o) => !o)} aria-expanded={open} style={{ background: "none", border: 0, padding: 0, font: "inherit", color: "var(--link)", fontWeight: 700, cursor: "pointer" }}>
          {t("rpMore")}
        </button>
        {open && (
          <ul style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>
            <li>{t("rpFree")}</li>
            <li>{fee ? t("rpFee", { fee }) : t("rpFeeAny")}</li>
            <li>{t("rpArrived")}</li>
            <li>{t("rpCard")}</li>
          </ul>
        )}
      </div>
    );
  }
  return (
    <div className="rq-card" role="note">
      <div className="rq-ch">
        <b>{t("rpTitle")}</b>
      </div>
      <ul className="mut small" style={{ margin: "4px 0 0", paddingInlineStart: 18 }}>
        {REFUND_LINES.map((k) => (
          <li key={k} style={{ margin: "4px 0" }}>
            {t(k)}
          </li>
        ))}
      </ul>
    </div>
  );
}
