"use client";

// NWS → Settings → Payments panels for 0035–0036: the seller's details and VAT number (on
// receipts and invoices), business invoices with "Export UBL XML" (and each buyer's VAT number),
// and the platform fees accrued by month and fee type.
import { useCallback, useEffect, useState } from "react";
import { Empty } from "@/components/nws/admin/ui";
import { MONEY } from "@/components/nws/i18n/money";
import { SETTINGS_OPS } from "@/components/nws/i18n/settingsOps";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { friendlyError } from "@/lib/errors";
import { useLang, useT, type Dict } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { exportInvoiceUbl } from "@/lib/ublExport";
import { ref } from "@/lib/types";

const D: Dict = { ...SETTINGS_OPS, ...MONEY };
type Seller = { name_en?: string; name_ar?: string; operator_en?: string; operator_ar?: string; address_en?: string; address_ar?: string; cr_no?: string; vat_number?: string };

export function SellerPanel({ editor }: { editor: boolean }) {
  const t = useT(D);
  const [seller, setSeller] = useState<Seller | null>(null);
  const [edit, setEdit] = useState(false);
  const load = useCallback(() => {
    supabase()
      .from("app_settings")
      .select("value")
      .eq("key", "SELLER")
      .maybeSingle<{ value: string }>()
      .then(({ data }) => {
        try {
          setSeller(data?.value ? (JSON.parse(data.value) as Seller) : {});
        } catch {
          setSeller({});
        }
      });
  }, []);
  useEffect(load, [load]);
  return (
    <div className="panel">
      <h2>
        {t("slTitle")} <small>{t("slSub")}</small>
      </h2>
      <dl className="kv">
        <dt>{t("slNameEn")}</dt>
        <dd lang="en">{seller?.name_en ?? "…"}</dd>
        <dt>{t("slNameAr")}</dt>
        <dd lang="ar" dir="rtl">
          {seller?.name_ar ?? "…"}
        </dd>
        <dt>{t("slVat")}</dt>
        <dd>{seller?.vat_number ? <bdi dir="ltr">{seller.vat_number}</bdi> : <span className="warn">{t("slVatMissing")}</span>}</dd>
        <dt>{t("slCr")}</dt>
        <dd>{seller?.cr_no ? <bdi dir="ltr">{seller.cr_no}</bdi> : "—"}</dd>
      </dl>
      <p className="note">{t("slVatNote")}</p>
      {editor && seller && (
        <div className="pad" style={{ paddingTop: 0 }}>
          <button className="btn" onClick={() => setEdit(true)}>
            {t("edit")}
          </button>
        </div>
      )}
      {edit && seller && (
        <EditSeller
          seller={seller}
          onClose={() => setEdit(false)}
          onDone={() => {
            setEdit(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function EditSeller({ seller, onClose, onDone }: { seller: Seller; onClose: () => void; onDone: () => void }) {
  const { toast } = useStaff();
  const { lang } = useLang();
  const t = useT(D);
  const [nameEn, setNameEn] = useState(seller.name_en ?? "");
  const [nameAr, setNameAr] = useState(seller.name_ar ?? "");
  const [vat, setVat] = useState(seller.vat_number ?? "");
  const [cr, setCr] = useState(seller.cr_no ?? "");
  return (
    <ReasonDialog
      title={t("slEditT")}
      confirm={t("save")}
      extra={
        <>
          <div className="row2">
            <div className="fld">
              <label htmlFor="sl-en">{t("slNameEn")}</label>
              <input id="sl-en" className="in" lang="en" dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="sl-ar">{t("slNameAr")}</label>
              <input id="sl-ar" className="in" lang="ar" dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
            </div>
          </div>
          <div className="row2">
            <div className="fld">
              <label htmlFor="sl-v">{t("slVat")}</label>
              <input id="sl-v" className="in" dir="ltr" maxLength={14} value={vat} onChange={(e) => setVat(e.target.value.toUpperCase())} placeholder="OM1100000000" />
              <small className="mut">{t("slVatHint")}</small>
            </div>
            <div className="fld">
              <label htmlFor="sl-cr">{t("slCr")}</label>
              <input id="sl-cr" className="in" dir="ltr" maxLength={30} value={cr} onChange={(e) => setCr(e.target.value)} />
            </div>
          </div>
        </>
      }
      onCancel={onClose}
      onConfirm={async (reason) => {
        const { error } = await supabase().rpc("staff_update_seller", { p_value: { name_en: nameEn, name_ar: nameAr, vat_number: vat, cr_no: cr }, p_reason: reason });
        if (error) return toast(friendlyError(error, lang), true);
        toast(t("slSaved"));
        onDone();
      }}
    />
  );
}

type InvRow = { id: string; invoice_no: number; org_id: string; issued_at: string; total: string; status: string; buyer_vatin: string | null; org: { name: string; vat_number: string | null } | null };

export function InvoicesUblPanel({ editor }: { editor: boolean }) {
  const t = useT(D);
  const f = useFmt();
  const { lang } = useLang();
  const { toast } = useStaff();
  const [rows, setRows] = useState<InvRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [vatFor, setVatFor] = useState<InvRow | null>(null);
  const load = useCallback(() => {
    supabase()
      .from("invoices")
      .select("id, invoice_no, org_id, issued_at, total, status, buyer_vatin, org:organizations(name, vat_number)")
      .order("issued_at", { ascending: false })
      .limit(50)
      .then(({ data }) => setRows((data ?? []) as unknown as InvRow[]));
  }, []);
  useEffect(load, [load]);
  async function exportOne(r: InvRow) {
    setBusy(r.id);
    const res = await exportInvoiceUbl(r.id);
    setBusy(null);
    if ("error" in res) return toast(friendlyError(res.error, lang), true);
    const what = res.problems.filter((p) => p !== "no_lines" && p !== "currency").map((p) => t(p === "seller_vatin" ? "ivNoSellerVat" : "ivNoBuyerVat"));
    toast(what.length ? t("ivMissing", { what: what.join(", ") }) : t("ivExported", { file: res.file }), what.length > 0);
  }
  return (
    <div className="panel">
      <h2>
        {t("ivTitle")} <small>{t("ivSub")}</small>
      </h2>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>{t("ivNo")}</th>
              <th>{t("ivOrg")}</th>
              <th>{t("ivIssued")}</th>
              <th>{t("ivVatin")}</th>
              <th className="num">{t("ivTotal")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows?.length === 0 && <Empty cols={6}>{t("ivNone")}</Empty>}
            {rows?.map((r) => {
              const vat = r.buyer_vatin ?? r.org?.vat_number ?? null;
              return (
                <tr key={r.id}>
                  <td>
                    <b dir="ltr">{ref.invoice(r.invoice_no)}</b>
                  </td>
                  <td>{r.org?.name ?? "—"}</td>
                  <td>{f.dateTime(r.issued_at)}</td>
                  <td>{vat ? <bdi dir="ltr">{vat}</bdi> : "—"}</td>
                  <td className="num">{f.n3(r.total)}</td>
                  <td className="num">
                    <span className="btns" style={{ justifyContent: "flex-end" }}>
                      {editor && (
                        <button className="btn sm" onClick={() => setVatFor(r)}>
                          {t("ivSetVat")}
                        </button>
                      )}
                      <button className="btn sm pri" disabled={busy === r.id} onClick={() => exportOne(r)}>
                        {busy === r.id ? t("working") : t("ivExport")}
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {vatFor && (
        <OrgVatDialog
          orgId={vatFor.org_id}
          name={vatFor.org?.name ?? ""}
          current={vatFor.org?.vat_number ?? ""}
          onClose={() => setVatFor(null)}
          onDone={() => {
            setVatFor(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function OrgVatDialog({ orgId, name, current, onClose, onDone }: { orgId: string; name: string; current: string; onClose: () => void; onDone: () => void }) {
  const { toast } = useStaff();
  const { lang } = useLang();
  const t = useT(D);
  const [vat, setVat] = useState(current);
  return (
    <ReasonDialog
      title={t("ivSetVatT", { org: name })}
      confirm={t("save")}
      extra={
        <div className="fld">
          <label htmlFor="ov-v">{t("slVat")}</label>
          <input id="ov-v" className="in" dir="ltr" maxLength={14} value={vat} onChange={(e) => setVat(e.target.value.toUpperCase())} placeholder="OM1100000000" />
          <small className="mut">{t("slVatHint")}</small>
        </div>
      }
      onCancel={onClose}
      onConfirm={async (reason) => {
        const { error } = await supabase().rpc("staff_set_org_vat_number", { p_org_id: orgId, p_vat_number: vat.trim() || null, p_reason: reason });
        if (error) return toast(friendlyError(error, lang), true);
        toast(t("ivVatSaved"));
        onDone();
      }}
    />
  );
}

type FeeReport = {
  rows: { month: string; fee_key: string; n: number; amount: string }[];
  total: string;
  by_company: { company_id: string | null; company: string; n: number; amount: string }[];
};

export function PlatformFeeReport({ editor }: { editor: boolean }) {
  const t = useT(D);
  const f = useFmt();
  const { lang } = useLang();
  const { toast } = useStaff();
  const [rep, setRep] = useState<FeeReport | null>(null);
  const load = useCallback(() => {
    supabase()
      .rpc("staff_platform_fee_report", { p_months: 12 })
      .then(({ data }) => setRep((data ?? null) as FeeReport | null));
  }, []);
  useEffect(load, [load]);
  const month = (m: string) => f.fmt(`${m}-01`, { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <div className="panel">
      <h2>
        {t("pfReport")} <small>{t("pfReportSub")}</small>
      </h2>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>{t("pfMonth")}</th>
              <th>{t("pfFee")}</th>
              <th className="num">{t("pfCount")}</th>
              <th className="num">{t("pfAmount")}</th>
            </tr>
          </thead>
          <tbody>
            {rep && rep.rows.length === 0 && <Empty cols={4}>{t("pfNoneYet")}</Empty>}
            {rep?.rows.map((r) => (
              <tr key={`${r.month}${r.fee_key}`}>
                <td>{month(r.month)}</td>
                <td>{t(`pf_${r.fee_key}`)}</td>
                <td className="num">{f.n(r.n)}</td>
                <td className="num">{f.n3(r.amount)}</td>
              </tr>
            ))}
            {rep && rep.rows.length > 0 && (
              <tr>
                <td colSpan={3}>
                  <b>{t("pfTotal")}</b>
                </td>
                <td className="num">
                  <b>{f.n3(rep.total)}</b>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rep && rep.by_company.length > 0 && (
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("pfByCompany")}</th>
                <th className="num">{t("pfCount")}</th>
                <th className="num">{t("pfAmount")}</th>
              </tr>
            </thead>
            <tbody>
              {rep.by_company.map((c) => (
                <tr key={c.company_id ?? "none"}>
                  <td>{c.company_id ? c.company : t("pfIndependent")}</td>
                  <td className="num">{f.n(c.n)}</td>
                  <td className="num">{f.n3(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editor && (
        <div className="pad">
          <button
            className="btn"
            onClick={async () => {
              const { data, error } = await supabase().rpc("accrue_platform_subscriptions");
              if (error) return toast(friendlyError(error, lang), true);
              toast(t("pfRanSubs", { n: f.n(Number(data ?? 0)) }));
              load();
            }}
          >
            {t("pfRunSubs")}
          </button>
        </div>
      )}
    </div>
  );
}
