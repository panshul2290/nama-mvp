"use client";

// NWS → Permits → Register → Import register (permit officers and admins).
// 1. Choose a CSV (XLSX isn't supported: no spreadsheet parser is installed — save as CSV UTF-8).
// 2. Map columns when the headers differ from the NWS register's.
// 3. Preview: rows OK / with warnings / with errors, duplicates in the file and against the
//    database, the governorate → cluster check. Validation runs in the browser (lib/importRegister);
//    the database checks every row again.
// 4. Import in chunks of 500 through staff_import_register, with progress; cancel stops after
//    the current chunk. 5. Result, the downloadable error report, and "Invite owners by SMS".
import { useRef, useState } from "react";
import { fetchPaged } from "@/components/nws/admin/ui";
import { REG } from "@/components/nws/i18n/register";
import { downloadCsv, Kpi, Modal, St } from "@/components/nws/ops";
import { useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { friendlyError } from "@/lib/errors";
import { useLang, useT } from "@/lib/i18n";
import {
  addCounts, chunks, clientOnlyIssues, FIELDS, guessMapping, isRegisterLayout, issuesTable, mappingComplete, normalizePlate, parseCsv, REQUIRED,
  T as IT, validateRows, type Existing, type Issue, type Mapping, type ServiceType, type Validated,
} from "@/lib/importRegister";
import { supabase } from "@/lib/supabase/client";
import { omanDateKey } from "@/lib/time";
import { InviteDialog } from "./InviteDialog";
import type { Geo } from "./geo";

// Counts shown after an import, in order (labels: REG["count.<key>"]).
const COUNT_KEYS = ["tankers_created", "tankers_updated", "owners_created", "owners_matched", "permits_created", "applications_created", "permits_existing", "no_phone", "warnings", "errors"];

type Step =
  | { k: "file"; error?: string; busy?: boolean }
  | { k: "map"; name: string; headers: string[]; data: string[][]; mapping: Mapping }
  | { k: "preview"; name: string; headers: string[]; data: string[][]; mapping: Mapping; v: Validated | null }
  | { k: "run"; name: string; total: number; done: number; chunk: number; chunks: number; stop: boolean }
  | { k: "done"; name: string; batch: string; status: "completed" | "cancelled" | "failed"; counts: Record<string, number>; error?: string; issues: Issue[] };

export function ImportRegister({ geo, onClose, onImported }: { geo: Geo; onClose: () => void; onImported: () => void }) {
  const { toast } = useStaff();
  const t = useT(REG);
  const f = useFmt();
  const { lang } = useLang();
  const fieldName = (k: string) => (REG[`field.${k}`] ? t(`field.${k}`) : (IT.fields[k as keyof typeof IT.fields] ?? k));
  const [step, setStep] = useState<Step>({ k: "file" });
  const [show, setShow] = useState<"error" | "warning">("error");
  const [invite, setInvite] = useState(false);
  const stopRef = useRef(false);

  const govRefs = geo.governorates.map((g) => ({ code: g.code, name: g.name, cluster: g.cluster_code, aliases: g.aliases ?? [] }));

  async function preview(name: string, headers: string[], data: string[][], mapping: Mapping) {
    setStep({ k: "preview", name, headers, data, mapping, v: null });
    // Existing tankers by normalised plate (paged: the register holds ~11,000).
    const ex = await fetchPaged<{ plate: string; service_type: ServiceType; on_platform: boolean; in_register: boolean }>(
      (a, b) => supabase().from("tankers").select("plate, service_type, on_platform, in_register").order("id").range(a, b), 100000);
    const existing: Existing = new Map();
    for (const t of ex.rows) {
      const p = normalizePlate(t.plate);
      if (p && (!existing.has(p) || t.on_platform)) existing.set(p, t);
    }
    const v = validateRows(data, mapping, {
      firstRow: 2, existing, today: omanDateKey(new Date()), govs: govRefs.length ? govRefs : undefined, clusters: geo.clusters.map((c) => c.code),
    });
    if (ex.error) toast(t("checkDbErr", { e: friendlyError(ex.error, lang) }), true);
    setStep({ k: "preview", name, headers, data, mapping, v });
  }

  async function pick(file: File) {
    if (/\.(xlsx|xls|xlsm|ods)$/i.test(file.name)) return setStep({ k: "file", error: t("xlsx") });
    setStep({ k: "file", busy: true });
    const all = parseCsv(await file.text());
    const headers = all[0] ?? [];
    const data = all.slice(1);
    if (!data.length) return setStep({ k: "file", error: t("emptyFile") });
    const mapping = guessMapping(headers);
    if (isRegisterLayout(headers) && mappingComplete(mapping)) return preview(file.name, headers, data, mapping);
    setStep({ k: "map", name: file.name, headers, data, mapping });
  }

  async function run(s: Extract<Step, { k: "preview" }>) {
    const v = s.v!;
    const db = supabase();
    stopRef.current = false;
    const { data: b, error: be } = await db.rpc("staff_import_batch_start", { p_file_name: s.name, p_total: v.summary.total, p_summary: v.summary, p_source: "upload" });
    if (be || !b) return toast(friendlyError(be, lang), true);
    const batch = (b as { id: string }).id;
    const parts = chunks(v.rows, 500);
    let counts: Record<string, number> = {};
    let error: string | undefined;
    let status: "completed" | "cancelled" | "failed" = "completed";
    setStep({ k: "run", name: s.name, total: v.rows.length, done: 0, chunk: 0, chunks: parts.length, stop: false });
    for (let i = 0; i < parts.length; i++) {
      if (stopRef.current) {
        status = "cancelled";
        break;
      }
      let res: { counts: Record<string, number> } | null = null;
      for (let attempt = 1; attempt <= 3 && !res; attempt++) {
        const { data, error: e } = await db.rpc("staff_import_register", { p_rows: parts[i], p_batch_id: batch });
        if (!e) res = data as { counts: Record<string, number> };
        else if (attempt === 3) error = friendlyError(e, lang);
        else await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
      if (!res) {
        status = "failed";
        break;
      }
      counts = addCounts(counts, res.counts);
      setStep({ k: "run", name: s.name, total: v.rows.length, done: Math.min((i + 1) * 500, v.rows.length), chunk: i + 1, chunks: parts.length, stop: stopRef.current });
    }
    const { data: fin, error: fe } = await db.rpc("staff_import_batch_finish", { p_batch_id: batch, p_client_issues: clientOnlyIssues(v.issues), p_status: status });
    if (fe) error = error ?? friendlyError(fe, lang);
    const issues = ((fin as { errors?: Issue[] } | null)?.errors ?? clientOnlyIssues(v.issues)) as Issue[];
    setStep({ k: "done", name: s.name, batch, status, counts, error, issues });
    onImported();
  }

  return (
    <Modal title={t("imTitle")} wide onClose={() => (step.k === "run" ? undefined : onClose())}>
      {step.k === "file" && (
        <>
          <p><b>{t("step1")}</b></p>
          <p className="mut" style={{ fontSize: 13 }}>{t("step1Note")}</p>
          <input type="file" accept=".csv,text/csv" aria-label={t("step1")} disabled={step.busy} onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
          {step.busy && <p className="mut">{t("reading")}</p>}
          {step.error && <div className="banner badb" role="alert" style={{ marginTop: 12 }}>{step.error}</div>}
          <div className="btns" style={{ justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn" onClick={onClose}>{t("cancel")}</button>
          </div>
        </>
      )}

      {step.k === "map" && (
        <>
          <p><b>{t("step2")}</b> <small className="mut"><bdi dir="ltr">{step.name}</bdi> · {t("rowsN", { n: f.n(step.data.length) })}</small></p>
          <p className="mut" style={{ fontSize: 13 }}>{t("step2Note")}</p>
          <div className="regmap">
            {FIELDS.map((f) => (
              <div className="fld" key={f} style={{ margin: 0 }}>
                <label htmlFor={`map-${f}`}>{fieldName(f)}{REQUIRED.includes(f) ? " *" : ""}</label>
                <select id={`map-${f}`} className="in" value={step.mapping[f] ?? ""}
                  onChange={(e) => setStep({ ...step, mapping: { ...step.mapping, [f]: e.target.value === "" ? null : Number(e.target.value) } })}>
                  <option value="">{t("notInFile")}</option>
                  {step.headers.map((h, i) => (
                    <option key={i} value={i}>{h || t("columnN", { n: i + 1 })}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <div className="btns" style={{ justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn" onClick={() => setStep({ k: "file" })}>{t("back")}</button>
            <button className="btn pri" disabled={!mappingComplete(step.mapping)} onClick={() => preview(step.name, step.headers, step.data, step.mapping)}>{t("step3")}</button>
          </div>
        </>
      )}

      {step.k === "preview" && !step.v && <p className="mut">{t("checkDb")}</p>}
      {step.k === "preview" && step.v && (() => {
        const s = step.v.summary;
        const list = step.v.issues.filter((x) => x.level === show);
        return (
          <>
            <p><b>{t("step3")}</b> <small className="mut"><bdi dir="ltr">{step.name}</bdi></small></p>
            <div className="okpis">
              <Kpi label={t("rows")} value={f.n(s.total)} sub={t("okN", { n: f.n(s.ok) })} tone="ok" />
              <Kpi label={t("warnings")} value={f.n(s.warnings)} sub={t("warningsSub")} tone={s.warnings ? "warn" : ""} />
              <Kpi label={t("errors")} value={f.n(s.errors)} sub={t("errorsSub")} tone={s.errors ? "bad" : ""} />
              <Kpi label={t("existing")} value={f.n(s.existing)} sub={t("existingSub", { n: f.n(s.existing_on_platform) })} />
              <Kpi label={t("fresh")} value={f.n(s.new_tankers)} sub={t("freshSub")} />
            </div>
            <ul className="plain regsum">
              <li>{t("sumPermits", { v: f.n(s.status.valid), a: f.n(s.status.in_progress), n: f.n(s.status.none) })}</li>
              <li>{t("sumPhones", { w: f.n(s.with_phone), n: f.n(s.no_phone), o: f.n(s.owners_by_phone) })}</li>
              <li>{s.inconsistent_governorates.length ? t("clusterBad", { g: s.inconsistent_governorates.map((g) => geo.govName(g)).join(lang === "ar" ? "، " : ", ") }) : t("clusterOk")}</li>
              {s.duplicates > 0 && <li>{t("dupes", { n: f.n(s.duplicates) })}</li>}
            </ul>
            <div className="toolbar" style={{ padding: "8px 0" }}>
              <div className="chips">
                <button className={`chip ${show === "error" ? "on" : ""}`} onClick={() => setShow("error")}>{t("showErrors")}<span className="tc">{f.n(step.v.issues.filter((x) => x.level === "error").length)}</span></button>
                <button className={`chip ${show === "warning" ? "on" : ""}`} onClick={() => setShow("warning")}>{t("showWarnings")}<span className="tc">{f.n(step.v.issues.filter((x) => x.level === "warning").length)}</span></button>
              </div>
              <button className="btn sm" disabled={!step.v.issues.length} onClick={() => downloadCsv(`register-issues-${omanDateKey(new Date())}`, issuesTable(step.v!.issues))}>{t("downloadIssues")}</button>
            </div>
            <div className="tblwrap" style={{ maxHeight: 260, overflowY: "auto" }}>
              <table>
                <thead><tr><th className="num">{t("colRow")}</th><th>{t("colPlate")}</th><th>{t("colField")}</th><th>{t("colIssue")}</th></tr></thead>
                <tbody>
                  {list.length === 0 && <tr><td colSpan={4} className="empty">{t("noIssues")}</td></tr>}
                  {list.slice(0, 200).map((x, i) => (
                    <tr key={`${x.row}-${x.field}-${i}`}>
                      <td className="num">{f.n(x.row)}</td>
                      <td style={{ whiteSpace: "nowrap" }} dir="ltr">{x.plate || "—"}</td>
                      <td>{fieldName(x.field)}</td>
                      {/* The issue text comes from lib/importRegister and is also the downloadable report (English). */}
                      <td><St tone={x.level === "error" ? "bad" : "warn"}><bdi dir="ltr">{x.message}</bdi></St></td>
                    </tr>
                  ))}
                  {list.length > 200 && <tr><td colSpan={4} className="mut">{t("moreN", { n: f.n(list.length - 200) })}</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="btns" style={{ justifyContent: "flex-end", marginTop: 16 }}>
              <button className="btn" onClick={() => setStep({ k: "map", name: step.name, headers: step.headers, data: step.data, mapping: step.mapping })}>{t("back")}</button>
              <button className="btn" onClick={onClose}>{t("cancel")}</button>
              <button className="btn pri" disabled={!s.send} onClick={() => run(step)}>{t("startN", { n: f.n(s.send) })}</button>
            </div>
          </>
        );
      })()}

      {step.k === "run" && (
        <>
          <p><b>{t("importing")}</b> <small className="mut"><bdi dir="ltr">{step.name}</bdi></small></p>
          <div className="regprog" role="progressbar" aria-valuemin={0} aria-valuemax={step.total} aria-valuenow={step.done}>
            <div style={{ width: `${step.total ? (step.done / step.total) * 100 : 0}%` }} />
          </div>
          <p className="mut" style={{ fontSize: 13 }}>{t("progress", { c: f.n(step.chunk), n: f.n(step.chunks), rows: f.n(step.done) })}</p>
          <div className="btns" style={{ justifyContent: "flex-end" }}>
            <button className="btn" disabled={step.stop} onClick={() => { stopRef.current = true; setStep({ ...step, stop: true }); }}>{t("stop")}</button>
          </div>
        </>
      )}

      {step.k === "done" && (
        <>
          <p><b>{step.status === "completed" ? t("doneImport") : step.status === "cancelled" ? t("stopped") : t("failedImport")}</b> <small className="mut"><bdi dir="ltr">{step.name}</bdi></small></p>
          {step.error && <div className="banner badb" role="alert">{step.error}</div>}
          <div className="tblwrap">
            <table>
              <tbody>
                {COUNT_KEYS.map((k) => (
                  <tr key={k}><td>{t(`count.${k}`)}</td><td className="num"><b>{f.n(step.counts[k] ?? 0)}</b></td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="btns" style={{ justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn" disabled={!step.issues.length} onClick={() => downloadCsv(`register-import-report-${omanDateKey(new Date())}`, issuesTable(step.issues))}>{t("reportDl")} ({f.n(step.issues.length)})</button>
            <button className="btn" disabled={step.status === "failed"} onClick={() => setInvite(true)}>{t("invTitle")}</button>
            <button className="btn pri" onClick={onClose}>{t("close")}</button>
          </div>
          {invite && <InviteDialog who={t("inviteWho")} batch={step.batch} onClose={() => setInvite(false)} />}
        </>
      )}
    </Modal>
  );
}
