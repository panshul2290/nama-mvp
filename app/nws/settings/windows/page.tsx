"use client";

// NWS → Settings → Delivery windows (0044): templates with date ranges, windows per day and
// blocked times. Operators and admins edit (audited); the apps offer the active template.
import { useCallback, useEffect, useState } from "react";
import { Empty, PageHead, ReadOnlyNote, useAudited } from "@/components/nws/admin/ui";
import { CONT } from "@/components/nws/i18n/continuity";
import { useStaff } from "@/components/nws/StaffContext";
import { Dialog } from "@/components/portal/kit";
import { useFmt } from "@/components/portal/i18n";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

type Range = { from: string; to: string; days?: number[]; label_en?: string; label_ar?: string };
type Tpl = {
  id: string; code: string; name_en: string; name_ar: string; kind: "normal" | "ramadan" | "eid" | "other"; starts_on: string | null; ends_on: string | null;
  windows: Range[]; blocked: Range[]; priority: number; active: boolean; notes: string | null;
};
const KINDS = ["normal", "ramadan", "eid", "other"] as const;
const BLANK: Tpl = { id: "", code: "", name_en: "", name_ar: "", kind: "other", starts_on: null, ends_on: null, windows: [{ from: "08:00", to: "10:00" }], blocked: [], priority: 10, active: true, notes: null };

