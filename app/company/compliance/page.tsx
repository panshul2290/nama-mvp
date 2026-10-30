"use client";

import { useEffect, useState } from "react";
import { DOC_KINDS, currentDoc, docLabel, rejectedDoc, useCompany, useFleet } from "@/components/company/CompanyContext";
import { CO } from "@/components/company/i18n";
import { useFmt, type Fmt } from "@/components/portal/i18n";
import { Dialog, St, daysUntil, useAction } from "@/components/portal/kit";
import { useLang, useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { omanToday } from "@/lib/time";
import type { TankerDocument } from "@/lib/types";

type Target = { kind: string; tankerId?: string; driverId?: string; label: string };

function cell(doc: TankerDocument | null, rejected: TankerDocument | null, t: (k: string) => string, f: Fmt): [string, "ok" | "warn" | "bad" | "act" | ""] {
  // The newest upload was rejected: the owner must upload again, whatever older document is on file.
  if (rejected) return [t("rejReupload"), "bad"];
  if (!doc) return [t("missing"), "bad"];
  const n = daysUntil(doc.valid_to);
  if (n < 0) return [t("expired"), "bad"];
  if (doc.status === "pending_review") return [t("inReview"), "act"];
  if (n <= 30) return [f.day(doc.valid_to), "warn"];
  return [t("valid"), "ok"];
}

export default function CompanyCompliance() {
  const fleet = useFleet("compliance", ["water_tests"]);
  const [target, setTarget] = useState<Target | null>(null);
  const [tests, setTests] = useState<Record<string, { cert_no: string; tested_at: string; passed: boolean }>>({});
  const t = useT(CO);
  const f = useFmt();
  const { lang } = useLang();

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
          {t("docsTitle")} <small>{t("docsSub")}</small>
        </h2>
        <div className="tblwrap">
          <table className="matrix">
            <thead>
              <tr>
                <th>{t("tanker")}</th>
                {DOC_KINDS.map((d) => (
                  <th key={d.kind}>{docLabel(d.kind, lang)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fleet.tankers.map((tk) => (
                <tr key={tk.id}>
                  <td className="tk-plate">{tk.plate}</td>
                  {DOC_KINDS.map((d) => {
                    if (d.kind === "water_test" && tk.service_type !== "DW")
                      return (
                        <td key={d.kind}>
                          <St>{t("na")}</St>
                        </td>
                      );
                    const doc = currentDoc(fleet.docs, d.kind, { tanker: tk.id });
                    const rej = rejectedDoc(fleet.docs, d.kind, { tanker: tk.id });
                    const [s, tone] = cell(doc, rej, t, f);
                    const lab = d.kind === "water_test" ? tests[tk.id] : undefined;
                    const name = docLabel(d.kind, lang);
                    return (
                      <td key={d.kind}>
                        <button
                          className="cellbtn"
                          title={
                            rej
                              ? rej.review_note
                                ? t("rejTitleN", { note: rej.review_note })
                                : t("rejTitle")
                              : doc
                                ? t("docTitle", { ref: doc.ref_no || t("noRef"), date: f.date(doc.valid_to) })
                                : t("uploadX", { doc: name })
                          }
                          onClick={() => setTarget({ kind: d.kind, tankerId: tk.id, label: `${name} · ${tk.plate}` })}
                        >
                          <St tone={tone}>{s}</St>
                        </button>
                        {rej?.review_note && <small className="docmeta" style={{ color: "var(--bad)" }}>{rej.review_note}</small>}
                        {lab && <small className="docmeta">{t(lab.passed ? "labPass" : "labFail", { date: f.day(lab.tested_at) })}</small>}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {fleet.loaded && !fleet.tankers.length && (
                <tr>
                  <td colSpan={DOC_KINDS.length + 1} className="empty">
                    {t("registerTankerFirst")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="note">{t("compNote")}</p>
      </div>

      <div className="panel">
        <h2>{t("licTitle")}</h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("driver")}</th>
                <th>{t("licNo")}</th>
                <th>{t("validTo")}</th>
                <th>{t("status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {fleet.drivers.map((d) => {
                const doc = currentDoc(fleet.docs, "heavy_licence", { driver: d.id });
                const rej = rejectedDoc(fleet.docs, "heavy_licence", { driver: d.id });
                const [s, tone] = cell(doc, rej, t, f);
                return (
                  <tr key={d.id}>
                    <td>{d.full_name}</td>
                    <td>{doc?.ref_no ? <bdi dir="ltr">{doc.ref_no}</bdi> : <span className="mut">—</span>}</td>
                    <td>{f.date(doc?.valid_to)}</td>
                    <td>
                      <St tone={tone}>{tone === "warn" ? t("expiresD", { date: s }) : s}</St>
                    </td>
                    <td className="num">
                      <button className="btn sm" onClick={() => setTarget({ kind: "heavy_licence", driverId: d.id, label: `${docLabel("heavy_licence", lang)} · ${d.full_name}` })}>
                        {t("upload")}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {fleet.loaded && !fleet.drivers.length && (
                <tr>
                  <td colSpan={5} className="empty">
                    {t("noDriversYet")}
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
  const t = useT(CO);

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
            setError(t("uploadFailed", { msg: up.error.message }));
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
      t("docUploaded"),
      () => {
        onDone();
        onClose();
      },
    );
  }

  return (
    <Dialog title={t("uploadX", { doc: target.label })} body={t("uploadBody")} onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="banner badb">{error}</div>}
        <div className="fld">
          <label htmlFor="dcR">{t("refNo")}</label>
          <input id="dcR" className="in" dir="ltr" maxLength={60} value={refNo} onChange={(e) => setRefNo(e.target.value)} autoFocus />
        </div>
        <div className="fld">
          <label htmlFor="dcV">{t("validTo")}</label>
          <input id="dcV" className="in" type="date" min={today} required value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        </div>
        <div className="fld">
          <label htmlFor="dcF">{t("scan")}</label>
          <input id="dcF" className="in" type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn pri" disabled={busy === "up"}>
            {busy === "up" ? t("uploading") : t("upload")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
