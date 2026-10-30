"use client";

import { useEffect, useState } from "react";
import { Chips, PageHead, Tabs, useRun } from "@/components/nws/admin/ui";
import { REPORTS } from "@/components/nws/i18n/reports";
import { useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import Builder from "./_tabs/Builder";
import Clusters from "./_tabs/Clusters";
import Consumption from "./_tabs/Consumption";
import { loadRef, RANGES, type Ref } from "./_tabs/data";
import Feedback from "./_tabs/Feedback";
import Operations from "./_tabs/Operations";

type Tab = "ops" | "clu" | "cons" | "fb" | "build";

export default function ReportsPage() {
  const { staff } = useStaff();
  const run = useRun();
  const t = useT(REPORTS);
  const f = useFmt();
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
      <PageHead title={t("title")} sub={t("sub")}>
        {staff.staff_role !== "viewer" && (
          <button className="btn" onClick={async () => { if (await run(supabase().rpc("staff_refresh_reports"), t("refreshedOk"))) setTick((n) => n + 1); }}>
            {t("refreshBi")}
          </button>
        )}
      </PageHead>
      <Tabs<Tab> tabs={[["ops", t("tabOps")], ["clu", t("tabClu")], ["cons", t("tabCons")], ["fb", t("tabFb")], ["build", t("tabBuild")]]} value={tab} onChange={setTab} />
      {tab !== "build" && (
        <div className="rangebar">
          <Chips items={RANGES.map(([v]) => [v, t(`range${v}`)] as [string, string])} value={range} onChange={setRange} />
          <span className="mut" style={{ fontSize: 12.5 }}>
            {t("liveNote")}
            {refreshed ? t("biRefreshed", { at: f.dateTime(refreshed) }) : ""}
          </span>
        </div>
      )}
      {tab === "build" ? (
        <Builder refData={refData} />
      ) : tab === "ops" ? (
        <Operations key={`o${tick}`} days={days} />
      ) : tab === "clu" ? (
        <Clusters key={`k${tick}`} days={days} />
      ) : tab === "cons" ? (
        <Consumption key={`c${tick}`} days={days} />
      ) : (
        <Feedback key={`f${tick}`} days={days} />
      )}
    </>
  );
}
