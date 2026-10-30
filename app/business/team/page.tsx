"use client";

import { useCallback, useMemo, useState } from "react";
import { ORG_ROLE_LABEL, useBiz } from "@/components/business/BizContext";
import { Dialog, fmtDate, St, useAction, useLive } from "@/components/portal/kit";
import { useSentInvitations } from "@/components/useInvitations";
import { formatPhone } from "@/lib/phone";
import { supabase } from "@/lib/supabase/client";
import type { OrgRole } from "@/lib/types";

type Member = { id: string; full_name: string; phone: string | null; org_role: OrgRole | null; created_at: string };
type Site = { id: string; label: string; area: string };
type SiteLink = { user_id: string; property_id: string };

// Screen text in one place (Arabic comes later).
const T = {
  sites: "Sites",
  allSites: "All sites",
  limit: "Limit sites",
  change: "Change",
  dialogTitle: (name: string) => `Sites ${name} can see`,
  dialogBody:
    "Choose the sites this person may order for and see orders, tracking, contracts and service levels of. Leave every box empty for the whole organisation. Members limited to some sites don't see invoices (they cover every site).",
  saved: "Site access saved",
  self: "You can't limit your own access",
};
const ACCESS: Record<OrgRole, string> = {
  admin: "Everything: orders, approvals, sites, contracts, invoices and team",
  site_manager: "Orders and tracking, sites and contracts",
  finance: "Invoices, payments and statements",
};

