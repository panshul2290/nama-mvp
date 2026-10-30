"use client";

import "./company.css";
import { useCallback, useEffect, useState } from "react";
import { CompanyIssues, CompanyProvider, type OwnerCompany } from "@/components/company/CompanyContext";
import { CO } from "@/components/company/i18n";
import { RegisterCompany } from "@/components/company/RegisterCompany";
import { useLive } from "@/components/portal/kit";
import { PortalLoading, PortalShell, usePortalProfile, type PortalTab } from "@/components/portal/PortalShell";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

// Labels are CO dictionary keys (components/company/i18n.ts), translated at render.
const TABS: PortalTab[] = [
  { href: "/company", label: "tabOverview" },
  { href: "/company/tankers", label: "tabTankers" },
  { href: "/company/drivers", label: "tabDrivers" },
  { href: "/company/compliance", label: "tabCompliance" },
  { href: "/company/permits", label: "tabPermits" },
  { href: "/company/jobs", label: "tabJobs" },
  { href: "/company/finance", label: "tabFinance" },
  { href: "/company/shifts", label: "tabShifts" },
];

export default function CompanyLayout({ children }: { children: React.ReactNode }) {
  const { profile, reload } = usePortalProfile("owner");
  const [company, setCompany] = useState<OwnerCompany | null | undefined>(undefined);
  const [offers, setOffers] = useState(0);
  const t = useT(CO);

  const loadCompany = useCallback(async () => {
    const db = supabase();
    const { data } = await db.rpc("owner_company");
    setCompany((data as OwnerCompany | null) ?? null);
    if (data) {
      const { count } = await db.from("contracts").select("id", { count: "exact", head: true }).eq("status", "pending_owner");
      setOffers(count ?? 0);
    }
  }, []);

  useEffect(() => {
    if (!profile) return;
    const t = setTimeout(loadCompany, 0);
    return () => clearTimeout(t);
  }, [profile, loadCompany]);
  // A new contract offer (or a decision) updates the badge on "Jobs and contracts".
  const loadOffers = useCallback(async () => {
    if (!company) return;
    const { count } = await supabase().from("contracts").select("id", { count: "exact", head: true }).eq("status", "pending_owner");
    setOffers(count ?? 0);
  }, [company]);
  useLive("company-offers", ["contracts"], loadOffers, 60_000);

  if (!profile || company === undefined) return <PortalLoading />;
  const who = `${t("signedInAs", { name: profile.full_name || t("ownerFallback") })}${company ? ` · ${company.name}` : ""}`;

  if (!company) {
    return (
      <PortalShell app={t("appName")} who={who} title={t("registerTitle")} description={t("registerDesc")}>
        <RegisterCompany
          onDone={() => {
            reload();
            loadCompany();
          }}
        />
      </PortalShell>
    );
  }

  const banner =
    company.status === "pending" ? (
      <div className="banner">
        <b>{t("pendingB")}</b> {t("pendingBody", { name: company.name, cr: company.cr_no })}
      </div>
    ) : company.status === "suspended" ? (
      <div className="banner badb">
        <b>{t("suspendedB")}</b> {t("suspendedBody", { phone: "\u20661442\u2069" })}
      </div>
    ) : null;

  return (
    <CompanyProvider profile={profile} company={company} reloadCompany={loadCompany}>
      <PortalShell
        app={t("appName")}
        who={who}
        title={company.name}
        description={t("description")}
        banner={banner}
        tabs={TABS.map((tab) => ({ ...tab, label: t(tab.label), ...(tab.href === "/company/jobs" ? { badge: offers } : {}) }))}
      >
        <CompanyIssues />
        {children}
      </PortalShell>
    </CompanyProvider>
  );
}
