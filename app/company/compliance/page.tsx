"use client";

import { useEffect, useState } from "react";
import { DOC_KINDS, DOC_LABEL, currentDoc, rejectedDoc, useCompany, useFleet } from "@/components/company/CompanyContext";
import { Dialog, St, daysUntil, fmtDate, fmtShort, useAction } from "@/components/portal/kit";
import { supabase } from "@/lib/supabase/client";
import { omanToday } from "@/lib/time";
import type { TankerDocument } from "@/lib/types";

type Target = { kind: string; tankerId?: string; driverId?: string; label: string };

function cell(doc: TankerDocument | null, rejected: TankerDocument | null = null): [string, "ok" | "warn" | "bad" | "act" | ""] {
  // The newest upload was rejected: the owner must upload again, whatever older document is on file.
  if (rejected) return ["Rejected — re-upload", "bad"];
  if (!doc) return ["Missing", "bad"];
  const n = daysUntil(doc.valid_to);
  if (n < 0) return ["Expired", "bad"];
  if (doc.status === "pending_review") return ["In review", "act"];
  if (n <= 30) return [fmtShort(doc.valid_to), "warn"];
  return ["Valid", "ok"];
}

export default function CompanyCompliance() {
  const fleet = useFleet("compliance", ["water_tests"]);
  const [target, setTarget] = useState<Target | null>(null);
  const [tests, setTests] = useState<Record<string, { cert_no: string; tested_at: string; passed: boolean }>>({});

  // Latest lab certificate per tanker (water_tests from the LIMS — simulated).
  useEffect(() => {
    let cancelled = false;
    supabase()
      .from("water_tests")
      .select("tanker_id, cert_no, tested_at, passed")
      .order("tested_at", { ascending: false })
      .then(({ data }) => {
        if (cancelled) return;
        const m: typeof tests = {};
        for (const r of data ?? []) m[r.tanker_id] ??= r;
        setTests(m);
      });
    return () => {
      cancelled = true;
    };
  }, [fleet.tankers.length]);

  return (
    <>
      <div className="panel">
        <h2>
          Documents and standard checks <small>Select a cell to upload a new document</small>
        </h2>
        <div className="tblwrap">
          <table className="matrix">
            <thead>
              <tr>
                <th>Tanker</th>
                {DOC_KINDS.map((d) => (
                  <th key={d.kind}>{d.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fleet.tankers.map((t) => (
                <tr key={t.id}>
                  <td className="tk-plate">{t.plate}</td>
                  {DOC_KINDS.map((d) => {
                    if (d.kind === "water_test" && t.service_type !== "DW")
                      return (
                        <td key={d.kind}>
                          <St>n/a</St>
                        </td>
                      );
                    const doc = currentDoc(fleet.docs, d.kind, { tanker: t.id });
                    const rej = rejectedDoc(fleet.docs, d.kind, { tanker: t.id });
                    const [s, tone] = cell(doc, rej);
                    const lab = d.kind === "water_test" ? tests[t.id] : undefined;
                    return (
                      <td key={d.kind}>
                        <button
                          className="cellbtn"
                          title={rej ? `Rejected by NWS${rej.review_note ? `: ${rej.review_note}` : ""}. Upload a corrected document.` : doc ? `${doc.ref_no || "No reference"} · valid to ${fmtDate(doc.valid_to)}` : `Upload ${d.label}`}
                          onClick={() => setTarget({ kind: d.kind, tankerId: t.id, label: `${d.label} · ${t.plate}` })}
                        >
                          <St tone={tone}>{s}</St>
                        </button>
                        {rej?.review_note && <small className="docmeta" style={{ color: "var(--bad)" }}>{rej.review_note}</small>}
                        {lab && <small className="docmeta">Lab {lab.passed ? "pass" : "FAIL"} · {fmtShort(lab.tested_at)}</small>}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {fleet.loaded && !fleet.tankers.length && (
                <tr>
                  <td colSpan={DOC_KINDS.length + 1} className="empty">
                    Register a tanker first.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="note">Documents are checked by NWS when uploaded. You get alerts 30, 14 and 3 days before any document expires. The water test applies to drinking-water tankers only.</p>
      </div>

      <div className="panel">
        <h2>Driver heavy vehicle licences</h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Driver</th>
                <th>Licence number</th>
                <th>Valid to</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {fleet.drivers.map((d) => {
                const doc = currentDoc(fleet.docs, "heavy_licence", { driver: d.id });
                const rej = rejectedDoc(fleet.docs, "heavy_licence", { driver: d.id });
                const [s, tone] = cell(doc, rej);
                return (
                  <tr key={d.id}>
                    <td>{d.full_name}</td>
                    <td>{doc?.ref_no || <span className="mut">—</span>}</td>
                    <td>{fmtDate(doc?.valid_to)}</td>
                    <td>
                      <St tone={tone}>{s === "Valid" || tone === "warn" ? (tone === "warn" ? `Expires ${s}` : "Valid") : s}</St>
                    </td>
                    <td className="num">
                      <button className="btn sm" onClick={() => setTarget({ kind: "heavy_licence", driverId: d.id, label: `${DOC_LABEL.heavy_licence} · ${d.full_name}` })}>
                        Upload
                      </button>
                    </td>
                  </tr>
                );
              })}
              {fleet.loaded && !fleet.drivers.length && (
                <tr>
                  <td colSpan={5} className="empty">
                    No drivers yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {target && <UploadDoc target={target} onClose={() => setTarget(null)} onDone={fleet.reload} />}
    </>
  );
}

function UploadDoc({ target, onClose, onDone }: { target: Target; onClose: () => void; onDone: () => void }) {
  const { profile } = useCompany();
  const { busy, run } = useAction();
  const [refNo, setRefNo] = useState("");
  const [validTo, setValidTo] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = omanToday();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    await run(
      "up",
      async () => {
        let path: string | null = null;
        if (file) {
          // Evidence bucket: each user uploads into a folder named after their user id.
          path = `${profile.id}/${crypto.randomUUID()}`;
          const up = await supabase().storage.from("evidence").upload(path, file, { contentType: file.type || "application/octet-stream" });
          if (up.error) {
            setError(`Upload failed: ${up.error.message}`);
            return { error: { message: up.error.message } };
          }
        }
        return supabase().rpc("add_document", {
          p_kind: target.kind,
          p_ref_no: refNo.trim(),
          p_valid_to: validTo,
          p_file_path: path,
          p_tanker_id: target.tankerId ?? null,
          p_driver_id: target.driverId ?? null,
        });
      },
      "Document uploaded — NWS will review it",
      () => {
        onDone();
        onClose();
      },
    );
  }

  return (
    <Dialog title={`Upload ${target.label}`} body="The new document replaces the current one once NWS has reviewed it." onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="banner badb">{error}</div>}
        <div className="fld">
          <label htmlFor="dcR">Reference / certificate number</label>
          <input id="dcR" className="in" maxLength={60} value={refNo} onChange={(e) => setRefNo(e.target.value)} autoFocus />
        </div>
        <div className="fld">
          <label htmlFor="dcV">Valid to</label>
          <input id="dcV" className="in" type="date" min={today} required value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        </div>
        <div className="fld">
          <label htmlFor="dcF">Scan or photo (PDF or image)</label>
          <input id="dcF" className="in" type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" disabled={busy === "up"}>
            {busy === "up" ? "Uploading…" : "Upload"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
