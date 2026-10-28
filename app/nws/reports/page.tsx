"use client";

import { useEffect, useState } from "react";
import { Chips, PageHead, Tabs } from "@/components/nws/admin/ui";
import { useStaff } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import Builder from "./_tabs/Builder";
import Consumption from "./_tabs/Consumption";
import { loadOrders, loadRef, RANGES, ROW_CAP, type ORow, type Ref } from "./_tabs/data";
import Feedback from "./_tabs/Feedback";
import Operations from "./_tabs/Operations";

type Tab = "ops" | "cons" | "fb" | "build";

export default function ReportsPage() {
  const { toast } = useStaff();
  const [tab, setTab] = useState<Tab>("ops");
  const [range, setRange] = useState("30");
  const [rows, setRows] = useState<ORow[] | null>(null);
  const [refData, setRefData] = useState<Ref | null>(null);

  useEffect(() => {
    loadRef().then(setRefData);
  }, []);

  useEffect(() => {
    let live = true;
    loadOrders(Number(range)).then(({ rows: r, error }) => {
      if (!live) return;
      if (error) toast(friendlyError(error), true);
      setRows(r);
    });
    return () => { live = false; };
  }, [range, toast]);

  const days = Number(range);
  return (
    <>
      <PageHead title="Reports" sub="Operations, consumption, segmentation and feedback analytics, plus a report builder for custom web reports in standard formats." />
      <Tabs<Tab> tabs={[["ops", "Operations"], ["cons", "Consumption and refill"], ["fb", "Feedback"], ["build", "Report builder"]]} value={tab} onChange={setTab} />
      {tab !== "build" && (
        <div className="rangebar">
          <Chips items={RANGES.map(([v, l]) => [v, l] as [string, string])} value={range} onChange={(v) => { setRows(null); setRange(v); }} />
          <span className="mut" style={{ fontSize: 12.5 }}>
            {rows ? `${rows.length.toLocaleString()} orders${rows.length === ROW_CAP ? ` (first ${ROW_CAP.toLocaleString()})` : ""}` : "Loading…"}
          </span>
        </div>
      )}
      {tab === "build" ? (
        <Builder refData={refData} />
      ) : !rows ? (
        <div className="panel"><div className="empty">Loading…</div></div>
      ) : tab === "ops" ? (
        <Operations rows={rows} refData={refData} days={days} />
      ) : tab === "cons" ? (
        <Consumption rows={rows} />
      ) : (
        <Feedback rows={rows} days={days} />
      )}
    </>
  );
}
