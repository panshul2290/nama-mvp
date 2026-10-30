"use client";

import { useEffect, useState } from "react";
import { Chips, PageHead, Tabs, useRun } from "@/components/nws/admin/ui";
import { fmtDateTime, useStaff } from "@/components/nws/StaffContext";
import { supabase } from "@/lib/supabase/client";
import Builder from "./_tabs/Builder";
import Consumption from "./_tabs/Consumption";
import { loadRef, RANGES, type Ref } from "./_tabs/data";
import Feedback from "./_tabs/Feedback";
import Operations from "./_tabs/Operations";

type Tab = "ops" | "cons" | "fb" | "build";

export default function ReportsPage() {
  const { staff } = useStaff();
  const run = useRun();
  const [tab, setTab] = useState<Tab>("ops");
  const [range, setRange] = useState("30");
  const [refData, setRefData] = useState<Ref | null>(null);
  const [refreshed, setRefreshed] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    loadRef().then(setRefData);
    supabase().from("report_refresh_log").select("refreshed_at").eq("view_name", "mv_orders_daily").maybeSingle<{ refreshed_at: string }>().then(({ data }) => setRefreshed(data?.refreshed_at ?? null));
  }, [tick]);

  const days = Number(range);
  return (
    <>
      <PageHead title="Reports" sub="Operations, consumption, segmentation and feedback analytics — counted in the database over every order — plus a report builder for custom web reports in standard formats.">
        {staff.staff_role !== "viewer" && (
          <button className="btn" onClick={async () => { if (await run(supabase().rpc("staff_refresh_reports"), "Report views refreshed")) setTick((n) => n + 1); }}>
            Refresh BI views
          </button>
        )}
      </PageHead>
      <Tabs<Tab> tabs={[["ops", "Operations"], ["cons", "Consumption and refill"], ["fb", "Feedback"], ["build", "Report builder"]]} value={tab} onChange={setTab} />
      {tab !== "build" && (
        <div className="rangebar">
          <Chips items={RANGES.map(([v, l]) => [v, l] as [string, string])} value={range} onChange={setRange} />
          <span className="mut" style={{ fontSize: 12.5 }}>
            Live figures · test-zone orders excluded{refreshed ? ` · BI daily view refreshed ${fmtDateTime(refreshed)}` : ""}
          </span>
        </div>
      )}
      {tab === "build" ? (
        <Builder refData={refData} />
      ) : tab === "ops" ? (
        <Operations key={`o${tick}`} days={days} />
      ) : tab === "cons" ? (
        <Consumption key={`c${tick}`} days={days} />
      ) : (
        <Feedback key={`f${tick}`} days={days} />
      )}
    </>
  );
}