export default function BusinessTeam() {
  const { org, isAdmin, profile } = useBiz();
  const [members, setMembers] = useState<Member[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [links, setLinks] = useState<SiteLink[]>([]);
  const [editing, setEditing] = useState<Member | null>(null);
  const sent = useSentInvitations("org_member", isAdmin ? org.id : null);
  const { busy, run } = useAction();

  const load = useCallback(async () => {
    const { data, error } = await supabase().from("profiles").select("id, full_name, phone, org_role, created_at").eq("org_id", org.id).order("created_at");
    setLoadError(error?.message ?? null);
    if (!error) setMembers((data ?? []) as Member[]);
    const db = supabase();
    const [p, l] = await Promise.all([
      db.from("properties").select("id, label, area").eq("org_id", org.id).order("label"),
      db.from("org_member_sites").select("user_id, property_id").eq("org_id", org.id),
    ]);
    setSites((p.data ?? []) as Site[]);
    setLinks((l.data ?? []) as SiteLink[]);
  }, [org.id]);
  useLive("biz-team", ["profiles", "org_member_sites"], load, 120_000);
  const siteName = useMemo(() => new Map(sites.map((s) => [s.id, s.label])), [sites]);
  const sitesOf = (id: string) => links.filter((l) => l.user_id === id).map((l) => l.property_id);

  return (
    <>
      {loadError && (
        <div className="banner badb" role="alert">
          Couldn’t load this page: {loadError}. It retries automatically.
        </div>
      )}
      <div className="panel">
        <div className="toolbar">
          <span className="mut" style={{ fontSize: 13 }}>
            People in your organisation who can order and view invoices
          </span>
          {isAdmin && (
            <button className="btn pri" onClick={() => setOpen(true)}>
              Invite user
            </button>
          )}
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Access</th>
                <th>{T.sites}</th>
                <th>Phone</th>
                <th>Member since</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <b>{m.full_name || "—"}</b>
                    {m.id === profile.id && <small className="stack">You</small>}
                  </td>
                  <td>{m.org_role ? ORG_ROLE_LABEL[m.org_role] : "—"}</td>
                  <td className="mut">{m.org_role ? ACCESS[m.org_role] : ""}</td>
                  <td>
                    {sitesOf(m.id).length === 0 ? T.allSites : sitesOf(m.id).map((id) => siteName.get(id) ?? "—").join(", ")}
                    {isAdmin && m.id !== profile.id && (
                      <button className="btn sm" style={{ marginInlineStart: 8 }} onClick={() => setEditing(m)}>
                        {sitesOf(m.id).length === 0 ? T.limit : T.change}
                      </button>
                    )}
                  </td>
                  <td dir="ltr">{m.phone ? formatPhone(m.phone) : "—"}</td>
                  <td>{fmtDate(m.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {isAdmin && sent.invitations.length > 0 && (
          <>
            <h2 style={{ paddingTop: 12 }}>
              Pending invitations <small>the person accepts when they sign in to the Business portal</small>
            </h2>
            <div className="tblwrap">
              <table>
                <thead>
                  <tr>
                    <th>Mobile / email</th>
                    <th>Role</th>
                    <th>Sent</th>
                    <th>Expires</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sent.invitations.map((i) => (
                    <tr key={i.id}>
                      <td dir="ltr">{i.phone ? formatPhone(i.phone) : i.email}</td>
                      <td>{i.org_role ? ORG_ROLE_LABEL[i.org_role] : "—"}</td>
                      <td>{fmtDate(i.created_at)}</td>
                      <td>{i.expired ? <St tone="bad">Expired</St> : fmtDate(i.expires_at)}</td>
                      <td className="num">
                        <button className="btn sm" disabled={busy === i.id} onClick={() => run(i.id, () => supabase().rpc("revoke_invitation", { p_id: i.id }), "Invitation revoked", sent.reload)}>
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className="note">Anyone can be limited to some sites (Sites column): they then see and order for those sites only. Site managers order and track for your sites. Finance sees orders, invoices and statements, but doesn’t order. Only account admins approve orders above the approval limit.</p>
      </div>
      {open && <InviteDialog onClose={() => setOpen(false)} onDone={sent.reload} />}
      {editing && <SitesDialog member={editing} sites={sites} current={sitesOf(editing.id)} onClose={() => setEditing(null)} onDone={load} />}
    </>
  );
}

function SitesDialog({ member, sites, current, onClose, onDone }: { member: Member; sites: Site[]; current: string[]; onClose: () => void; onDone: () => void }) {
  const [pick, setPick] = useState<Set<string>>(new Set(current));
  const { busy, run } = useAction();
  const toggle = (id: string) =>
    setPick((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <Dialog title={T.dialogTitle(member.full_name || "this member")} body={T.dialogBody} onClose={onClose}>
      <div className="checks" style={{ display: "grid", gap: 6, margin: "8px 0 14px", maxHeight: 280, overflow: "auto" }}>
        {sites.length === 0 && <span className="mut">No sites yet.</span>}
        {sites.map((s) => (
          <label key={s.id}>
            <input type="checkbox" checked={pick.has(s.id)} onChange={() => toggle(s.id)} /> {s.label}
            {s.area && <small className="mut"> · {s.area}</small>}
          </label>
        ))}
      </div>
      <p className="mut" style={{ fontSize: 12.5 }}>{pick.size === 0 ? "Whole organisation" : `${pick.size} site${pick.size === 1 ? "" : "s"}`}</p>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn pri"
          disabled={busy === "sites"}
          onClick={() =>
            run("sites", async () => supabase().rpc("org_set_member_sites", { p_member: member.id, p_property_ids: [...pick] }), T.saved, () => {
              onDone();
              onClose();
            })
          }
        >
          {busy === "sites" ? "Saving…" : "Save"}
        </button>
      </div>
    </Dialog>
  );
}

function InviteDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [contact, setContact] = useState("");
  const [role, setRole] = useState<OrgRole>("site_manager");
  const { busy, run } = useAction();
  return (
    <Dialog
      title="Invite user"
      body="The person must first create a Business portal account (at /signup?app=business) with this mobile number (or email, for older accounts). They join your organisation when they accept the invitation after signing in."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run("inv", async () => supabase().rpc("org_add_member", { p_contact: contact.trim(), p_role: role }), `Invitation sent to ${contact.trim()} as ${ORG_ROLE_LABEL[role]}`, () => {
            onDone();
            onClose();
          });
        }}
      >
        <div className="fld">
          <label htmlFor="iEmail">Mobile number or work email</label>
          <input id="iEmail" className="in" type="text" inputMode="tel" dir="ltr" required value={contact} onChange={(e) => setContact(e.target.value)} placeholder="+968 9123 4567" autoFocus />
        </div>
        <div className="fld">
          <label htmlFor="iRole">Role</label>
          <select id="iRole" className="in" value={role} onChange={(e) => setRole(e.target.value as OrgRole)}>
            {(Object.keys(ORG_ROLE_LABEL) as OrgRole[]).map((r) => (
              <option key={r} value={r}>
                {ORG_ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          <small className="hint">{ACCESS[role]}</small>
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" disabled={busy === "inv"}>
            {busy === "inv" ? "Inviting…" : "Invite user"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
