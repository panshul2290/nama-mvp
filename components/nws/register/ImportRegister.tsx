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
import { downloadCsv, Kpi, Modal, St } from "@/components/nws/ops";
import { useStaff } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import {
  addCounts, chunks, clientOnlyIssues, FIELDS, guessMapping, isRegisterLayout, issuesTable, mappingComplete, normalizePlate, parseCsv, REQUIRED,
  T as IT, validateRows, type Existing, type Issue, type Mapping, type ServiceType, type Validated,
} from "@/lib/importRegister";
import { supabase } from "@/lib/supabase/client";
import { omanDateKey } from "@/lib/time";
import { InviteDialog } from "./InviteDialog";
import type { Geo } from "./geo";

const T = {
  title: "Import register",
  step1: "Choose the register file",
  step1Note: "CSV with the NWS register columns: Plate No., Owner, Tanker Type, Governorate, Cluster, Contact, Permit Status, Permit No., Permit Issued, Permit Expiry. Up to 100,000 rows.",
  xlsx: "Excel files can't be read here yet (no spreadsheet parser is installed). In Excel choose File → Save As → “CSV UTF-8 (comma delimited)” and upload that file.",
  empty: "The file has no data rows.",
  reading: "Reading the file…",
  step2: "Match the columns",
  step2Note: "The headers differ from the NWS register's. Choose which column holds each field; plate, tanker type and governorate are required.",
  notInFile: "— not in the file —",
  checkDb: "Checking plates against the database…",
  step3: "Preview",
  rows: "Rows",
  ok: "OK",
  warnings: "With warnings",
  warningsSub: "imported, listed in the report",
  errors: "With errors",
  errorsSub: "skipped",
  existing: "Already on file",
  existingSub: (p: number) => `updated by plate · ${p.toLocaleString()} on the platform`,
  fresh: "New tankers",
  freshSub: "offline, no driver, capacity unknown",
  permits: (v: number, a: number, n: number) => `Permits: ${v.toLocaleString()} valid → approved permit · ${a.toLocaleString()} in progress → application at the submitted stage · ${n.toLocaleString()} no permit`,
  phones: (w: number, n: number, o: number) => `Mobile numbers: ${w.toLocaleString()} usable (E.164) · ${n.toLocaleString()} missing or invalid · ${o.toLocaleString()} distinct owners by number`,
  clusterOk: "Governorate → cluster: consistent, one cluster per governorate.",
  clusterBad: (g: string) => `Governorate → cluster is inconsistent for ${g}: the governorate's cluster is used and those rows are flagged.`,
  dupes: (n: number) => `${n.toLocaleString()} plates repeat in the file (after normalising); later rows are skipped.`,
  issues: "Issues",
  showErrors: "Errors",
  showWarnings: "Warnings",
  more: (n: number) => `…and ${n.toLocaleString()} more in the downloadable report`,
  noIssues: "No issues found.",
  downloadIssues: "Download issues (CSV)",
  start: (n: number) => `Import ${n.toLocaleString()} rows`,
  back: "Back",
  cancel: "Cancel",
  close: "Close",
  importing: "Importing",
  progress: (c: number, n: number, rows: number) => `Chunk ${c} of ${n} · ${rows.toLocaleString()} rows`,
  stop: "Stop after this chunk",
  stopped: "Stopped — the rows sent so far are imported; re-run the file to finish (it is idempotent by plate).",
  failed: "The import stopped with an error",
  done: "Import complete",
  report: "Download error report (CSV)",
  invite: "Invite owners by SMS",
  inviteWho: "the owners in this import with a mobile number who aren't on the platform yet",
  count: {
    tankers_created: "Tankers created", tankers_updated: "Tankers updated", owners_created: "Registry owners created", owners_matched: "Registry owners matched",
    permits_created: "Approved permits created", applications_created: "Applications created", permits_existing: "Permits already on file",
    no_phone: "Rows without a usable number", warnings: "Rows with warnings", errors: "Rows rejected by the database",
  } as Record<string, string>,
};

type Step =
  | { k: "file"; error?: string; busy?: boolean }
  | { k: "map"; name: string; headers: string[]; data: string[][]; mapping: Mapping }
  | { k: "preview"; name: string; headers: string[]; data: string[][]; mapping: Mapping; v: Validated | null }
  | { k: "run"; name: string; total: number; done: number; chunk: number; chunks: number; stop: boolean }
  | { k: "done"; name: string; batch: string; status: "completed" | "cancelled" | "failed"; counts: Record<string, number>; error?: string; issues: Issue[] };

