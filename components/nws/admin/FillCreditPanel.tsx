"use client";

import { useEffect, useState } from "react";
import { Empty, omr } from "@/components/nws/admin/ui";
import { fmtDateTime } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";

// D8: prepaid filling credit of independent drivers (no company), from staff_driver_fill_credit (0026).
const T = {
  title: "Independent drivers' filling credit",
  sub: "prepaid; each confirmed fill draws the water charge",
  note: "Drivers top up in the driver app (card payment simulated). A fill is refused when the balance doesn't cover the water; company tankers draw on their company's filling credit instead. Test-zone fills are not charged.",
};
type Row = { driver_id: string; full_name: string; plate: string | null; balance: string; topups: string; charges: string; last_at: string | null };

export function FillCreditPanel() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    supabase()
      .rpc("staff_driver_fill_credit")
      .then(({ data, error }) => {
        setErr(error ? friendlyError(error) : null);
        setRows((data ?? []) as Row[]);
      });
  }, []);
  const total = rows?.reduce((a, r) => a + Number(r.balance), 0) ?? 0;
  return (
    <div className="panel">
      <h2>{T.title} <small>{T.sub}{rows ? ` · ${omr(total)} OMR held` : ""}</small></h2>
      {err && <div className="banner badb">{err}</div>}
      <div className="tblwrap">
        <table>
          <thead><tr><th>Driver</th><th>Tanker</th><th className="num">Topped up</th><th className="num">Fills charged</th><th className="num">Balance (OMR)</th><th>Last movement</th></tr></thead>
          <tbody>
            {!rows && !err && <Empty cols={6}>Loading…</Empty>}
            {rows?.length === 0 && <Empty cols={6}>No independent drivers.</Empty>}
            {rows?.map((r) => (
              <tr key={r.driver_id}>
                <td>{r.full_name || "—"}</td>
                <td>{r.plate ?? "—"}</td>
                <td className="num">{omr(r.topups)}</td>
                <td className="num">{omr(r.charges)}</td>
                <td className="num" style={{ color: Number(r.balance) < 5 ? "var(--bad)" : undefined }}><b>{omr(r.balance)}</b></td>
                <td>{r.last_at ? fmtDateTime(r.last_at) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">{T.note}</p>
    </div>
  );
}
