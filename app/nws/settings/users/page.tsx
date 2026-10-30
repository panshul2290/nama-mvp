"use client";

import { useCallback, useEffect, useState } from "react";
import { Empty, PageHead, ReadOnlyNote, useAudited } from "@/components/nws/admin/ui";
import { SETTINGS } from "@/components/nws/i18n/settings";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { friendlyError } from "@/lib/errors";
import { useLang, useT } from "@/lib/i18n";
import { staffRoleLabel } from "@/lib/labels";
import { supabase } from "@/lib/supabase/client";
import type { StaffRole } from "@/lib/types";

type StaffRow = { id: string; full_name: string; staff_role: StaffRole; staff_zones: string[]; created_at: string };
const ROLES: StaffRole[] = ["admin", "operator", "permit_officer", "inspector", "complaints_agent", "finance", "viewer"];
// Column keys of SETTINGS.
const MODULES = ["modLive", "modOrders", "modFleet", "modPermits", "modCustomers", "modComplaints", "modReports", "modSettings", "modFinance"];

// What each role may change, mirrored from the require_staff() checks in the staff RPCs
// (0008, 0012; since 0023 the Super admin passes every check). F = can make changes, V = view only.
// The second value is a SETTINGS key (or "" for none).
const MATRIX: Record<StaffRole, [string, string][]> = {
  admin: [["F", "mxEverything"], ["F", "mxOrdersAll"], ["F", "mxFleetAll"], ["F", "mxPermitsAll"], ["F", "mxCustAll"], ["F", "mxCases"], ["F", "mxReports"], ["F", "mxSettingsAll"], ["F", "mxFinanceAll"]],
  operator: [["F", "mxAlerts"], ["F", "mxOrdersAll"], ["F", "mxFleetAll"], ["V", ""], ["F", "mxCustOp"], ["F", "mxCases"], ["F", "mxReports"], ["F", "mxSettingsOp"], ["V", ""]],
  permit_officer: [["V", ""], ["V", ""], ["F", "mxDocsActivation"], ["F", "mxPermitStages"], ["V", ""], ["V", ""], ["F", "mxReports"], ["V", ""], ["V", ""]],
  inspector: [["F", "mxAckAlerts"], ["V", ""], ["F", "mxPenDocs"], ["F", "mxInspections"], ["V", ""], ["V", ""], ["F", "mxReports"], ["V", ""], ["V", ""]],
  complaints_agent: [["V", ""], ["F", "mxRefundsCc"], ["V", ""], ["V", ""], ["F", "mxGoodwillId"], ["F", "mxCases"], ["F", "mxReports"], ["V", ""], ["V", ""]],
  finance: [["V", ""], ["F", "mxRefunds"], ["F", "mxPenDecisions"], ["V", ""], ["F", "mxGoodwillBiz"], ["V", ""], ["F", "mxReports"], ["F", "mxPricing"], ["F", "mxPayouts"]],
  viewer: [["V", ""], ["V", ""], ["V", ""], ["V", ""], ["V", ""], ["V", ""], ["F", "mxReports"], ["V", ""], ["V", ""]],
};

