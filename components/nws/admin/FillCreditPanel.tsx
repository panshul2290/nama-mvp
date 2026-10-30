"use client";

import { useEffect, useState } from "react";
import { Empty } from "@/components/nws/admin/ui";
import { SETTINGS_OPS } from "@/components/nws/i18n/settingsOps";
import { useFmt } from "@/components/portal/i18n";
import { friendlyError } from "@/lib/errors";
import { useLang, useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

// D8: prepaid filling credit of independent drivers (no company), from staff_driver_fill_credit (0026).
type Row = { driver_id: string; full_name: string; plate: string | null; balance: string; topups: string; charges: string; last_at: string | null };

export function FillCreditPanel() {
  const { lang } = useLang();
  const t = useT(SETTINGS_OPS);
  const f = useFmt();
  const [rows, setRows] = useState<Row[] | null>(null);
  // The raw error, worded in the viewer's language at render time.
  const [err, setErr] = useState<{ message?: string } | null>(null);
  useEffect(() => {
    supabase()
      .rpc("staff_driver_fill_credit")
      .then(({ data, error }) => {
        setErr(error ?? null);
        setRows((data ?? []) as Row[]);
      });
  }, []);
  const total = rows?.reduce((a, r) => a + Number(r.balance), 0) ?? 0;
  return (
    <div className="panel">
      <h2>{t("fcTitle")} <small>{t("fcSub")}{rows ? ` · ${t("fcHeld", { amt: f.omr3(total) })}` : ""}</small></h2>
      {err && <div className="banner badb">{friendlyError(err, lang)}</div>}
      <div className="tblwrap">
        <table>
          <thead><tr><th>{t("driver")}</th><th>{t("tanker")}</th><th className="num">{t("fcTopped")}</th><th className="num">{t("fcCharged")}</th><th className="num">{t("fcBalance")}</th><th>{t("fcLast")}</th></tr></thead>
          <tbody>
            {!rows && !err && <Empty cols={6}>{t("loading")}</Empty>}
            {rows?.length === 0 && <Empty cols={6}>{t("fcNone")}</Empty>}
            {rows?.map((r) => (
              <tr key={r.driver_id}>
                <td>{r.full_name || "—"}</td>
                <td><bdi dir="ltr">{r.plate ?? "—"}</bdi></td>
                <td className="num">{f.n3(r.topups)}</td>
                <td className="num">{f.n3(r.charges)}</td>
                <td className="num" style={{ color: Number(r.balance) < 5 ? "var(--bad)" : undefined }}><b>{f.n3(r.balance)}</b></td>
                <td>{f.dateTime(r.last_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">{t("fcNote")}</p>
    </div>
  );
}
