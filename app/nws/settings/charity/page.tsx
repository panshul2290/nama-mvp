"use client";

// NWS → Settings → Charity sites (0045): the beneficiary sites customers can sponsor a tanker for
// (name, location, contact, verified), and the sponsored deliveries per month.
import { useCallback, useEffect, useState } from "react";
import { Empty, PageHead, ReadOnlyNote, useAudited } from "@/components/nws/admin/ui";
import { CONT } from "@/components/nws/i18n/continuity";
import { useStaff } from "@/components/nws/StaffContext";
import { Dialog } from "@/components/portal/kit";
import { useFmt } from "@/components/portal/i18n";
import { useWilayats } from "@/lib/address";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

type Site = {
  id: string; name: string; name_ar: string; kind: "mosque" | "family" | "community"; wilayat_code: string; lat: number; lng: number; address: string;
  landmark: string | null; contact_name: string | null; contact_phone: string | null; tank_gal: number | null; verified: boolean; active: boolean; notes: string | null;
};
type Month = { month: string; orders: number; delivered: number; gallons: number; total_omr: string; sites: number; sponsors: number };
const BLANK: Site = { id: "", name: "", name_ar: "", kind: "mosque", wilayat_code: "MUS-04", lat: 23.6, lng: 58.4, address: "", landmark: "", contact_name: "", contact_phone: "", tank_gal: null, verified: false, active: true, notes: "" };