export default function UsersPage() {
  const { staff, can } = useStaff();
  const { ask, dialog } = useAudited();
  const t = useT(SETTINGS);
  const f = useFmt();
  const { lang } = useLang();
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
      title: t("changeRoleT", { name: u.full_name || t("thisUser") }),
      body: t("changeRoleB", { from: staffRoleLabel(u.staff_role, lang), to: staffRoleLabel(role, lang) }),
      confirm: t("changeRole"),
      ok: t("roleChanged"),
      run: (reason) => supabase().rpc("staff_set_role", { p_user_id: u.id, p_staff_role: role, p_reason: reason }),
      done: load,
    });
  }
  function remove(u: StaffRow) {
    ask({
      title: t("removeT", { name: u.full_name || t("thisUser") }),
      body: t("removeB"),
      confirm: t("removeAccess"),
      danger: true,
      ok: t("accessRemoved"),
      run: (reason) => supabase().rpc("staff_set_role", { p_user_id: u.id, p_staff_role: null, p_reason: reason }),
      done: load,
    });
  }

  return (
    <>
      <PageHead title={t("navUsers")} sub={t("usersSub")} />
      {!admin && <ReadOnlyNote who={t("superAdmin")} />}
      <div className="panel">
        <div className="toolbar">
          <span className="mut" style={{ fontSize: 13 }}>{rows ? t("nUsers", { n: f.n(rows.length) }) : t("loading")} · {t("ssoNote")}</span>
          {admin && <button className="btn pri" onClick={() => setAdding(true)}>{t("addUser")}</button>}
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr><th>{t("name")}</th><th>{t("email")}</th><th>{t("role")}</th><th>{t("colZones")}</th><th>{t("colSince")}</th><th></th></tr>
            </thead>
            <tbody>
              {rows?.length === 0 && <Empty cols={6}>{t("noStaff")}</Empty>}
              {rows?.map((u) => {
                const self = u.id === staff.id;
                return (
                  <tr key={u.id}>
                    <td>{u.full_name || <span className="mut">{t("noName")}</span>}{self && <small style={{ display: "block" }}>{t("you")}</small>}</td>
                    <td>{emails.get(u.id) ? <bdi dir="ltr">{emails.get(u.id)}</bdi> : <span className="mut">—</span>}</td>
                    <td>
                      {admin && !self ? (
                        <select className="inl" aria-label={t("role")} value={u.staff_role} onChange={(e) => changeRole(u, e.target.value as StaffRole)}>
                          {ROLES.map((r) => <option key={r} value={r}>{staffRoleLabel(r, lang)}</option>)}
                        </select>
                      ) : (
                        <span title={self ? t("ownRole") : undefined}>{staffRoleLabel(u.staff_role, lang)}</span>
                      )}
                    </td>
                    <td>
                      {u.staff_zones?.length ? u.staff_zones.join(lang === "ar" ? "، " : ", ") : <span className="mut">{t("allZones")}</span>}
                      {admin && (
                        <button className="lk small" style={{ display: "block" }} onClick={() => setZoning(u)}>
                          {t("editZones")}
                        </button>
                      )}
                    </td>
                    <td><small>{f.fmt(u.created_at, { month: "short", year: "numeric" })}</small></td>
                    <td className="num">{admin && !self && <button className="btn sm bad" onClick={() => remove(u)}>{t("remove")}</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>{t("rolePerms")} <small>{t("fvLegend")}</small></h2>
        <div className="tblwrap">
          <table className="matrix">
            <thead>
              <tr><th>{t("role")}</th>{MODULES.map((m) => <th key={m}>{t(m)}</th>)}</tr>
            </thead>
            <tbody>
              {ROLES.map((r) => (
                <tr key={r}>
                  <td>{staffRoleLabel(r, lang)}</td>
                  {MATRIX[r].map(([c, why], i) => (
                    <td key={i} title={why ? t(why) : undefined}>{c === "F" ? <b>{t("fShort")}</b> : c === "V" ? t("vShort") : <span className="mut">—</span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">{t("permsNote")}</p>
      </div>

      {adding && <AddUser zones={zones} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {zoning && <EditZones user={zoning} zones={zones} onClose={() => setZoning(null)} onDone={() => { setZoning(null); load(); }} />}
      {dialog}
    </>
  );
}

function AddUser({ zones, onClose, onDone }: { zones: string[]; onClose: () => void; onDone: () => void }) {
  const { toast } = useStaff();
  const t = useT(SETTINGS);
  const { lang } = useLang();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffRole>("operator");
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <ReasonDialog
      title={t("addUser")}
      body={t("addUserB")}
      confirm={t("addUser")}
      extra={
        <>
          <div className="fld">
            <label htmlFor="au-email">{t("email")}</label>
            <input id="au-email" className="in" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@nws.com.om" />
          </div>
          <div className="fld">
            <label htmlFor="au-role">{t("role")}</label>
            <select id="au-role" className="in" value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
              {ROLES.map((r) => <option key={r} value={r}>{staffRoleLabel(r, lang)}</option>)}
            </select>
          </div>
          <div className="fld">
            <label>{t("colZones")}</label>
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
        if (!email.includes("@")) return toast(t("enterEmail"), true);
        const { error } = await supabase().rpc("staff_set_role_by_email", { p_email: email.trim(), p_staff_role: role, p_zones: picked, p_reason: reason });
        if (error) return toast(friendlyError(error, lang), true);
        toast(t("nowRole", { email: email.trim(), role: staffRoleLabel(role, lang) }));
        onDone();
      }}
    />
  );
}

function EditZones({ user, zones, onClose, onDone }: { user: StaffRow; zones: string[]; onClose: () => void; onDone: () => void }) {
  const { toast } = useStaff();
  const t = useT(SETTINGS);
  const { lang } = useLang();
  const [picked, setPicked] = useState<string[]>(user.staff_zones ?? []);
  return (
    <ReasonDialog
      title={t("zonesFor", { name: user.full_name || t("thisUser") })}
      body={t("zonesB")}
      confirm={t("saveZones")}
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
        if (error) return toast(friendlyError(error, lang), true);
        toast(t("zonesSaved"));
        onDone();
      }}
    />
  );
}