export function ImportRegister({ geo, onClose, onImported }: { geo: Geo; onClose: () => void; onImported: () => void }) {
  const { toast } = useStaff();
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
    if (ex.error) toast(`Couldn’t check existing plates: ${friendlyError(ex.error)}`, true);
    setStep({ k: "preview", name, headers, data, mapping, v });
  }

  async function pick(file: File) {
    if (/\.(xlsx|xls|xlsm|ods)$/i.test(file.name)) return setStep({ k: "file", error: T.xlsx });
    setStep({ k: "file", busy: true });
    const all = parseCsv(await file.text());
    const headers = all[0] ?? [];
    const data = all.slice(1);
    if (!data.length) return setStep({ k: "file", error: T.empty });
    const mapping = guessMapping(headers);
    if (isRegisterLayout(headers) && mappingComplete(mapping)) return preview(file.name, headers, data, mapping);
    setStep({ k: "map", name: file.name, headers, data, mapping });
  }

  async function run(s: Extract<Step, { k: "preview" }>) {
    const v = s.v!;
    const db = supabase();
    stopRef.current = false;
    const { data: b, error: be } = await db.rpc("staff_import_batch_start", { p_file_name: s.name, p_total: v.summary.total, p_summary: v.summary, p_source: "upload" });
    if (be || !b) return toast(friendlyError(be), true);
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
        else if (attempt === 3) error = friendlyError(e);
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
    if (fe) error = error ?? friendlyError(fe);
    const issues = ((fin as { errors?: Issue[] } | null)?.errors ?? clientOnlyIssues(v.issues)) as Issue[];
    setStep({ k: "done", name: s.name, batch, status, counts, error, issues });
    onImported();
  }

  return (
    <Modal title={T.title} wide onClose={() => (step.k === "run" ? undefined : onClose())}>
      {step.k === "file" && (
        <>
          <p><b>{T.step1}</b></p>
          <p className="mut" style={{ fontSize: 13 }}>{T.step1Note}</p>
          <input type="file" accept=".csv,text/csv" aria-label={T.step1} disabled={step.busy} onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
          {step.busy && <p className="mut">{T.reading}</p>}
          {step.error && <div className="banner badb" role="alert" style={{ marginTop: 12 }}>{step.error}</div>}
          <div className="btns" style={{ justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn" onClick={onClose}>{T.cancel}</button>
          </div>
        </>
      )}

      {step.k === "map" && (
        <>
          <p><b>{T.step2}</b> <small className="mut">{step.name} · {step.data.length.toLocaleString()} rows</small></p>
          <p className="mut" style={{ fontSize: 13 }}>{T.step2Note}</p>
          <div className="regmap">
            {FIELDS.map((f) => (
              <div className="fld" key={f} style={{ margin: 0 }}>
                <label htmlFor={`map-${f}`}>{IT.fields[f]}{REQUIRED.includes(f) ? " *" : ""}</label>
                <select id={`map-${f}`} className="in" value={step.mapping[f] ?? ""}
                  onChange={(e) => setStep({ ...step, mapping: { ...step.mapping, [f]: e.target.value === "" ? null : Number(e.target.value) } })}>
                  <option value="">{T.notInFile}</option>
                  {step.headers.map((h, i) => (
                    <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <div className="btns" style={{ justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn" onClick={() => setStep({ k: "file" })}>{T.back}</button>
            <button className="btn pri" disabled={!mappingComplete(step.mapping)} onClick={() => preview(step.name, step.headers, step.data, step.mapping)}>{T.step3}</button>
          </div>
        </>
      )}

      {step.k === "preview" && !step.v && <p className="mut">{T.checkDb}</p>}
      {step.k === "preview" && step.v && (() => {
        const s = step.v.summary;
        const list = step.v.issues.filter((x) => x.level === show);
        return (
          <>
            <p><b>{T.step3}</b> <small className="mut">{step.name}</small></p>
            <div className="okpis">
              <Kpi label={T.rows} value={s.total.toLocaleString()} sub={`${s.ok.toLocaleString()} ${T.ok}`} tone="ok" />
              <Kpi label={T.warnings} value={s.warnings.toLocaleString()} sub={T.warningsSub} tone={s.warnings ? "warn" : ""} />
              <Kpi label={T.errors} value={s.errors.toLocaleString()} sub={T.errorsSub} tone={s.errors ? "bad" : ""} />
              <Kpi label={T.existing} value={s.existing.toLocaleString()} sub={T.existingSub(s.existing_on_platform)} />
              <Kpi label={T.fresh} value={s.new_tankers.toLocaleString()} sub={T.freshSub} />
            </div>
            <ul className="plain regsum">
              <li>{T.permits(s.status.valid, s.status.in_progress, s.status.none)}</li>
              <li>{T.phones(s.with_phone, s.no_phone, s.owners_by_phone)}</li>
              <li>{s.inconsistent_governorates.length ? T.clusterBad(s.inconsistent_governorates.map((g) => geo.govName(g)).join(", ")) : T.clusterOk}</li>
              {s.duplicates > 0 && <li>{T.dupes(s.duplicates)}</li>}
            </ul>
            <div className="toolbar" style={{ padding: "8px 0" }}>
              <div className="chips">
                <button className={`chip ${show === "error" ? "on" : ""}`} onClick={() => setShow("error")}>{T.showErrors}<span className="tc">{step.v.issues.filter((x) => x.level === "error").length}</span></button>
                <button className={`chip ${show === "warning" ? "on" : ""}`} onClick={() => setShow("warning")}>{T.showWarnings}<span className="tc">{step.v.issues.filter((x) => x.level === "warning").length}</span></button>
              </div>
              <button className="btn sm" disabled={!step.v.issues.length} onClick={() => downloadCsv(`register-issues-${omanDateKey(new Date())}`, issuesTable(step.v!.issues))}>{T.downloadIssues}</button>
            </div>
            <div className="tblwrap" style={{ maxHeight: 260, overflowY: "auto" }}>
              <table>
                <thead><tr><th className="num">Row</th><th>Plate</th><th>Field</th><th>Issue</th></tr></thead>
                <tbody>
                  {list.length === 0 && <tr><td colSpan={4} className="empty">{T.noIssues}</td></tr>}
                  {list.slice(0, 200).map((x, i) => (
                    <tr key={`${x.row}-${x.field}-${i}`}>
                      <td className="num">{x.row}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{x.plate || "—"}</td>
                      <td>{IT.fields[x.field as keyof typeof IT.fields] ?? x.field}</td>
                      <td><St tone={x.level === "error" ? "bad" : "warn"}>{x.message}</St></td>
                    </tr>
                  ))}
                  {list.length > 200 && <tr><td colSpan={4} className="mut">{T.more(list.length - 200)}</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="btns" style={{ justifyContent: "flex-end", marginTop: 16 }}>
              <button className="btn" onClick={() => setStep({ k: "map", name: step.name, headers: step.headers, data: step.data, mapping: step.mapping })}>{T.back}</button>
              <button className="btn" onClick={onClose}>{T.cancel}</button>
              <button className="btn pri" disabled={!s.send} onClick={() => run(step)}>{T.start(s.send)}</button>
            </div>
          </>
        );
      })()}

      {step.k === "run" && (
        <>
          <p><b>{T.importing}</b> <small className="mut">{step.name}</small></p>
          <div className="regprog" role="progressbar" aria-valuemin={0} aria-valuemax={step.total} aria-valuenow={step.done}>
            <div style={{ width: `${step.total ? (step.done / step.total) * 100 : 0}%` }} />
          </div>
          <p className="mut" style={{ fontSize: 13 }}>{T.progress(step.chunk, step.chunks, step.done)}</p>
          <div className="btns" style={{ justifyContent: "flex-end" }}>
            <button className="btn" disabled={step.stop} onClick={() => { stopRef.current = true; setStep({ ...step, stop: true }); }}>{T.stop}</button>
          </div>
        </>
      )}

      {step.k === "done" && (
        <>
          <p><b>{step.status === "completed" ? T.done : step.status === "cancelled" ? T.stopped : T.failed}</b> <small className="mut">{step.name}</small></p>
          {step.error && <div className="banner badb" role="alert">{step.error}</div>}
          <div className="tblwrap">
            <table>
              <tbody>
                {Object.entries(T.count).map(([k, l]) => (
                  <tr key={k}><td>{l}</td><td className="num"><b>{(step.counts[k] ?? 0).toLocaleString()}</b></td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="btns" style={{ justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn" disabled={!step.issues.length} onClick={() => downloadCsv(`register-import-report-${omanDateKey(new Date())}`, issuesTable(step.issues))}>{T.report} ({step.issues.length.toLocaleString()})</button>
            <button className="btn" disabled={step.status === "failed"} onClick={() => setInvite(true)}>{T.invite}</button>
            <button className="btn pri" onClick={onClose}>{T.close}</button>
          </div>
          {invite && <InviteDialog who={T.inviteWho} batch={step.batch} onClose={() => setInvite(false)} />}
        </>
      )}
    </Modal>
  );
}
