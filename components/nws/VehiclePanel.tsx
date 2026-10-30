"use client";

// NWS Fleet / Permits: a tanker's Naql vehicle and insurance papers (0041) with verify / reject
// (permit officers, admins; audited), and the drivers' tiers.
import { useCallback, useEffect, useState } from "react";
import { useAudited } from "@/components/nws/admin/ui";
import { CONT } from "@/components/nws/i18n/continuity";
import { useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { omanToday } from "@/lib/time";
import type { Tanker } from "@/lib/types";

/** driver id → tier, for the Fleet and company driver lists. */
export function useDriverTiers() {
  const [tiers, setTiers] = useState<Record<string, string>>({});
  useEffect(() => {
    supabase()
      .from("driver_profiles")
      .select("driver_id, tier")
      .then(({ data }) => setTiers(Object.fromEntries(((data ?? []) as { driver_id: string; tier: string }[]).map((r) => [r.driver_id, r.tier]))));
  }, []);
  return tiers;
}

export function TierPill({ tier }: { tier: string | undefined }) {
  const t = useT(CONT);
  if (!tier) return null;
  return <span className={`tier ${tier}`}>{t(`tier_${tier}`)}</span>;
}

export function VehiclePanel({ tankerId }: { tankerId: string }) {
  const t = useT(CONT);
  const f = useFmt();
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const [v, setV] = useState<(Tanker & { device: { id: string; tanker_id: string | null } | null }) | null>(null);
  const [cap, setCap] = useState("");
  const load = useCallback(async () => {
    const { data } = await supabase().from("tankers").select("*").eq("id", tankerId).maybeSingle();
    const tk = data as Tanker | null;
    let device: { id: string; tanker_id: string | null } | null = null;
    if (tk?.tracking_device_id) {
      const d = await supabase().from("devices").select("id, tanker_id").eq("id", tk.tracking_device_id).maybeSingle();
      device = (d.data as { id: string; tanker_id: string | null } | null) ?? null;
    }
    setV(tk ? { ...tk, device } : null);
  }, [tankerId]);
  useEffect(() => {
    const tm = setTimeout(load, 0);
    return () => clearTimeout(tm);
  }, [load]);
  if (!v) return null;
  const today = omanToday();
  const exp = (d: string | null | undefined) => (d ? <span className={d < today ? "badt" : ""}>{d < today ? `${f.date(d)} · ${t("vExpired")}` : t("vUntil", { d: f.date(d) })}</span> : "—");
  const officer = can("admin", "permit_officer");
  const decide = (decision: "verify" | "reject") =>
    ask({
      title: t(decision === "verify" ? "vVerifyQ" : "vRejectQ"),
      confirm: t(decision === "verify" ? "vVerify" : "vReject"),
      danger: decision === "reject",
      ok: t("vDone"),
      extra:
        decision === "verify" ? (
          <div className="fld">
            <label htmlFor="v-cap">{t("vMeasured")}</label>
            <input id="v-cap" className="in" type="number" min={100} max={20000} value={cap} onChange={(e) => setCap(e.target.value)} />
          </div>
        ) : undefined,
      run: (reason) =>
        supabase().rpc("staff_verify_tanker_vehicle", { p_tanker: v.id, p_decision: decision, p_capacity_gal: decision === "verify" && cap ? Number(cap) : null, p_note: reason }),
      done: load,
    });
  const has = v.naql_reg_no || v.op_card_no || v.vin || v.insurance_policy_no;
  return (
    <div className="panel">
      <h2>
        <span>
          {t("vTitle")} <span className={`st ${v.vehicle_status === "verified" ? "ok" : v.vehicle_status === "rejected" ? "bad" : "warn"}`}>{t(`vs_${v.vehicle_status ?? "unverified"}`)}</span>
        </span>
      </h2>
      {!has ? (
        <p className="pad mut">{t("vNone")}</p>
      ) : (
        <dl className="kv">
          <dt>{t("vNaql")}</dt>
          <dd>
            <bdi dir="ltr">{v.naql_reg_no ?? "—"}</bdi>
          </dd>
          <dt>{t("vOpCard")}</dt>
          <dd>
            <bdi dir="ltr">{v.op_card_no ?? "—"}</bdi> · {exp(v.op_card_expiry)}
          </dd>
          <dt>{t("vVin")}</dt>
          <dd>
            <bdi dir="ltr">{v.vin ?? "—"}</bdi>
          </dd>
          <dt>{t("vMakeModel")}</dt>
          <dd>{[v.make, v.model, v.model_year].filter(Boolean).join(" · ") || "—"}</dd>
          <dt>{t("vCap")}</dt>
          <dd>
            {v.tank_capacity_gal ? f.gal(v.tank_capacity_gal) : "—"}
            {v.capacity_verified_gal ? ` · ${t("vCapVer", { n: f.n(v.capacity_verified_gal) })}` : ""}
          </dd>
          <dt>{t("vIns")}</dt>
          <dd>
            {v.insurance_company ?? "—"} · <bdi dir="ltr">{v.insurance_policy_no ?? "—"}</bdi> · {exp(v.insurance_expiry)}
          </dd>
          <dt>{t("vDevice")}</dt>
          <dd>
            <bdi dir="ltr">{v.tracking_device_id ?? "—"}</bdi>
            {v.tracking_device_id && <small className="mut"> · {v.device?.tanker_id === v.id ? t("vDeviceLinked") : t("vDeviceOther")}</small>}
          </dd>
        </dl>
      )}
      {v.vehicle_note && <p className="pad small">{v.vehicle_note}</p>}
      {has && (
        <div className="pad btns">
          <button className="btn pri sm" disabled={!officer} onClick={() => decide("verify")}>
            {t("vVerify")}
          </button>
          <button className="btn sm" disabled={!officer} onClick={() => decide("reject")}>
            {t("vReject")}
          </button>
        </div>
      )}
      {dialog}
    </div>
  );
}
