"use client";

import { useCallback, useEffect, useState } from "react";
import { Empty, PageHead, ReadOnlyNote, useAudited } from "@/components/nws/admin/ui";
import { ReasonDialog, STAFF_ROLE_LABEL, useStaff } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import type { StaffRole } from "@/lib/types";

type StaffRow = { id: string; full_name: string; staff_role: StaffRole; staff_zones: string[]; created_at: string };
const ROLES: StaffRole[] = ["admin", "operator", "permit_officer", "inspector", "complaints_agent", "finance", "viewer"];
const MODULES = ["Live ops", "Orders", "Fleet", "Permits", "Customers", "Complaints", "Reports", "Settings", "Finance"];

// What each role may change, mirrored from the require_staff() checks in the staff RPCs
// (0008, 0012; since 0023 the Super admin passes every check). F = can make changes, V = view only.
const MATRIX: Record<StaffRole, [string, string][]> = {
  admin: [["F", "Everything operators can do"], ["F", "Assign, cancel, reschedule, refund"], ["F", "Block, assign drivers, penalties"], ["F", "Every permit step (not approving a tanker they inspected)"], ["F", "Block, verify ID, goodwill"], ["F", "Case actions, call-centre cases"], ["F", "Build and schedule"], ["F", "All settings, users and roles"], ["F", "Payout batches, business accounts"]],
  operator: [["F", "Alerts incl. suspend tanker, emergency mode"], ["F", "Assign, cancel, reschedule, refund"], ["F", "Block, assign drivers, penalties"], ["V", ""], ["F", "Block, verify ID"], ["F", "Case actions, call-centre cases"], ["F", "Build and schedule"], ["F", "Zones, emergency, incidents, fraud"], ["V", ""]],
  permit_officer: [["V", ""], ["V", ""], ["F", "Documents, company activation"], ["F", "Create, review, stages"], ["V", ""], ["V", ""], ["F", "Build and schedule"], ["V", ""], ["V", ""]],
  inspector: [["F", "Acknowledge/resolve alerts"], ["V", ""], ["F", "Penalties, documents"], ["F", "Inspections"], ["V", ""], ["V", ""], ["F", "Build and schedule"], ["V", ""], ["V", ""]],
  complaints_agent: [["V", ""], ["F", "Refunds, call-centre orders"], ["V", ""], ["V", ""], ["F", "Goodwill, verify ID"], ["F", "Case actions, call-centre cases"], ["F", "Build and schedule"], ["V", ""], ["V", ""]],
  finance: [["V", ""], ["F", "Refunds"], ["F", "Penalty decisions"], ["V", ""], ["F", "Goodwill, business accounts"], ["V", ""], ["F", "Build and schedule"], ["F", "Pricing, promotions, fraud"], ["F", "Payout batches"]],
  viewer: [["V", ""], ["V", ""], ["V", ""], ["V", ""], ["V", ""], ["V", ""], ["F", "Build and schedule"], ["V", ""], ["V", ""]],
};

