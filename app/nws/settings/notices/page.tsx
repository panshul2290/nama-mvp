"use client";

import { useCallback, useEffect, useState } from "react";
import { Empty, PageHead, ReadOnlyNote, useAudited } from "@/components/nws/admin/ui";
import { SETTINGS_OPS } from "@/components/nws/i18n/settingsOps";
import { SUPPORT } from "@/components/nws/i18n/support";
import { useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { MUSCAT_OFFSET_MS } from "@/lib/time";

// Settings → Service notices (#20, 0038): operators and admins post a supply-disruption notice in
// English and Arabic for all areas, some zones or some clusters, with a severity and a time
// window, optionally sent as a message too; customers see it in the app, businesses on their
// dashboard. Posting and ending are audited (staff_post_notice / staff_end_notice).
type Severity = "info" | "warning" | "critical";
type Scope = "all" | "zones" | "clusters";
type Notice = {
  id: string; title_en: string; title_ar: string; body_en: string; body_ar: string; severity: Severity; scope: Scope;
  zone_ids: string[]; cluster_codes: string[]; starts_at: string; ends_at: string | null; notified: number; created_at: string; ended_at: string | null;
};
type Zone = { id: string; name: string };
type Cluster = { code: string; name: string; name_ar: string | null };

const SEV_TONE: Record<Severity, string> = { info: "act", warning: "warn", critical: "bad" };
/** A datetime-local value typed in Muscat time → ISO. */
const muscatIso = (v: string) => (v ? new Date(Date.parse(`${v}:00Z`) - MUSCAT_OFFSET_MS).toISOString() : null);

export default function NoticesPage() {
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const t = useT(SUPPORT);
  const to = useT(SETTINGS_OPS);
  const f = useFmt();
  const editor = can("admin", "operator");
  const [list, setList] = useState<Notice[] | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [form, setForm] = useState({ title_en: "", title_ar: "", body_en: "", body_ar: "", severity: "warning" as Severity, scope: "zones" as Scope, starts: "", ends: "", notify: false });
  const [pickZ, setPickZ] = useState<string[]>([]);
  const [pickC, setPickC] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    const db = supabase();
    db.from("service_notices").select("*").order("created_at", { ascending: false }).limit(100).then(({ data }) => {
      setList((data ?? []) as Notice[]);
      setNow(Date.now());
    });
    db.from("zones").select("id, name").eq("active", true).eq("is_test", false).order("name").then(({ data }) => setZones((data ?? []) as Zone[]));
    db.from("clusters").select("code, name, name_ar").order("sort").then(({ data }) => setClusters((data ?? []) as Cluster[]));
  }, []);
  useEffect(load, [load]);

  const zoneName = (id: string) => zones.find((z) => z.id === id)?.name ?? "—";
  const clusterName = (code: string) => {
    const c = clusters.find((x) => x.code === code);
    return c ? (f.ar && c.name_ar ? c.name_ar : c.name) : code;
  };
  const areas = (n: Pick<Notice, "scope" | "zone_ids" | "cluster_codes">) =>
    n.scope === "all" ? t("scope_all") : n.scope === "zones" ? n.zone_ids.map(zoneName).join(", ") : n.cluster_codes.map(clusterName).join(", ");
  const status = (n: Notice) =>
    n.ended_at || (n.ends_at && Date.parse(n.ends_at) <= now) ? "stEnded" : Date.parse(n.starts_at) > now ? "stScheduled" : "stLive";
  const set = (k: keyof typeof form, v: string | boolean) => setForm((p) => ({ ...p, [k]: v }));

  function post() {
    setErr(null);
    if (form.title_en.trim().length < 3 || form.title_ar.trim().length < 3) return setErr(t("ntNeedTitles"));
    if (form.scope === "zones" && !pickZ.length) return setErr(t("ntNeedZone"));
    if (form.scope === "clusters" && !pickC.length) return setErr(t("ntNeedCluster"));
    ask({
      title: t("ntPostQ", { title: form.title_en.trim() }),
      body: t("ntPostB"),
      confirm: t("ntPost"),
      ok: t("ntPosted"),
      run: (reason) =>
        supabase().rpc("staff_post_notice", {
          p_title_en: form.title_en.trim(), p_title_ar: form.title_ar.trim(), p_body_en: form.body_en.trim(), p_body_ar: form.body_ar.trim(),
          p_severity: form.severity, p_scope: form.scope, p_zone_ids: form.scope === "zones" ? pickZ : [], p_clusters: form.scope === "clusters" ? pickC : [],
          p_starts_at: muscatIso(form.starts), p_ends_at: muscatIso(form.ends), p_notify: form.notify, p_reason: reason,
        }),
      done: () => {
        setForm((p) => ({ ...p, title_en: "", title_ar: "", body_en: "", body_ar: "", starts: "", ends: "", notify: false }));
        setPickZ([]);
        setPickC([]);
        load();
      },
    });
  }

  function end(n: Notice) {
    ask({ title: t("ntEnd"), body: t("ntEndB"), confirm: t("ntEnd"), ok: t("ntEnded"), danger: true, run: (reason) => supabase().rpc("staff_end_notice", { p_id: n.id, p_reason: reason }), done: load });
  }

  const preview = [form.title_en.trim(), [form.body_en.trim(), form.ends ? t("ntUntil", { t: form.ends.slice(11, 16) }) : ""].filter(Boolean).join(" ")].filter(Boolean).join(" — ");
  const previewAr = [form.title_ar.trim(), [form.body_ar.trim(), form.ends ? `حتى ${form.ends.slice(11, 16)}` : ""].filter(Boolean).join(" ")].filter(Boolean).join(" — "); // i18n-ignore: Arabic preview of the Arabic text

  return (
    <>
      <PageHead title={t("navNotices")} sub={t("ntSub")} />
      {!editor && <ReadOnlyNote who={t("ntEditors")} />}
      <div className="half">
        <div className="panel">
          <h2>{t("ntNew")}</h2>
          <div className="pad">
            <div className="row2">
              <div className="fld">
                <label htmlFor="nt-te">{t("ntTitleEn")}</label>
                <input id="nt-te" className="in" dir="ltr" maxLength={120} disabled={!editor} value={form.title_en} onChange={(e) => set("title_en", e.target.value)} />
              </div>
              <div className="fld">
                <label htmlFor="nt-ta">{t("ntTitleAr")}</label>
                <input id="nt-ta" className="in" dir="rtl" maxLength={120} disabled={!editor} value={form.title_ar} onChange={(e) => set("title_ar", e.target.value)} />
              </div>
            </div>
            <div className="row2">
              <div className="fld">
                <label htmlFor="nt-be">{t("ntBodyEn")}</label>
                <textarea id="nt-be" className="in" dir="ltr" rows={2} maxLength={500} disabled={!editor} value={form.body_en} onChange={(e) => set("body_en", e.target.value)} />
              </div>
              <div className="fld">
                <label htmlFor="nt-ba">{t("ntBodyAr")}</label>
                <textarea id="nt-ba" className="in" dir="rtl" rows={2} maxLength={500} disabled={!editor} value={form.body_ar} onChange={(e) => set("body_ar", e.target.value)} />
              </div>
            </div>
            <div className="row2">
              <div className="fld">
                <label htmlFor="nt-sev">{t("ntSeverity")}</label>
                <select id="nt-sev" className="in" disabled={!editor} value={form.severity} onChange={(e) => set("severity", e.target.value)}>
                  {(["info", "warning", "critical"] as const).map((s) => (
                    <option key={s} value={s}>
                      {t(`sev_${s}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="fld">
                <label htmlFor="nt-sc">{t("ntScope")}</label>
                <select id="nt-sc" className="in" disabled={!editor} value={form.scope} onChange={(e) => set("scope", e.target.value)}>
                  {(["all", "zones", "clusters"] as const).map((s) => (
                    <option key={s} value={s}>
                      {t(`scope_${s}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {form.scope === "zones" && (
              <div className="checks" style={{ marginBottom: 12, maxHeight: 160, overflow: "auto" }}>
                {zones.map((z) => (
                  <label key={z.id}>
                    <input type="checkbox" disabled={!editor} checked={pickZ.includes(z.id)} onChange={(e) => setPickZ((p) => (e.target.checked ? [...p, z.id] : p.filter((x) => x !== z.id)))} /> {z.name}
                  </label>
                ))}
              </div>
            )}
            {form.scope === "clusters" && (
              <div className="checks" style={{ marginBottom: 12 }}>
                {clusters.map((c) => (
                  <label key={c.code}>
                    <input type="checkbox" disabled={!editor} checked={pickC.includes(c.code)} onChange={(e) => setPickC((p) => (e.target.checked ? [...p, c.code] : p.filter((x) => x !== c.code)))} />{" "}
                    {clusterName(c.code)}
                  </label>
                ))}
              </div>
            )}
            <div className="row2">
              <div className="fld">
                <label htmlFor="nt-st">{t("ntStarts")}</label>
                <input id="nt-st" type="datetime-local" className="in" disabled={!editor} value={form.starts} onChange={(e) => set("starts", e.target.value)} />
              </div>
              <div className="fld">
                <label htmlFor="nt-en">{t("ntEnds")}</label>
                <input id="nt-en" type="datetime-local" className="in" disabled={!editor} value={form.ends} onChange={(e) => set("ends", e.target.value)} />
              </div>
            </div>
            <label style={{ display: "block", margin: "4px 0 12px", fontSize: 13.5 }}>
              <input type="checkbox" disabled={!editor} checked={form.notify} onChange={(e) => set("notify", e.target.checked)} /> {t("ntNotify")}
            </label>
            {(preview || previewAr) && (
              <div className={`banner ${form.severity === "critical" ? "badb" : form.severity === "info" ? "info" : ""}`}>
                <small>{t("ntPreview")}</small>
                <div dir="ltr" lang="en">{preview}</div>
                <div dir="rtl" lang="ar">{previewAr}</div>
              </div>
            )}
            {err && <div className="banner badb">{err}</div>}
            <button className="btn pri" disabled={!editor} onClick={post}>
              {t("ntPost")}
            </button>
          </div>
        </div>
        <div className="panel">
          <h2>{t("ntList")}</h2>
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>{t("ntNew")}</th>
                  <th>{t("ntAreas")}</th>
                  <th>{t("ntWhen")}</th>
                  <th className="num">{t("ntSent")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {!list && <Empty cols={5}>{to("loading")}</Empty>}
                {list?.length === 0 && <Empty cols={5}>{t("ntNone")}</Empty>}
                {list?.map((n) => {
                  const st = status(n);
                  return (
                    <tr key={n.id}>
                      <td>
                        <span className={`st ${SEV_TONE[n.severity]}`}>{t(`sev_${n.severity}`)}</span> <b>{f.ar ? n.title_ar : n.title_en}</b>
                        <small style={{ display: "block" }}>{f.ar ? n.body_ar : n.body_en}</small>
                      </td>
                      <td>{areas(n)}</td>
                      <td>
                        <span className={`st ${st === "stLive" ? "bad" : st === "stScheduled" ? "warn" : ""}`}>{t(st)}</span>
                        <small style={{ display: "block" }}>
                          {f.dateTime(n.starts_at)} → {n.ended_at ? f.dateTime(n.ended_at) : n.ends_at ? f.dateTime(n.ends_at) : t("ntNoEnd")}
                        </small>
                      </td>
                      <td className="num">{f.n(n.notified)}</td>
                      <td className="num">
                        {editor && st !== "stEnded" && (
                          <button className="btn sm" onClick={() => end(n)}>
                            {t("ntEnd")}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {dialog}
    </>
  );
}
