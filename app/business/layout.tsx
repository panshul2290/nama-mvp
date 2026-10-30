"use client";

import "./business.css";
import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";
import { BizProvider, ORG_ROLE_LABEL, SEGMENT_LABEL, type OrgSummary } from "@/components/business/BizContext";
import { useAction, useLive } from "@/components/portal/kit";
import { PortalLoading, PortalShell, usePortalProfile, type PortalTab } from "@/components/portal/PortalShell";
import { useMyInvitations } from "@/components/useInvitations";
import { supabase } from "@/lib/supabase/client";
import { omanDate } from "@/lib/time";

const DESCRIPTION =
  "Web portal for commercial and government customers: multi-site ordering on credit, contracts, monthly invoices, team access by site, and delivery performance against the SLA.";

export default function BusinessLayout({ children }: { children: React.ReactNode }) {
  const { profile } = usePortalProfile("business");
  const path = usePathname();
  const [org, setOrg] = useState<OrgSummary | null | undefined>(undefined);
  const [pending, setPending] = useState(0);

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
    if (!profile || org === undefined) return <div className="inv-print-loading">Loading…</div>;
    if (!org) return <div className="inv-print-loading">No business account.</div>;
    return <BizProvider value={{ profile, org, reloadOrg: loadOrg }}>{children}</BizProvider>;
  }

  if (!profile || org === undefined) return <PortalLoading />;
  const who = `Signed in as ${profile.full_name || "business user"}`;

  if (!org) {
    return (
      <PortalShell app="Business portal" who={who} title="Open an account" description="Hotels, compounds, farms and government sites order water in bulk on credit from NWS-permitted tankers.">
        <OrgInvitations onJoined={loadOrg} />
        <RegisterOrg onDone={loadOrg} />
      </PortalShell>
    );
  }

  const role = org.my_role ?? profile.org_role;
  // Finance (prototype: "Invoices only") sees billing, orders to check them, and service levels.
  const financeHides = ["/business/sites", "/business/contracts", "/business/team"];
  const tabs: PortalTab[] = [
    { href: "/business", label: "Dashboard" },
    { href: "/business/orders", label: "Orders", badge: role === "admin" ? pending : 0 },
    { href: "/business/sites", label: "Sites" },
    { href: "/business/contracts", label: "Contracts" },
    { href: "/business/invoices", label: "Invoices" },
    { href: "/business/team", label: "Team" },
    { href: "/business/sla", label: "Service levels" },
  ].filter((t) => role !== "finance" || !financeHides.includes(t.href));
  const banner =
    org.status === "pending" ? (
      <div className="banner">
        <b>Waiting for NWS approval</b> — NWS activates the account and sets your credit limit; you can add sites and invite your team meanwhile.
      </div>
    ) : org.status === "suspended" ? (
      <div className="banner badb">
        <b>Account suspended.</b> Contact NWS finance on 1442.
      </div>
    ) : org.paused ? (
      <div className="banner badb">
        <b>Ordering is paused on this account.</b> Contact NWS finance.
      </div>
    ) : null;

  return (
    <PortalShell
      app="Business portal"
      who={`${who} · ${role ? ORG_ROLE_LABEL[role] : "Member"} · ${org.name}`}
      title={org.name}
      description={DESCRIPTION}
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
  if (!invitations.length) return null;
  return (
    <div className="panel">
      <h2>You’ve been invited</h2>
      <div className="pad">
        {invitations.map((i) => (
          <div key={i.id} className="banner info" role="status">
            <b>{i.from ?? "A business account"}</b> invited you to join as {i.org_role ? ORG_ROLE_LABEL[i.org_role] : "a member"}. Expires {omanDate(i.expires_at)}.
            <div className="btns" style={{ marginTop: 8 }}>
              <button className="btn pri" disabled={busy !== null} onClick={() => run(i.id, () => respond(i.id, true).then((error) => ({ error })), "You joined the business account", onJoined)}>
                Accept
              </button>
              <button className="btn" disabled={busy !== null} onClick={() => run(i.id, () => respond(i.id, false).then((error) => ({ error })), "Invitation declined")}>
                Decline
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="note">Accepting joins that organisation instead of opening a new account.</p>
    </div>
  );
}

function RegisterOrg({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [cr, setCr] = useState("");
  const [segment, setSegment] = useState<OrgSummary["segment"]>("commercial");
  const { busy, run } = useAction();

  return (
    <div className="reg">
      <div className="steps3">
        <div>
          <b>1. Register</b>Your company name and Commercial Registration number.
        </div>
        <div>
          <b>2. NWS activation</b>NWS checks the CR and sets your credit limit and payment terms.
        </div>
        <div>
          <b>3. Order on account</b>Add your sites, invite your team and place bulk orders.
        </div>
      </div>
      <div className="panel">
        <h2>Business details</h2>
        <form
          className="pad"
          onSubmit={(e) => {
            e.preventDefault();
            run("reg", async () => supabase().rpc("org_register", { p_name: name.trim(), p_cr_no: cr.trim(), p_segment: segment }), "Account created — waiting for NWS approval", onDone);
          }}
        >
          <div className="form">
            <div className="fld full">
              <label htmlFor="oName">Registered company name</label>
              <input id="oName" className="in" required minLength={2} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Al Noor Hotel LLC" />
            </div>
            <div className="fld">
              <label htmlFor="oCr">Commercial Registration (CR) number</label>
              <input id="oCr" className="in" required minLength={3} maxLength={30} value={cr} onChange={(e) => setCr(e.target.value)} placeholder="1234567" />
            </div>
            <div className="fld">
              <label htmlFor="oSeg">Segment</label>
              <select id="oSeg" className="in" value={segment} onChange={(e) => setSegment(e.target.value as OrgSummary["segment"])}>
                {(Object.keys(SEGMENT_LABEL) as OrgSummary["segment"][]).map((s) => (
                  <option key={s} value={s}>
                    {SEGMENT_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="mut" style={{ fontSize: 13, margin: "0 0 12px" }}>
            You become the account admin. Credit limit, payment terms and the approval limit are set by NWS.
          </p>
          <button className="btn pri" disabled={busy === "reg"}>
            {busy === "reg" ? "Submitting…" : "Open an account"}
          </button>
        </form>
      </div>
    </div>
  );
}