export default function UsersPage() {
  const { staff, can } = useStaff();
  const { ask, dialog } = useAudited();
  const [rows, setRows] = useState<StaffRow[] | null>(null);
  const [zones, setZones] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [zoning, setZoning] = useState<StaffRow | null>(null);
  const [emails, setEmails] = useState<Map<string, string>>(new Map());
  const admin = can("admin");

  const load = useCallback(() => {
    const db = supabase();
    db.from("profiles").select("id, full_name, staff_role, staff_zones, created_at").eq("role", "nws_staff").order("full_name").then(({ data }) => setRows((data ?? []) as StaffRow[]));
    // Emails live in auth.users; staff_directory (0024, admin only) returns them for staff accounts.
    db.rpc("staff_directory").then(({ data }) => setEmails(new Map(((data ?? []) as { id: string; email: string }[]).map((x) => [x.id, x.email]))));
    db.from("zones").select("name").order("name").then(({ data }) => setZones(((data ?? []) as { name: string }[]).map((z) => z.name)));
  }, []);
  useEffect(load, [load]);

  function changeRole(u: StaffRow, role: StaffRole) {
    ask({
      title: `Change role for ${u.full_name || "this user"}`,
      body: `${STAFF_ROLE_LABEL[u.staff_role]} → ${STAFF_ROLE_LABEL[role]}. Takes effect on their next action.`,
      confirm: "Change role",
      ok: "Role changed",
      run: (reason) => supabase().rpc("staff_set_role", { p_user_id: u.id, p_staff_role: role, p_reason: reason }),
      done: load,
    });
  }
  function remove(u: StaffRow) {
    ask({
      title: `Remove ${u.full_name || "this user"} from NWS staff`,
      body: "They keep their account but lose access to the staff portal immediately.",
      confirm: "Remove access",
      danger: true,
      ok: "Staff access removed",
      run: (reason) => supabase().rpc("staff_set_role", { p_user_id: u.id, p_staff_role: null, p_reason: reason }),
      done: load,
    });
  }

  return (
    <>
      <PageHead title="Users and roles" sub="NWS staff accounts, their roles and zones, and what each role may change." />
      {!admin && <ReadOnlyNote who="a Super admin" />}
      <div className="panel">
        <div className="toolbar">
          <span className="mut" style={{ fontSize: 13 }}>{rows ? `${rows.length} NWS users` : "Loading…"} · single sign-on with NWS Active Directory (simulated)</span>
          {admin && <button className="btn pri" onClick={() => setAdding(true)}>Add user</button>}
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Email</th><th>Role</th><th>Zones</th><th>Since</th><th></th></tr>
            </thead>
            <tbody>
              {rows?.length === 0 && <Empty cols={6}>No staff users.</Empty>}
              {rows?.map((u) => {
                const self = u.id === staff.id;
                return (
                  <tr key={u.id}>
                    <td>{u.full_name || <span className="mut">No name</span>}{self && <small style={{ display: "block" }}>You</small>}</td>
                    <td>{emails.get(u.id) ?? <span className="mut">—</span>}</td>
                    <td>
                      {admin && !self ? (
                        <select className="inl" aria-label="Role" value={u.staff_role} onChange={(e) => changeRole(u, e.target.value as StaffRole)}>
                          {ROLES.map((r) => <option key={r} value={r}>{STAFF_ROLE_LABEL[r]}</option>)}
                        </select>
                      ) : (
                        <span title={self ? "You can’t change your own role" : undefined}>{STAFF_ROLE_LABEL[u.staff_role]}</span>
                      )}
                    </td>
                    <td>
                      {u.staff_zones?.length ? u.staff_zones.join(", ") : <span className="mut">All zones</span>}
                      {admin && (
                        <button className="lk small" style={{ display: "block" }} onClick={() => setZoning(u)}>
                          Edit zones
                        </button>
                      )}
                    </td>
                    <td><small>{new Date(u.created_at).toLocaleDateString(undefined, { month: "short", year: "numeric" })}</small></td>
                    <td className="num">{admin && !self && <button className="btn sm bad" onClick={() => remove(u)}>Remove</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Role permissions <small>F = full (can make changes), V = view</small></h2>
        <div className="tblwrap">
          <table className="matrix">
            <thead>
              <tr><th>Role</th>{MODULES.map((m) => <th key={m}>{m}</th>)}</tr>
            </thead>
            <tbody>
              {ROLES.map((r) => (
                <tr key={r}>
                  <td>{STAFF_ROLE_LABEL[r]}</td>
                  {MATRIX[r].map(([c, why], i) => (
                    <td key={i} title={why || undefined}>{c === "F" ? <b>F</b> : c === "V" ? "V" : <span className="mut">—</span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">Enforced by the database on every action, not just hidden in the screens. Hover a cell for details. Corporate customers manage their own users per site in the business portal.</p>
      </div>

      {adding && <AddUser zones={zones} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {zoning && <EditZones user={zoning} zones={zones} onClose={() => setZoning(null)} onDone={() => { setZoning(null); load(); }} />}
      {dialog}
    </>
  );
}

function AddUser({ zones, onClose, onDone }: { zones: string[]; onClose: () => void; onDone: () => void }) {
  const { toast } = useStaff();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffRole>("operator");
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <ReasonDialog
      title="Add user"
      body="The person must already have an account (they sign up once, then you grant the staff role). Leave zones empty for all zones."
      confirm="Add user"
      extra={
        <>
          <div className="fld">
            <label htmlFor="au-email">Email</label>
            <input id="au-email" className="in" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@nws.com.om" />
          </div>
          <div className="fld">
            <label htmlFor="au-role">Role</label>
            <select id="au-role" className="in" value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
              {ROLES.map((r) => <option key={r} value={r}>{STAFF_ROLE_LABEL[r]}</option>)}
            </select>
          </div>
          <div className="fld">
            <label>Zones</label>
            <div className="checks">
              {zones.map((z) => (
                <label key={z}>
                  <input type="checkbox" checked={picked.includes(z)} onChange={(e) => setPicked(e.target.checked ? [...picked, z] : picked.filter((x) => x !== z))} />
                  {z}
                </label>
              ))}
            </div>
          </div>
        </>
      }
      onCancel={onClose}
      onConfirm={async (reason) => {
        if (!email.includes("@")) return toast("Enter the person’s email.", true);
        const { error } = await supabase().rpc("staff_set_role_by_email", { p_email: email.trim(), p_staff_role: role, p_zones: picked, p_reason: reason });
        if (error) return toast(friendlyError(error), true);
        toast(`${email.trim()} is now ${STAFF_ROLE_LABEL[role]}`);
        onDone();
      }}
    />
  );
}

function EditZones({ user, zones, onClose, onDone }: { user: StaffRow; zones: string[]; onClose: () => void; onDone: () => void }) {
  const { toast } = useStaff();
  const [picked, setPicked] = useState<string[]>(user.staff_zones ?? []);
  return (
    <ReasonDialog
      title={`Zones for ${user.full_name || "this user"}`}
      body="Leave every zone unticked for all zones."
      confirm="Save zones"
      extra={
        <div className="fld">
          <div className="checks">
            {zones.map((z) => (
              <label key={z}>
                <input type="checkbox" checked={picked.includes(z)} onChange={(e) => setPicked(e.target.checked ? [...picked, z] : picked.filter((x) => x !== z))} />
                {z}
              </label>
            ))}
          </div>
        </div>
      }
      onCancel={onClose}
      onConfirm={async (reason) => {
        const { error } = await supabase().rpc("staff_set_zones", { p_user_id: user.id, p_zones: picked, p_reason: reason });
        if (error) return toast(friendlyError(error), true);
        toast("Zones saved");
        onDone();
      }}
    />
  );
}
