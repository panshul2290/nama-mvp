"use client";

// Company portal → Finance: the fees the company owes the platform (0035), by month and fee,
// with the fee schedule in force. Amounts stay 0 until the bid sets them.
import { useCallback, useEffect, useState } from "react";
import { CO } from "@/components/company/i18n";
import { useFmt } from "@/components/portal/i18n";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

type Fees = {
  fees: { fee_key: string; amount_omr: string; status: string }[];
  rows: { month: string; fee_key: string; n: number; amount: string }[];
  owed: string;
};

export function PlatformFeesOwed() {
  const t = useT(CO);
  const f = useFmt();
  const [data, setData] = useState<Fees | null>(null);
  const [missing, setMissing] = useState(false);
  const load = useCallback(() => {
    supabase()
      .rpc("owner_platform_fees", { p_months: 6 })
      .then(({ data, error }) => {
        if (error) return setMissing(true);
        setData(data as Fees);
      });
  }, []);
  useEffect(load, [load]);
  if (missing) return null;
  const month = (m: string) => f.fmt(`${m}-01`, { month: "long", year: "numeric" });
  return (
    <div className="panel">
      <h2>
        {t("pfOwedT")} <small>{t("pfOwedS")}</small>
      </h2>
      <dl className="kv">
        <dt>{t("pfOwedTotal")}</dt>
        <dd>
          <b>{data ? f.omr(data.owed) : "…"}</b>
        </dd>
      </dl>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>{t("pfMonthCol")}</th>
              <th>{t("pfFeeCol")}</th>
              <th className="num">{t("pfCountCol")}</th>
              <th className="num">{t("amountOmr")}</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((r) => (
              <tr key={`${r.month}${r.fee_key}`}>
                <td>{month(r.month)}</td>
                <td>{t(`pf_${r.fee_key}`)}</td>
                <td className="num">{f.n(r.n)}</td>
                <td className="num">{f.n3(r.amount)}</td>
              </tr>
            ))}
            {data && data.rows.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  {t("pfNone")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data && (
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("pfScheduleCol")}</th>
                <th>{t("status")}</th>
                <th className="num">{t("amountOmr")}</th>
              </tr>
            </thead>
            <tbody>
              {data.fees.map((x) => (
                <tr key={x.fee_key}>
                  <td>{t(`pf_${x.fee_key}`)}</td>
                  <td>{t(`pfs_${x.status}`)}</td>
                  <td className="num">{f.n3(x.amount_omr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="note">{t("pfOwedNote")}</p>
    </div>
  );
}
