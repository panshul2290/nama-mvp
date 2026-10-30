"use client";

import { useCallback, useEffect, useState } from "react";
import { Empty, Kpi, PageHead, ReadOnlyNote, Switch, useAudited } from "@/components/nws/admin/ui";
import { SETTINGS_OPS } from "@/components/nws/i18n/settingsOps";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { useFmt, type Fmt } from "@/components/portal/i18n";
import { friendlyError } from "@/lib/errors";
import { useLang, useT } from "@/lib/i18n";
import { penaltyState } from "@/lib/labels";
import { supabase } from "@/lib/supabase/client";
import { ref, type Penalty, type PenaltyRule } from "@/lib/types";

// Party → dictionary key.
const PARTY: Record<string, string> = { driver: "penPartyDriver", customer: "customer", business: "penPartyBusiness" };
type T = (k: string, v?: Record<string, string | number>) => string;
const amountText = (r: PenaltyRule, t: T, f: Fmt) => (r.amount_kind === "pct" ? t("penPctMonth", { n: f.n(Number(r.amount), Number(r.amount) % 1 ? 1 : 0) }) : f.n3(r.amount));
// The seeded rules' wording by code (lib/0013); a rule NWS adds later shows its own label.
const ruleLabel = (code: string, fallback: string, t: T) => (SETTINGS_OPS[`penR_${code}`] ? t(`penR_${code}`) : fallback);
const ruleComp = (code: string, fallback: string, t: T) => (SETTINGS_OPS[`penC_${code}`] ? t(`penC_${code}`) : fallback);

