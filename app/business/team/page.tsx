"use client";

import { useCallback, useState } from "react";
import { ORG_ROLE_LABEL, useBiz } from "@/components/business/BizContext";
import { Dialog, fmtDate, useAction, useLive } from "@/components/portal/kit";
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
        <p className="note">Site managers order and track for your sites. Finance sees invoices and statements, not ordering. Only account admins approve orders above the approval limit.</p>
      </div>
      {open && <InviteDialog onClose={() => setOpen(false)} onDone={load} />}
    </>
  );
}

function InviteDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("site_manager");
  const { busy, run } = useAction();
  return (
    <Dialog
      title="Invite user"
      body="The person must first create a Business portal account (at /signup?app=business) with this email. Inviting links their account to your organisation."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run("inv", async () => supabase().rpc("org_add_member", { p_email: email.trim(), p_role: role }), `${email.trim()} added as ${ORG_ROLE_LABEL[role]}`, () => {
            onDone();
            onClose();
          });
        }}
      >
        <div className="fld">
          <label htmlFor="iEmail">Work email</label>
          <input id="iEmail" className="in" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
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