export default function CharityPage() {
  const { can } = useStaff();
  const t = useT(CONT);
  const f = useFmt();
  const ref = useWilayats();
  const { ask, dialog } = useAudited();
  const [sites, setSites] = useState<Site[] | null>(null);
  const [months, setMonths] = useState<Month[]>([]);
  const [edit, setEdit] = useState<Site | null>(null);
  const editor = can("admin", "operator", "complaints_agent");
  const load = useCallback(() => {
    const db = supabase();
    db.from("beneficiary_sites").select("*").order("name").then(({ data }) => setSites((data ?? []) as Site[]));
    db.rpc("staff_sponsorship_report", { p_months: 12 }).then(({ data }) => setMonths((data ?? []) as Month[]));
  }, []);
  useEffect(load, [load]);
  const wname = (code: string) => {
    const w = ref?.wilayats.find((x) => x.code === code);
    return w ? (f.ar ? w.name_ar : w.name) : code;
  };

  return (
    <>
      <PageHead title={t("chTitle")} sub={t("chSub")}>
        <button className="btn pri" disabled={!editor} onClick={() => setEdit(BLANK)}>
          {t("chAdd")}
        </button>
      </PageHead>
      {!editor && <ReadOnlyNote who={t("whoAdminOps")} />}
      <div className="panel">
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("chName")}</th>
                <th>{t("chKind")}</th>
                <th>{t("chWilayat")}</th>
                <th>{t("chContact")}</th>
                <th>{t("chVerified")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sites?.length === 0 && <Empty cols={6}>{t("chNone")}</Empty>}
              {sites?.map((s) => (
                <tr key={s.id}>
                  <td>
                    <b>{f.ar ? s.name_ar : s.name}</b>
                    <small className="d-block mut">{s.address}</small>
                  </td>
                  <td>{t(`ck_${s.kind}`)}</td>
                  <td>{wname(s.wilayat_code)}</td>
                  <td>
                    {s.contact_name ?? "—"}
                    {s.contact_phone && (
                      <small className="d-block">
                        <bdi dir="ltr">{s.contact_phone}</bdi>
                      </small>
                    )}
                  </td>
                  <td>
                    {s.verified ? <span className="st ok">{t("chVerified")}</span> : <span className="st warn">{t("chUnverified")}</span>}{" "}
                    {!s.active && <span className="st">{t("wInactive")}</span>}
                  </td>
                  <td>
                    <button className="btn sm" disabled={!editor} onClick={() => setEdit(s)}>
                      {t("wEdit")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="panel">
        <h2>{t("chMonthly")}</h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("chMonth")}</th>
                <th>{t("chOrders")}</th>
                <th>{t("chDelivered")}</th>
                <th>{t("chGallons")}</th>
                <th>{t("chTotal")}</th>
                <th>{t("chSites")}</th>
                <th>{t("chSponsors")}</th>
              </tr>
            </thead>
            <tbody>
              {months.length === 0 && <Empty cols={7}>—</Empty>}
              {months.map((m) => (
                <tr key={m.month}>
                  <td>{f.fmt(`${String(m.month).slice(0, 10)}T12:00:00+04:00`, { month: "long", year: "numeric" })}</td>
                  <td>{f.n(m.orders)}</td>
                  <td>{f.n(m.delivered)}</td>
                  <td>{f.gal(m.gallons)}</td>
                  <td>{f.omr3(m.total_omr)}</td>
                  <td>{f.n(m.sites)}</td>
                  <td>{f.n(m.sponsors)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {edit && (
        <SiteDialog
          site={edit}
          onClose={() => setEdit(null)}
          onSave={(v) =>
            ask({
              title: t("chSaveQ"),
              confirm: t("chSave"),
              ok: t("chSaved"),
              run: (reason) => supabase().rpc("staff_save_beneficiary_site", { p_id: edit.id || null, p_s: v, p_reason: reason }),
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

function SiteDialog({ site, onClose, onSave }: { site: Site; onClose: () => void; onSave: (v: Site) => void }) {
  const t = useT(CONT);
  const f = useFmt();
  const ref = useWilayats();
  const [v, setV] = useState<Site>(site);
  const set = (p: Partial<Site>) => setV({ ...v, ...p });
  const text = (k: keyof Site, label: string, extra: { dir?: "ltr" | "rtl" } = {}) => (
    <div className="fld">
      <label htmlFor={`cs-${k}`}>{label}</label>
      <input id={`cs-${k}`} className="in" dir={extra.dir} value={String(v[k] ?? "")} onChange={(e) => set({ [k]: e.target.value } as Partial<Site>)} />
    </div>
  );
  return (
    <Dialog title={site.id ? t("wEdit") : t("chAdd")} onClose={onClose} wide>
      <div className="form">
        {text("name", t("chName"))}
        {text("name_ar", t("chNameAr"), { dir: "rtl" })}
        <div className="fld">
          <label htmlFor="cs-kind">{t("chKind")}</label>
          <select id="cs-kind" className="in" value={v.kind} onChange={(e) => set({ kind: e.target.value as Site["kind"] })}>
            {(["mosque", "family", "community"] as const).map((k) => (
              <option key={k} value={k}>
                {t(`ck_${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="cs-w">{t("chWilayat")}</label>
          <select id="cs-w" className="in" value={v.wilayat_code} onChange={(e) => set({ wilayat_code: e.target.value })}>
            {(ref?.governorates ?? []).map((g) => (
              <optgroup key={g.code} label={f.ar ? g.name_ar : g.name}>
                {(ref?.wilayats ?? [])
                  .filter((w) => w.governorate_code === g.code)
                  .map((w) => (
                    <option key={w.code} value={w.code}>
                      {f.ar ? w.name_ar : w.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="cs-lat">{t("chLat")}</label>
          <input id="cs-lat" className="in" dir="ltr" type="number" step="0.00001" value={v.lat} onChange={(e) => set({ lat: Number(e.target.value) })} />
        </div>
        <div className="fld">
          <label htmlFor="cs-lng">{t("chLng")}</label>
          <input id="cs-lng" className="in" dir="ltr" type="number" step="0.00001" value={v.lng} onChange={(e) => set({ lng: Number(e.target.value) })} />
        </div>
        {text("address", t("chAddress"))}
        {text("landmark", t("chLandmark"))}
        {text("contact_name", t("chContact"))}
        {text("contact_phone", t("chPhone"), { dir: "ltr" })}
        <div className="fld">
          <label className="small">
            <input type="checkbox" checked={v.verified} onChange={(e) => set({ verified: e.target.checked })} /> {t("chVerified")}
          </label>
        </div>
        <div className="fld">
          <label className="small">
            <input type="checkbox" checked={v.active} onChange={(e) => set({ active: e.target.checked })} /> {t("chActive")}
          </label>
        </div>
      </div>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          {t("cancel")}
        </button>
        <button className="btn pri" disabled={v.name.trim().length < 2 || v.name_ar.trim().length < 2} onClick={() => onSave(v)}>
          {t("chSave")}
        </button>
      </div>
    </Dialog>
  );
}
