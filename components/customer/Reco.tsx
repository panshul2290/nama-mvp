"use client";

// E11: tanker size and frequency suggestions (lib/recommend.ts) with a one-line reason and a
// one-tap "use this". The household size is the customer's own answer, kept in their
// preferences per property (prefs.household).
import Link from "next/link";
import { useCallback } from "react";
import { localDigits } from "@/lib/i18n";
import { contractFrequency, recommend, type PastOrder, type Reco } from "@/lib/recommend";
import type { ServiceType } from "@/lib/pricing";
import type { Property } from "@/lib/types";
import { useCx } from "./i18n";
import { gal } from "./fmt";

export const householdKey = (prop: Property | null | undefined) => prop?.id ?? "pin";

export function useRecoText() {
  const { t, lang } = useCx();
  return useCallback((r: Reco, service: ServiceType, prop: Property | null | undefined, people: number | null) => {
    const n = (v: number) => localDigits(v, lang);
    const p = prop?.label ?? t("yourHome");
    const g = gal(r.gallons, lang);
    const tank = prop?.tank_gal ? gal(prop.tank_gal, lang) : "";
    const head = r.everyDays ? t("recoEvery", { g, d: n(r.everyDays) }) : t("recoOnce", { g });
    let why: string;
    if (r.basis === "history") why = r.everyDays ? t("recoWhy_history", { p, g, d: n(r.everyDays), n: n(r.orders) }) : t("recoWhy_history1", { p, n: n(r.orders) });
    else if (r.basis === "household")
      why = t(tank ? "recoWhy_household" : "recoWhy_householdNoTank", { h: n(people ?? 0), pd: gal(r.perDay ?? 0, lang), g, tank, d: n(r.everyDays ?? 0) });
    else if (r.basis === "tank") why = t("recoWhy_tank", { tank, p });
    else why = service === "WW" ? t("recoWhy_ww", { g }) : service === "TE" ? t("recoWhy_te", { g }) : t("recoWhy_default");
    return { head, why };
  }, [t, lang]);
}

export function recoFor(service: ServiceType, prop: Property | null | undefined, history: PastOrder[], household: Record<string, number> | undefined) {
  const people = household?.[householdKey(prop)] ?? null;
  return { reco: recommend({ service, tankGal: prop?.tank_gal ?? null, household: people, history, propertyId: prop ? prop.id : null }), people };
}

/** Request step 2: the suggestion, why, a one-tap pick, the household size, and a contract link for a regular frequency. */
export function RecoCard({
  service,
  prop,
  reco,
  people,
  picked,
  onPick,
  onPeople,
}: {
  service: ServiceType;
  prop: Property | null | undefined;
  reco: Reco;
  people: number | null;
  picked: boolean;
  onPick: () => void;
  onPeople?: (n: number) => void;
}) {
  const { t, n } = useCx();
  const text = useRecoText()(reco, service, prop, people);
  const freq = reco.everyDays ? contractFrequency(reco.everyDays) : null;
  return (
    <div className="reco reco-card" role="group" aria-label={t("recoT")}>
      <div className="row">
        <span>
          <small className="mut">{t("recoT")}</small>
          <b className="d-block">{text.head}</b>
        </span>
        <button type="button" className={`btn sm ${picked ? "" : "pri"}`} aria-pressed={picked} onClick={onPick}>
          {picked ? `✓ ${t("recoUsed")}` : t("recoUse")}
        </button>
      </div>
      <p className="small" style={{ margin: "6px 0 0" }}>
        {text.why}
      </p>
      {service === "DW" && onPeople && (
        <div className="reco-people">
          <span className="small">{t("recoPeople")}</span>
          <span className="stepper">
            <button type="button" className="btn sm" aria-label={t("recoPeopleDec")} disabled={!people} onClick={() => onPeople(Math.max(0, (people ?? 0) - 1))}>
              −
            </button>
            <b aria-live="polite">{people ? n(people) : "—"}</b>
            <button type="button" className="btn sm" aria-label={t("recoPeopleInc")} disabled={(people ?? 0) >= 50} onClick={() => onPeople(Math.min(50, (people ?? 0) + 1))}>
              +
            </button>
          </span>
        </div>
      )}
      {freq && (
        <Link className="lk small" href={`/customer/contract?type=${service}&gallons=${reco.gallons}&plan=monthly&frequency=${freq}${prop ? `&property=${prop.id}` : ""}`}>
          {t("recoContract", { f: t(`freq_${freq}`) })}
        </Link>
      )}
    </div>
  );
}
