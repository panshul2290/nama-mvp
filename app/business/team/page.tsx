"use client";

import { useCallback, useState } from "react";
import { ORG_ROLE_LABEL, useBiz } from "@/components/business/BizContext";
import { Dialog, fmtDate, St, useAction, useLive } from "@/components/portal/kit";
import { useSentInvitations } from "@/components/useInvitations";
import { formatPhone } from "@/lib/phone";
import { supabase } from "@/lib/supabase/client";
import type { OrgRole } from "@/lib/types";

type Member = { id: string; full_name: string; phone: string | null; org_role: OrgRole | null; created_at: string };
const ACCESS: Record<OrgRole, string> = {
  admin: "Everything: orders, approvals, sites, contracts, invoices and team",
  site_manager: "Orders and tracking, sites and contracts",
  finance: "Invoices, payments and statements",
};

export default function BusinessTeam() {
  const { org, isAdmin, profile } = useBiz();
  const [members, setMembers] = useState<Member[]>([]);
  const [open, setOpen] = useState(false);
  const sent = useSentInvitations("org_member", isAdmin ? org.id : null);
  const { busy, run } = useAction();

  const load = useCallback(async () => {
    const { data } = await supabase().from("profiles").select("id, full_name, phone, org_role, created_at").eq("org_id", org.id).order("created_at");
    setMembers((data ?? []) as Member[]);
  }, [org.id]);
  useLive("biz-team", ["profiles"], load, 120_000);

  return (
    <>
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
                  <td>{m.phone || "—"}</td>
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
        <p className="note">Site managers order and track for your sites. Finance sees invoices and statements, not ordering. Only account admins approve orders above the approval limit.</p>
      </div>
      {open && <InviteDialog onClose={() => setOpen(false)} onDone={sent.reload} />}
    </>
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
