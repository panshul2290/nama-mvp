"use client";

// NWS → Orders: scheduled volume per day for the next 14 days (0044): booked orders with a
// window, and recurring deliveries not yet created.
import { useEffect, useState } from "react";
import { ORD } from "@/components/nws/i18n/orders";
import { useFmt } from "@/components/portal/i18n";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

type Day = { day: string; orders: number; gallons: number; dw_gal: number; ww_gal: number; te_gal: number; recurring_planned: number; recurring_gal: number };

export function ScheduledVolume() {
  const t = useT(ORD);
  const f = useFmt();
  const [rows, setRows] = useState<Day[] | null>(null);
  useEffect(() => {
    supabase()
      .rpc("staff_scheduled_volume", { p_days: 14 })
      .then(({ data }) => setRows((data ?? []) as Day[]));
  }, []);
  if (!rows || rows.every((r) => r.orders === 0 && r.recurring_planned === 0)) return null;
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <h2>
        {t("schedVolT")} <small>{t("schedVolS")}</small>
      </h2>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>{t("schedDay")}</th>
              <th>{t("schedBooked")}</th>
              <th>{t("schedGal")}</th>
              <th>DW</th>
              <th>WW</th>
              <th>TE</th>
              <th>{t("schedPlanned")}</th>
            </tr>
          </thead>
          <tbody>
            {rows
              .filter((r) => r.orders > 0 || r.recurring_planned > 0)
              .map((r) => (
                <tr key={r.day}>
                  <td>{f.fmt(`${String(r.day).slice(0, 10)}T12:00:00+04:00`, { weekday: "short", day: "numeric", month: "short" })}</td>
                  <td>{f.n(r.orders)}</td>
                  <td>{f.gal(r.gallons)}</td>
                  <td>{f.gal(r.dw_gal)}</td>
                  <td>{f.gal(r.ww_gal)}</td>
                  <td>{f.gal(r.te_gal)}</td>
                  <td>
                    {f.n(r.recurring_planned)} · {f.gal(r.recurring_gal)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