export default function WindowsPage() {
  const { can } = useStaff();
  const t = useT(CONT);
  const f = useFmt();
  const { ask, dialog } = useAudited();
  const [rows, setRows] = useState<Tpl[] | null>(null);
  const [edit, setEdit] = useState<Tpl | null>(null);
  const editor = can("admin", "operator");
  const load = useCallback(() => {
    supabase()
      .from("delivery_window_templates")
      .select("*")
      .order("starts_on", { ascending: true, nullsFirst: true })
      .then(({ data }) => setRows((data ?? []) as Tpl[]));
  }, []);
  useEffect(load, [load]);
  const days = (r: Range) => (r.days?.length ? r.days.map((d) => t(`d${d}`)).join(", ") : t("wAllDays"));
  const ranges = (rs: Range[]) => rs.map((r) => `${r.from}–${r.to} (${days(r)}${r.label_en ? ` · ${f.ar ? r.label_ar || r.label_en : r.label_en}` : ""})`).join("; ");

  return (
    <>
      <PageHead title={t("wTitle")} sub={t("wSub")}>
        <button className="btn pri" disabled={!editor} onClick={() => setEdit(BLANK)}>
          {t("wNew")}
        </button>
      </PageHead>
      {!editor && <ReadOnlyNote who={t("whoAdminOps")} />}
      <div className="banner info">{t("wDatesTbc")}</div>
      <div className="panel">
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("wTemplate")}</th>
                <th>{t("wDates")}</th>
                <th>{t("wWindows")}</th>
                <th>{t("wBlocked")}</th>
                <th>{t("wPriority")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows?.length === 0 && <Empty cols={6}>—</Empty>}
              {rows?.map((r) => (
                <tr key={r.id}>
                  <td>
                    <b>{f.ar ? r.name_ar : r.name_en}</b> <span className="st">{t(`k_${r.kind}`)}</span> {!r.active && <span className="st warn">{t("wInactive")}</span>}
                    {r.notes && <small className="d-block mut">{r.notes}</small>}
                  </td>
                  <td>{r.starts_on ? `${f.date(r.starts_on)} – ${f.date(r.ends_on)}` : t("wNoDates")}</td>
                  <td>
                    <bdi dir="ltr">{ranges(r.windows)}</bdi>
                  </td>
                  <td>{r.blocked.length ? <bdi dir="ltr">{ranges(r.blocked)}</bdi> : "—"}</td>
                  <td>{f.n(r.priority)}</td>
                  <td>
                    <button className="btn sm" disabled={!editor} onClick={() => setEdit(r)}>
                      {t("wEdit")}
                    </button>{" "}
                    {r.starts_on && (
                      <button
                        className="btn sm"
                        disabled={!editor}
                        onClick={() =>
                          ask({ title: t("wDeleteQ"), confirm: t("wDelete"), danger: true, ok: t("wDeleted"), run: (reason) => supabase().rpc("staff_delete_window_template", { p_id: r.id, p_reason: reason }), done: load })
                        }
                      >
                        {t("wDelete")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {edit && (
        <TemplateDialog
          tpl={edit}
          onClose={() => setEdit(null)}
          onSave={(v) =>
            ask({
              title: t("wSaveQ"),
              confirm: t("wSave"),
              ok: t("wSaved"),
              run: (reason) => supabase().rpc("staff_save_window_template", { p_id: edit.id || null, p_t: v, p_reason: reason }),
              done: () => {
                setEdit(null);
                load();
              },
            })
          }
        />
      )}
      {dialog}
    </>
  );
}

function RangeRows({ value, onChange, labels }: { value: Range[]; onChange: (v: Range[]) => void; labels?: boolean }) {
  const t = useT(CONT);
  const set = (i: number, p: Partial<Range>) => onChange(value.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {value.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input className="in" type="time" aria-label={t("wFrom")} value={r.from} onChange={(e) => set(i, { from: e.target.value })} style={{ width: 110 }} />
          <input className="in" type="time" aria-label={t("wTo")} value={r.to === "24:00" ? "23:59" : r.to} onChange={(e) => set(i, { to: e.target.value })} style={{ width: 110 }} />
          {[0, 1, 2, 3, 4, 5, 6].map((d) => (
            <label key={d} className="small">
              <input
                type="checkbox"
                checked={r.days?.includes(d) ?? false}
                onChange={(e) => {
                  const ds = new Set(r.days ?? []);
                  if (e.target.checked) ds.add(d);
                  else ds.delete(d);
                  set(i, { days: ds.size ? [...ds].sort() : undefined });
                }}
              />{" "}
              {t(`d${d}`)}
            </label>
          ))}
          {labels && (
            <>
              <input className="in" aria-label={t("wLabel")} value={r.label_en ?? ""} onChange={(e) => set(i, { label_en: e.target.value })} style={{ width: 120 }} />
              <input className="in" aria-label={t("wLabel")} dir="rtl" value={r.label_ar ?? ""} onChange={(e) => set(i, { label_ar: e.target.value })} style={{ width: 120 }} />
            </>
          )}
          <button type="button" className="btn sm" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            {t("wRemove")}
          </button>
        </div>
      ))}
      <button type="button" className="btn sm" style={{ justifySelf: "start" }} onClick={() => onChange([...value, { from: "08:00", to: "10:00" }])}>
        {t("wAdd")}
      </button>
    </div>
  );
}

function TemplateDialog({ tpl, onClose, onSave }: { tpl: Tpl; onClose: () => void; onSave: (v: Record<string, unknown>) => void }) {
  const t = useT(CONT);
  const [v, setV] = useState<Tpl>(tpl);
  const set = (p: Partial<Tpl>) => setV({ ...v, ...p });
  const clean = (rs: Range[]) => rs.map((r) => ({ ...r, to: r.to === "23:59" ? "24:00" : r.to }));
  return (
    <Dialog title={tpl.id ? t("wEdit") : t("wNew")} onClose={onClose} wide>
      <div className="form">
        <div className="fld">
          <label htmlFor="wt-code">{t("wCode")}</label>
          <input id="wt-code" className="in" dir="ltr" disabled={Boolean(tpl.id)} value={v.code} placeholder="ramadan-2028" onChange={(e) => set({ code: e.target.value.toLowerCase() })} />
        </div>
        <div className="fld">
          <label htmlFor="wt-kind">{t("wKind")}</label>
          <select id="wt-kind" className="in" value={v.kind} onChange={(e) => set({ kind: e.target.value as Tpl["kind"] })}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`k_${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="wt-en">{t("wNameEn")}</label>
          <input id="wt-en" className="in" value={v.name_en} onChange={(e) => set({ name_en: e.target.value })} />
        </div>
        <div className="fld">
          <label htmlFor="wt-ar">{t("wNameAr")}</label>
          <input id="wt-ar" className="in" dir="rtl" value={v.name_ar} onChange={(e) => set({ name_ar: e.target.value })} />
        </div>
        <div className="fld">
          <label htmlFor="wt-s">{t("wStarts")}</label>
          <input id="wt-s" className="in" type="date" value={v.starts_on ?? ""} onChange={(e) => set({ starts_on: e.target.value || null })} />
        </div>
        <div className="fld">
          <label htmlFor="wt-e">{t("wEnds")}</label>
          <input id="wt-e" className="in" type="date" value={v.ends_on ?? ""} onChange={(e) => set({ ends_on: e.target.value || null })} />
        </div>
        <div className="fld">
          <label htmlFor="wt-p">{t("wPriority")}</label>
          <input id="wt-p" className="in" type="number" min={0} max={100} value={v.priority} onChange={(e) => set({ priority: Number(e.target.value) })} />
        </div>
        <div className="fld">
          <label className="small">
            <input type="checkbox" checked={v.active} onChange={(e) => set({ active: e.target.checked })} /> {t("wActive")}
          </label>
        </div>
        <div className="fld full">
          <span className="lbl">{t("wWindows")}</span>
          <RangeRows value={v.windows} onChange={(windows) => set({ windows })} />
        </div>
        <div className="fld full">
          <span className="lbl">{t("wBlocked")}</span>
          <RangeRows value={v.blocked} onChange={(blocked) => set({ blocked })} labels />
        </div>
        <div className="fld full">
          <label htmlFor="wt-n">{t("wNotes")}</label>
          <input id="wt-n" className="in" maxLength={300} value={v.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} />
        </div>
      </div>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          {t("cancel")}
        </button>
        <button
          className="btn pri"
          onClick={() =>
            onSave({ code: v.code, name_en: v.name_en, name_ar: v.name_ar, kind: v.kind, starts_on: v.starts_on ?? "", ends_on: v.ends_on ?? "", windows: clean(v.windows), blocked: clean(v.blocked), priority: v.priority, active: v.active, notes: v.notes ?? "" })
          }
        >
          {t("wSave")}
        </button>
      </div>
    </Dialog>
  );
}
