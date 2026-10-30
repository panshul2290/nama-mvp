"use client";

import { useCallback, useEffect, useState } from "react";
import { Chips, Empty, PageHead, ReadOnlyNote, useAudited } from "@/components/nws/admin/ui";
import { SETTINGS_OPS } from "@/components/nws/i18n/settingsOps";
import { useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { friendlyError } from "@/lib/errors";
import { useLang, useT } from "@/lib/i18n";
import { label } from "@/lib/labels";
import { supabase } from "@/lib/supabase/client";
import type { FraudFlag } from "@/lib/types";

// Mirrors the checks in staff_scan() (0012): rule name and threshold (dictionary keys), the rule
// text the database writes on each flag (`match`), and the score each flag gets.
const RULES: { name: string; match: string; threshold: string; score: number }[] = [
  { name: "frNoFill", match: "Delivery without filling", threshold: "frNoFillT", score: 80 },
  { name: "frDupPod", match: "Duplicate proof-of-delivery photo", threshold: "frDupPodT", score: 90 },
  { name: "frRating", match: "Rating manipulation", threshold: "frRatingT", score: 60 },
  { name: "frWallet", match: "Wallet misuse", threshold: "frWalletT", score: 55 },
  { name: "frOrdering", match: "Unusual ordering", threshold: "frOrderingT", score: 40 },
];
// The flag's rule as the database wrote it → its name in the viewer's language.
const RULE_KEY: Record<string, string> = { ...Object.fromEntries(RULES.map((r) => [r.match, r.name])) };
const SUBJECT: Record<string, string> = { order: "order", driver: "driver", customer: "customer" };
const level = (s: number): [string, string] => (s >= 75 ? ["sev.high", "bad"] : s >= 50 ? ["sev.med", "warn"] : ["sev.low", ""]);
const STATE: Record<FraudFlag["state"], [string, string]> = { open: ["frOpen", "act"], cleared: ["frCleared", "ok"], confirmed: ["frConfirmedFraud", "bad"] };
type Filter = "open" | "cleared" | "confirmed" | "all";

export default function FraudPage() {
  const { can, toast } = useStaff();
  const { ask, dialog } = useAudited();
  const { lang } = useLang();
  const t = useT(SETTINGS_OPS);
  const fm = useFmt();
  const sev = (s: number) => {
    const [g, v] = level(s)[0].split(".");
    return label(g, v, lang);
  };
  const ruleName = (rule: string) => (RULE_KEY[rule] ? t(RULE_KEY[rule]) : rule);
  const [flags, setFlags] = useState<FraudFlag[] | null>(null);
  const [filter, setFilter] = useState<Filter>("open");
  const [scanning, setScanning] = useState(false);
  const decider = can("admin", "operator", "finance");

  const load = useCallback(() => {
    supabase().from("fraud_flags").select("*").order("created_at", { ascending: false }).limit(500).then(({ data }) => setFlags((data ?? []) as FraudFlag[]));
  }, []);
  useEffect(load, [load]);

  async function scan() {
    setScanning(true);
    const { data, error } = await supabase().rpc("staff_scan");
    setScanning(false);
    if (error) return toast(friendlyError(error, lang), true);
    const r = data as { new_flags: number; new_alerts: number };
    toast(t("frScanOk", { flags: fm.n(r.new_flags), alerts: fm.n(r.new_alerts) }));
    load();
  }

  function decide(f: FraudFlag, state: "cleared" | "confirmed") {
    ask({
      title: `${state === "cleared" ? t("frClearT") : t("frConfirmT")}: ${ruleName(f.rule)}`,
      body: state === "cleared" ? t("frClearB") : t("frConfirmB"),
      confirm: state === "cleared" ? t("frClearC") : t("frConfirmC"),
      danger: state === "confirmed",
      ok: state === "cleared" ? t("frClearedOk") : t("frConfirmedOk"),
      run: (reason) => supabase().rpc("staff_fraud_decide", { p_flag_id: f.id, p_state: state, p_reason: reason }),
      done: load,
    });
  }

  const n = (s: Filter) => (flags ?? []).filter((f) => s === "all" || f.state === s).length;
  const shown = (flags ?? []).filter((f) => filter === "all" || f.state === filter);

  return (
    <>
      <PageHead title={t("frTitle")} sub={t("frSub")}>
        <button className="btn pri" onClick={scan} disabled={scanning || !decider} title={decider ? undefined : t("frWho")}>{scanning ? t("frRunning") : t("frRun")}</button>
      </PageHead>
      {!decider && <ReadOnlyNote who={t("frWho")} />}
      <div className="half">
        <div className="panel">
          <h2>{t("frRules")} <small>{t("frRulesSub")}</small></h2>
          <div className="tblwrap">
            <table>
              <tbody>
                {RULES.map((r) => {
                  const open = (flags ?? []).filter((f) => f.rule === r.match && f.state === "open").length;
                  return (
                    <tr key={r.name}>
                      <td>{t(r.name)}<small style={{ display: "block" }}>{t("frThreshold", { text: t(r.threshold) })}</small></td>
                      <td><span className={`st ${level(r.score)[1]}`}>{sev(r.score)}</span></td>
                      <td className="num">{open ? <b>{t("frNOpen", { n: fm.n(open) })}</b> : <span className="mut">{t("frNOpen", { n: fm.n(0) })}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="note">{t("frNote")}</p>
        </div>

        <div className="panel">
          <h2>{t("frFlags")} <small>{t("frNeedReview", { n: fm.n(n("open")) })}</small></h2>
          <div className="toolbar" style={{ paddingTop: 0 }}>
            <Chips<Filter> items={[["open", t("frOpen"), n("open")], ["confirmed", t("stConfirmed"), n("confirmed")], ["cleared", t("frCleared"), n("cleared")], ["all", t("all"), n("all")]]} value={filter} onChange={setFilter} />
          </div>
          <div className="tblwrap scroll">
            <table>
              <tbody>
                {!flags && <Empty cols={3}>{t("loading")}</Empty>}
                {flags && shown.length === 0 && <Empty cols={3}>{t(`frNone_${filter}`)}</Empty>}
                {shown.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <b style={{ fontWeight: 600 }}>{ruleName(f.rule)}</b> · {SUBJECT[f.subject_type] ? t(SUBJECT[f.subject_type]) : f.subject_type}
                      <small style={{ display: "block" }}>{f.details}</small>
                      <small style={{ display: "block" }}>{fm.dateTime(f.created_at)}</small>
                    </td>
                    <td><span className={`st ${level(f.score)[1]}`} title={t("frScore", { n: fm.n(f.score) })}>{sev(f.score)}</span></td>
                    <td className="num">
                      {f.state === "open" ? (
                        decider ? (
                          <div className="btns" style={{ justifyContent: "flex-end" }}>
                            <button className="btn sm" onClick={() => decide(f, "cleared")}>{t("clear")}</button>
                            <button className="btn sm bad" onClick={() => decide(f, "confirmed")}>{t("confirm")}</button>
                          </div>
                        ) : (
                          <span className="st act">{t("frOpen")}</span>
                        )
                      ) : (
                        <span className={`st ${STATE[f.state][1]}`}>{t(STATE[f.state][0])}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {dialog}
    </>
  );
}
