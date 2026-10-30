"use client";

// NWS → Settings → Driver tiers (0041): the DRIVER_TIERS thresholds (admins, audited) and a
// recompute button. The nightly pg_cron job (nama-driver-tiers) applies them.
import { useCallback, useEffect, useState } from "react";
import { PageHead, ReadOnlyNote, useAudited, useRun } from "@/components/nws/admin/ui";
import { CONT } from "@/components/nws/i18n/continuity";
import { useStaff } from "@/components/nws/StaffContext";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

type Th = { on_time_pct: number; rating: number; acceptance_pct: number; jobs_30d: number; max_overcharge: number; max_penalties: number };
type Cfg = { silver: Th; gold: Th; boost: { silver: number; gold: number }; min_rated: number };
const FIELDS: [keyof Th, string, number][] = [
  ["on_time_pct", "tOnTime", 1],
  ["rating", "tRating", 0.1],
  ["acceptance_pct", "tAcc", 1],
  ["jobs_30d", "tJobs", 1],
  ["max_overcharge", "tOver", 1],
  ["max_penalties", "tPen", 1],
];

export default function TiersPage() {
  const { can } = useStaff();
  const t = useT(CONT);
  const { ask, dialog } = useAudited();
  const run = useRun();
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const admin = can("admin");
  const load = useCallback(() => {
    supabase()
      .from("app_settings")
      .select("value")
      .eq("key", "DRIVER_TIERS")
      .maybeSingle()
      .then(({ data }) => {
        try {
          setCfg(data?.value ? (JSON.parse(data.value as string) as Cfg) : null);
        } catch {
          setCfg(null);
        }
      });
  }, []);
  useEffect(load, [load]);
  if (!cfg) return <PageHead title={t("tTitle")} sub={t("tSub")} />;
  const setTh = (tier: "silver" | "gold", k: keyof Th, v: number) => setCfg({ ...cfg, [tier]: { ...cfg[tier], [k]: v } });

  return (
    <>
      <PageHead title={t("tTitle")} sub={t("tSub")}>
        <button className="btn" disabled={!admin} onClick={async () => (await run(supabase().rpc("compute_driver_tiers"), t("tRan"))) && load()}>
          {t("tRun")}
        </button>
      </PageHead>
      {!admin && <ReadOnlyNote who={t("whoAdmins")} />}
      <div className="banner info">{t("tAssume")}</div>
      <div className="half">
        {(["silver", "gold"] as const).map((tier) => (
          <div key={tier} className="panel">
            <h2>
              <span className={`tier ${tier}`}>{t(`tier_${tier}`)}</span>
            </h2>
            <div className="pad form">
              {FIELDS.map(([k, label, step]) => (
                <div key={k} className="fld">
                  <label htmlFor={`${tier}-${k}`}>{t(label)}</label>
                  <input id={`${tier}-${k}`} className="in" type="number" step={step} min={0} disabled={!admin} value={cfg[tier][k]} onChange={(e) => setTh(tier, k, Number(e.target.value))} />
                </div>
              ))}
              <div className="fld">
                <label htmlFor={`${tier}-boost`}>{t("tBoost")}</label>
                <input
                  id={`${tier}-boost`}
                  className="in"
                  type="number"
                  min={0}
                  max={60}
                  disabled={!admin}
                  value={cfg.boost[tier]}
                  onChange={(e) => setCfg({ ...cfg, boost: { ...cfg.boost, [tier]: Number(e.target.value) } })}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="panel">
        <div className="pad form">
          <div className="fld">
            <label htmlFor="min-rated">{t("tMinRated")}</label>
            <input id="min-rated" className="in" type="number" min={0} max={100} disabled={!admin} value={cfg.min_rated} onChange={(e) => setCfg({ ...cfg, min_rated: Number(e.target.value) })} />
          </div>
        </div>
        <div className="pad">
          <button
            className="btn pri"
            disabled={!admin}
            onClick={() => ask({ title: t("tSaveQ"), confirm: t("tSave"), ok: t("tSaved"), run: (reason) => supabase().rpc("staff_set_driver_tiers", { p_value: cfg, p_reason: reason }), done: load })}
          >
            {t("tSave")}
          </button>
        </div>
      </div>
      {dialog}
    </>
  );
}
