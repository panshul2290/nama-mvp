"use client";

import "./business.css";
import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";
import { BizProvider, SEGMENT_LABEL, type OrgSummary } from "@/components/business/BizContext";
import { BIZ } from "@/components/business/i18n";
import { useFmt } from "@/components/portal/i18n";
import { useAction, useLive } from "@/components/portal/kit";
import { PortalLoading, PortalShell, usePortalProfile, type PortalTab } from "@/components/portal/PortalShell";
import { useMyInvitations } from "@/components/useInvitations";
import { supabase } from "@/lib/supabase/client";
import { useLang, useT } from "@/lib/i18n";
import { orgRoleLabel, segmentLabel } from "@/lib/labels";

export default function BusinessLayout({ children }: { children: React.ReactNode }) {
  const { profile } = usePortalProfile("business");
  const path = usePathname();
  const [org, setOrg] = useState<OrgSummary | null | undefined>(undefined);
  const [pending, setPending] = useState(0);
  const { lang, dir } = useLang();
  const t = useT(BIZ);

  const loadOrg = useCallback(async () => {
    const db = supabase();
    const { data } = await db.rpc("org_summary");
    const o = (data ?? null) as OrgSummary | null;
    setOrg(o);
    if (o) {
      const { count } = await db.from("orders").select("id", { count: "exact", head: true }).eq("org_id", o.id).eq("status", "pending_approval");
      setPending(count ?? 0);
    }
  }, []);

  useLive("biz-shell", profile ? ["orders"] : [], async () => {
    if (profile) await loadOrg();
  });

  // Print view of an invoice: no portal chrome.
  if (path.startsWith("/business/invoice/")) {
    if (!profile || org === undefined)
      return (
        <div className="inv-print-loading" dir={dir} lang={lang}>
          {t("loading")}
        </div>
      );
    if (!org)
      return (
        <div className="inv-print-loading" dir={dir} lang={lang}>
          {t("noAccount")}
        </div>
      );
    return <BizProvider value={{ profile, org, reloadOrg: loadOrg }}>{children}</BizProvider>;
  }

  if (!profile || org === undefined) return <PortalLoading />;
  const who = t("signedInAs", { name: profile.full_name || t("businessUser") });

  if (!org) {
    return (
      <PortalShell app={t("appName")} who={who} title={t("openAccount")} description={t("openAccountDesc")}>
        <OrgInvitations onJoined={loadOrg} />
        <RegisterOrg onDone={loadOrg} />
      </PortalShell>
    );
  }

  const role = org.my_role ?? profile.org_role;
  // Finance (prototype: "Invoices only") sees billing, orders to check them, and service levels.
  const financeHides = ["/business/sites", "/business/contracts", "/business/team"];
  const tabs: PortalTab[] = [
    { href: "/business", label: t("tDashboard") },
    { href: "/business/orders", label: t("orders"), badge: role === "admin" ? pending : 0 },
    { href: "/business/sites", label: t("tSites") },
    { href: "/business/contracts", label: t("tContracts") },
    { href: "/business/invoices", label: t("tInvoices") },
    { href: "/business/team", label: t("tTeam") },
    { href: "/business/sla", label: t("tSla") },
    { href: "/business/complaints", label: t("tComplaints") },
  ]
    .filter((t) => role !== "finance" || !financeHides.includes(t.href))
    // Members limited to some sites (Team → Sites): invoices are organisation-wide.
    .filter((t) => !org.sites_restricted || t.href !== "/business/invoices");
  const banner =
    org.status === "pending" ? (
      <div className="banner">
        <b>{t("banPendingB")}</b> {t("banPending")}
      </div>
    ) : org.status === "suspended" ? (
      <div className="banner badb">
        <b>{t("banSuspB")}</b> {t("banSusp")}
      </div>
    ) : org.paused ? (
      <div className="banner badb">
        <b>{t("banPausedB")}</b> {t("banPaused")}
      </div>
    ) : null;

  return (
    <PortalShell
      app={t("appName")}
      who={`${who} · ${role ? orgRoleLabel(role, lang) : t("member")} · ${org.name}`}
      title={org.name}
      description={t("desc")}
      tabs={tabs}
      banner={banner}
    >
      <BizProvider value={{ profile, org, reloadOrg: loadOrg }}>{children}</BizProvider>
    </PortalShell>
  );
}

/** Invitations from an existing business account, shown before the user opens their own. */
function OrgInvitations({ onJoined }: { onJoined: () => void }) {
  const { invitations, respond } = useMyInvitations("org_member");
  const { busy, run } = useAction();
  const { lang } = useLang();
  const t = useT(BIZ);
  const f = useFmt();
  if (!invitations.length) return null;
  return (
    <div className="panel">
      <h2>{t("invited")}</h2>
      <div className="pad">
        {invitations.map((i) => (
          <div key={i.id} className="banner info" role="status">
            <b>{i.from ?? t("aBusinessAccount")}</b> {t("invitedJoin", { role: i.org_role ? orgRoleLabel(i.org_role, lang) : t("aMember"), date: f.date(i.expires_at) })}
            <div className="btns" style={{ marginTop: 8 }}>
              <button className="btn pri" disabled={busy !== null} onClick={() => run(i.id, () => respond(i.id, true).then((error) => ({ error })), t("joined"), onJoined)}>
                {t("accept")}
              </button>
              <button className="btn" disabled={busy !== null} onClick={() => run(i.id, () => respond(i.id, false).then((error) => ({ error })), t("invDeclined"))}>
                {t("decline")}
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="note">{t("acceptNote")}</p>
    </div>
  );
}

function RegisterOrg({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [cr, setCr] = useState("");
  const [segment, setSegment] = useState<OrgSummary["segment"]>("commercial");
  const { busy, run } = useAction();
  const { lang } = useLang();
  const t = useT(BIZ);

  return (
    <div className="reg">
      <div className="steps3">
        <div>
          <b>{t("reg1B")}</b>
          {t("reg1")}
        </div>
        <div>
          <b>{t("reg2B")}</b>
          {t("reg2")}
        </div>
        <div>
          <b>{t("reg3B")}</b>
          {t("reg3")}
        </div>
      </div>
      <div className="panel">
        <h2>{t("bizDetails")}</h2>
        <form
          className="pad"
          onSubmit={(e) => {
            e.preventDefault();
            run("reg", async () => supabase().rpc("org_register", { p_name: name.trim(), p_cr_no: cr.trim(), p_segment: segment }), t("regDone"), onDone);
          }}
        >
          <div className="form">
            <div className="fld full">
              <label htmlFor="oName">{t("regName")}</label>
              <input id="oName" className="in" required minLength={2} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("phOrgName")} />
            </div>
            <div className="fld">
              <label htmlFor="oCr">{t("regCr")}</label>
              <input id="oCr" className="in" dir="ltr" required minLength={3} maxLength={30} value={cr} onChange={(e) => setCr(e.target.value)} placeholder="1234567" />
            </div>
            <div className="fld">
              <label htmlFor="oSeg">{t("segment")}</label>
              <select id="oSeg" className="in" value={segment} onChange={(e) => setSegment(e.target.value as OrgSummary["segment"])}>
                {(Object.keys(SEGMENT_LABEL) as OrgSummary["segment"][]).map((s) => (
                  <option key={s} value={s}>
                    {segmentLabel(s, lang)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="mut" style={{ fontSize: 13, margin: "0 0 12px" }}>
            {t("adminNote")}
          </p>
          <button className="btn pri" disabled={busy === "reg"}>
            {busy === "reg" ? t("submitting") : t("openAccount")}
          </button>
        </form>
      </div>
    </div>
  );
}
