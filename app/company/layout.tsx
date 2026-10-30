"use client";

import "./company.css";
import { useCallback, useEffect, useState } from "react";
import { CompanyIssues, CompanyProvider, type OwnerCompany } from "@/components/company/CompanyContext";
import { RegisterCompany } from "@/components/company/RegisterCompany";
import { useLive } from "@/components/portal/kit";
import { PortalLoading, PortalShell, usePortalProfile, type PortalTab } from "@/components/portal/PortalShell";
import { supabase } from "@/lib/supabase/client";

const TABS: PortalTab[] = [
  { href: "/company", label: "Overview" },
  { href: "/company/tankers", label: "Tankers" },
  { href: "/company/drivers", label: "Drivers" },
  { href: "/company/compliance", label: "Compliance" },
  { href: "/company/permits", label: "Permits" },
  { href: "/company/jobs", label: "Jobs and contracts" },
  { href: "/company/finance", label: "Finance" },
  { href: "/company/shifts", label: "Shifts" },
];

const DESCRIPTION =
  "For tanker companies: register tankers and drivers, keep documents and permits current, accept contracts, track jobs and earnings, and plan shifts.";

export default function CompanyLayout({ children }: { children: React.ReactNode }) {
  const { profile, reload } = usePortalProfile("owner");
  const [company, setCompany] = useState<OwnerCompany | null | undefined>(undefined);
  const [offers, setOffers] = useState(0);

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
  const who = `Signed in as ${profile.full_name || "owner"}${company ? ` · ${company.name}` : ""}`;

  if (!company) {
    return (
      <PortalShell app="Company portal" who={who} title="Register your fleet" description="Tell NWS about your tanker company. Once NWS approves it, you can register tankers, add drivers and apply for permits.">
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
        <b>Waiting for NWS approval.</b> NWS is reviewing {company.name} (CR {company.cr_no}). You can register tankers, add drivers and upload documents now; tankers take jobs once the company is approved and each has a valid permit.
      </div>
    ) : company.status === "suspended" ? (
      <div className="banner badb">
        <b>Company suspended by NWS.</b> Your tankers can’t take jobs. Contact the NWS permits team on 1442.
      </div>
    ) : null;

  return (
    <CompanyProvider profile={profile} company={company} reloadCompany={loadCompany}>
      <PortalShell app="Company portal" who={who} title={company.name} description={DESCRIPTION} banner={banner} tabs={TABS.map((t) => (t.href === "/company/jobs" ? { ...t, badge: offers } : t))}>
        <CompanyIssues />
        {children}
      </PortalShell>
    </CompanyProvider>
  );
}