export default function PenaltiesPage() {
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const { lang } = useLang();
  const t = useT(SETTINGS_OPS);
  const f = useFmt();
  const [rules, setRules] = useState<PenaltyRule[] | null>(null);
  const [recent, setRecent] = useState<Penalty[] | null>(null);
  const [edit, setEdit] = useState<PenaltyRule | null>(null);
  const admin = can("admin");

  const load = useCallback(() => {
    const db = supabase();
    db.from("penalty_rules").select("*").order("party").order("code").then(({ data }) => setRules((data ?? []) as PenaltyRule[]));
    db.from("penalties").select("*").gte("created_at", new Date(Date.now() - 30 * 86400_000).toISOString()).order("created_at", { ascending: false }).limit(500)
      .then(({ data }) => setRecent((data ?? []) as Penalty[]));
  }, []);
  useEffect(load, [load]);

  function toggle(r: PenaltyRule) {
    ask({
      title: `${r.active ? t("penOff") : t("penOn")}: ${ruleLabel(r.code, r.label, t)}`,
      body: r.active ? t("penOffB") : t("penOnB"),
      confirm: r.active ? t("penOff") : t("penOn"),
      danger: r.active,
      ok: r.active ? t("penOffOk") : t("penOnOk"),
      run: (reason) => supabase().rpc("staff_update_penalty_rule", { p_code: r.code, p_amount: Number(r.amount), p_active: !r.active, p_reason: reason }),
      done: load,
    });
  }

  const label = new Map(rules?.map((r) => [r.code, ruleLabel(r.code, r.label, t)]));
  const byRule = new Map<string, { n: number; amt: number }>();
  for (const p of recent ?? []) {
    const a = byRule.get(p.rule_code) ?? { n: 0, amt: 0 };
    a.n++; if (p.state !== "cancelled") a.amt += Number(p.amount);
    byRule.set(p.rule_code, a);
  }
  const live = recent?.filter((p) => p.state !== "cancelled") ?? [];

  return (
    <>
      <PageHead title={t("penTitle")} sub={t("penSub")} />
      {!admin && <ReadOnlyNote who={t("whoAdminOne")} />}
      <div className="panel">
        <h2>{t("penFramework")} <small>{t("penFrameworkSub")}</small></h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr><th>{t("penTrigger")}</th><th>{t("penAppliesTo")}</th><th className="num">{t("penAmountOmr")}</th><th>{t("penComp")}</th><th className="num">{t("penLast30")}</th><th>{t("active")}</th><th></th></tr>
            </thead>
            <tbody>
              {!rules && <Empty cols={7}>{t("loading")}</Empty>}
              {rules?.map((r) => (
                <tr key={r.code}>
                  <td>{ruleLabel(r.code, r.label, t)}<small style={{ display: "block" }}><code dir="ltr">{r.code}</code></small></td>
                  <td>{PARTY[r.party] ? t(PARTY[r.party]) : r.party}</td>
                  <td className="num"><b>{amountText(r, t, f)}</b></td>
                  <td>{r.compensation ? ruleComp(r.code, r.compensation, t) : <span className="mut">—</span>}</td>
                  <td className="num">{f.n(byRule.get(r.code)?.n ?? 0)}</td>
                  <td><Switch on={r.active} disabled={!admin} label={r.active ? t("active") : t("off")} onClick={() => toggle(r)} /></td>
                  <td className="num">{admin && <button className="btn sm" onClick={() => setEdit(r)}>{t("penEditAmount")}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">{t("penNote")}</p>
      </div>

      <div className="okpis">
        <Kpi label={t("penIssued30")} value={recent ? f.n(recent.length) : "…"} />
        <Kpi label={t("penAmountOmr")} value={f.n3(live.reduce((a, p) => a + Number(p.amount), 0))} sub={t("penExclCancelled")} />
        <Kpi label={t("penDisputed")} value={f.n(recent?.filter((p) => p.state === "disputed").length ?? 0)} tone={recent?.some((p) => p.state === "disputed") ? "warn" : undefined} />
        <Kpi label={penaltyState("upheld", lang)[0]} value={f.n(recent?.filter((p) => p.state === "upheld").length ?? 0)} />
      </div>

      <div className="panel">
        <h2>{t("penRecent")} <small>{t("penRecentSub")}</small></h2>
        <div className="tblwrap scroll">
          <table>
            <thead><tr><th>{t("payRef")}</th><th>{t("penTrigger")}</th><th>{t("reason")}</th><th className="num">{t("payOmr")}</th><th>{t("status")}</th><th>{t("penIssuedH")}</th></tr></thead>
            <tbody>
              {recent?.length === 0 && <Empty cols={6}>{t("penNone")}</Empty>}
              {recent?.slice(0, 50).map((p) => {
                const [stText, stTone] = penaltyState(p.state, lang);
                return (
                  <tr key={p.id}>
                    <td><bdi dir="ltr">{ref.penalty(p.penalty_no)}</bdi></td>
                    <td>{label.get(p.rule_code) ?? p.rule_code}</td>
                    <td><small>{p.reason}</small></td>
                    <td className="num">{f.n3(p.amount)}</td>
                    <td><span className={`st ${stTone}`}>{stText}</span></td>
                    <td><small>{f.dateTime(p.created_at)}</small></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {edit && <EditAmount rule={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); load(); }} />}
      {dialog}
    </>
  );
}

function EditAmount({ rule, onClose, onDone }: { rule: PenaltyRule; onClose: () => void; onDone: () => void }) {
  const { toast } = useStaff();
  const { lang } = useLang();
  const t = useT(SETTINGS_OPS);
  const [amount, setAmount] = useState(String(Number(rule.amount)));
  return (
    <ReasonDialog
      title={`${t("penEditAmount")}: ${ruleLabel(rule.code, rule.label, t)}`}
      body={t("penEditB")}
      confirm={t("penSaveAmount")}
      extra={
        <div className="fld">
          <label htmlFor="pen-amt">{rule.amount_kind === "pct" ? t("penLateFee") : t("penAmountOmr")}</label>
          <input id="pen-amt" className="in" type="number" dir="ltr" min={0} step={rule.amount_kind === "pct" ? 0.5 : 0.1} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
      }
      onCancel={onClose}
      onConfirm={async (reason) => {
        const { error } = await supabase().rpc("staff_update_penalty_rule", { p_code: rule.code, p_amount: Number(amount), p_active: rule.active, p_reason: reason });
        if (error) return toast(friendlyError(error, lang), true);
        toast(t("penAmountOk"));
        onDone();
      }}
    />
  );
}
