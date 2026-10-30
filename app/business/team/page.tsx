"use client";

import { useCallback, useMemo, useState } from "react";
import { ORG_ROLE_LABEL, useBiz } from "@/components/business/BizContext";
import { BIZ } from "@/components/business/i18n";
import { useFmt } from "@/components/portal/i18n";
import { Dialog, St, useAction, useLive } from "@/components/portal/kit";
import { useSentInvitations } from "@/components/useInvitations";
import { useT } from "@/lib/i18n";
import { orgRoleLabel } from "@/lib/labels";
import { formatPhone } from "@/lib/phone";
import { supabase } from "@/lib/supabase/client";
import type { OrgRole } from "@/lib/types";

type Member = { id: string; full_name: string; phone: string | null; org_role: OrgRole | null; created_at: string };
type Site = { id: string; label: string; area: string };
type SiteLink = { user_id: string; property_id: string };

// What each role can do: BIZ dictionary keys.
const ACCESS: Record<OrgRole, string> = { admin: "accAdmin", site_manager: "accSite", finance: "accFinance" };

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
  const t = useT(BIZ);
  const f = useFmt();

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
          {t("errPage", { error: loadError })}
        </div>
      )}
      <div className="panel">
        <div className="toolbar">
          <span className="mut" style={{ fontSize: 13 }}>
            {t("teamIntro")}
          </span>
          {isAdmin && (
            <button className="btn pri" onClick={() => setOpen(true)}>
              {t("inviteUser")}
            </button>
          )}
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("name")}</th>
                <th>{t("role")}</th>
                <th>{t("hAccess")}</th>
                <th>{t("hSites")}</th>
                <th>{t("phone")}</th>
                <th>{t("hSince")}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <b>{m.full_name || "—"}</b>
                    {m.id === profile.id && <small className="stack">{t("you")}</small>}
                  </td>
                  <td>{m.org_role ? orgRoleLabel(m.org_role, f.lang) : "—"}</td>
                  <td className="mut">{m.org_role ? t(ACCESS[m.org_role]) : ""}</td>
                  <td>
                    {sitesOf(m.id).length === 0 ? t("allSites") : sitesOf(m.id).map((id) => siteName.get(id) ?? "—").join(f.ar ? "، " : ", ")}
                    {isAdmin && m.id !== profile.id && (
                      <button className="btn sm" style={{ marginInlineStart: 8 }} onClick={() => setEditing(m)}>
                        {sitesOf(m.id).length === 0 ? t("limitSites") : t("change")}
                      </button>
                    )}
                  </td>
                  <td dir="ltr">{m.phone ? formatPhone(m.phone) : "—"}</td>
                  <td>{f.date(m.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {isAdmin && sent.invitations.length > 0 && (
          <>
            <h2 style={{ paddingTop: 12 }}>
              {t("pendingInv")} <small>{t("pendingInvSub")}</small>
            </h2>
            <div className="tblwrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("hContact")}</th>
                    <th>{t("role")}</th>
                    <th>{t("hSent")}</th>
                    <th>{t("hExpires")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sent.invitations.map((i) => (
                    <tr key={i.id}>
                      <td dir="ltr">{i.phone ? formatPhone(i.phone) : i.email}</td>
                      <td>{i.org_role ? orgRoleLabel(i.org_role, f.lang) : "—"}</td>
                      <td>{f.date(i.created_at)}</td>
                      <td>{i.expired ? <St tone="bad">{t("expired")}</St> : f.date(i.expires_at)}</td>
                      <td className="num">
                        <button className="btn sm" disabled={busy === i.id} onClick={() => run(i.id, () => supabase().rpc("revoke_invitation", { p_id: i.id }), t("revokedT"), sent.reload)}>
                          {t("revoke")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className="note">{t("teamNote")}</p>
      </div>
      {open && <InviteDialog onClose={() => setOpen(false)} onDone={sent.reload} />}
      {editing && <SitesDialog member={editing} sites={sites} current={sitesOf(editing.id)} onClose={() => setEditing(null)} onDone={load} />}
    </>
  );
}

function SitesDialog({ member, sites, current, onClose, onDone }: { member: Member; sites: Site[]; current: string[]; onClose: () => void; onDone: () => void }) {
  const [pick, setPick] = useState<Set<string>>(new Set(current));
  const { busy, run } = useAction();
  const t = useT(BIZ);
  const f = useFmt();
  const toggle = (id: string) =>
    setPick((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <Dialog title={t("sitesTitle", { name: member.full_name || t("thisMember") })} body={t("sitesBody")} onClose={onClose}>
      <div className="checks" style={{ display: "grid", gap: 6, margin: "8px 0 14px", maxHeight: 280, overflow: "auto" }}>
        {sites.length === 0 && <span className="mut">{t("noSitesYet")}</span>}
        {sites.map((s) => (
          <label key={s.id}>
            <input type="checkbox" checked={pick.has(s.id)} onChange={() => toggle(s.id)} /> {s.label}
            {s.area && <small className="mut"> · {s.area}</small>}
          </label>
        ))}
      </div>
      <p className="mut" style={{ fontSize: 12.5 }}>{pick.size === 0 ? t("wholeOrg") : pick.size === 1 ? t("nSites1") : t("nSitesN", { n: f.n(pick.size) })}</p>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onClose}>{t("cancel")}</button>
        <button
          className="btn pri"
          disabled={busy === "sites"}
          onClick={() =>
            run("sites", async () => supabase().rpc("org_set_member_sites", { p_member: member.id, p_property_ids: [...pick] }), t("sitesSaved"), () => {
              onDone();
              onClose();
            })
          }
        >
          {busy === "sites" ? t("saving") : t("save")}
        </button>
      </div>
    </Dialog>
  );
}

function InviteDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [contact, setContact] = useState("");
  const [role, setRole] = useState<OrgRole>("site_manager");
  const { busy, run } = useAction();
  const t = useT(BIZ);
  const f = useFmt();
  return (
    <Dialog title={t("inviteUser")} body={t("inviteBody")} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run("inv", async () => supabase().rpc("org_add_member", { p_contact: contact.trim(), p_role: role }), t("invSentT", { contact: contact.trim(), role: orgRoleLabel(role, f.lang) }), () => {
            onDone();
            onClose();
          });
        }}
      >
        <div className="fld">
          <label htmlFor="iEmail">{t("lContact")}</label>
          <input id="iEmail" className="in" type="text" inputMode="tel" dir="ltr" required value={contact} onChange={(e) => setContact(e.target.value)} placeholder="+968 9123 4567" autoFocus />
        </div>
        <div className="fld">
          <label htmlFor="iRole">{t("role")}</label>
          <select id="iRole" className="in" value={role} onChange={(e) => setRole(e.target.value as OrgRole)}>
            {(Object.keys(ORG_ROLE_LABEL) as OrgRole[]).map((r) => (
              <option key={r} value={r}>
                {orgRoleLabel(r, f.lang)}
              </option>
            ))}
          </select>
          <small className="hint">{t(ACCESS[role])}</small>
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn pri" disabled={busy === "inv"}>
            {busy === "inv" ? t("inviting") : t("inviteUser")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
