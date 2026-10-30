"use client";

// "More address details" (0040): optional wilayat, village, Way and house numbers, National
// Address ID, landmark, and a delivery contact with "call me before arrival". Collapsed by default
// (open when something is already filled in). Used by the customer app and the business portal.
import { useId, useState } from "react";
import { ADDR } from "@/lib/addressI18n";
import { contactPhoneOk, hasDetails, useWilayats, type DetailsForm } from "@/lib/address";
import { useLang, useT } from "@/lib/i18n";

export function AddressDetailsForm({ value, onChange, portal = false, contact = true }: { value: DetailsForm; onChange: (v: DetailsForm) => void; portal?: boolean; contact?: boolean }) {
  const t = useT(ADDR);
  const { lang } = useLang();
  const ref = useWilayats();
  const id = useId();
  const [open, setOpen] = useState(() => hasDetails(value));
  const cur = ref?.wilayats.find((w) => w.code === value.wilayat);
  const [gov, setGov] = useState<string>(cur?.governorate_code ?? "");
  const govCode = gov || cur?.governorate_code || "";
  const set = (patch: Partial<DetailsForm>) => onChange({ ...value, ...patch });
  const cls = portal ? "in" : undefined;
  const name = (x: { name: string; name_ar: string }) => (lang === "ar" ? x.name_ar : x.name);
  const field = (k: keyof DetailsForm, label: string, max: number, extra: { ph?: string; ltr?: boolean; full?: boolean; inputMode?: "numeric" | "tel" } = {}) => (
    <div className={`fld ${extra.full ? "full" : ""}`}>
      <label htmlFor={`${id}${k}`}>{label}</label>
      <input
        id={`${id}${k}`}
        className={cls}
        maxLength={max}
        dir={extra.ltr ? "ltr" : undefined}
        inputMode={extra.inputMode}
        placeholder={extra.ph}
        value={String(value[k] ?? "")}
        onChange={(e) => set({ [k]: e.target.value } as Partial<DetailsForm>)}
      />
    </div>
  );

  return (
    <div className="addr-more">
      <button type="button" className="lk addr-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "−" : "+"} {t("more")}
      </button>
      {!open && <small className="mut addr-s">{t("moreS")}</small>}
      {open && (
        <div className={portal ? "form" : "addr-body"}>
          <div className="fld">
            <label htmlFor={`${id}gov`}>{t("governorate")}</label>
            <select
              id={`${id}gov`}
              className={cls}
              value={govCode}
              onChange={(e) => {
                setGov(e.target.value);
                if (cur && cur.governorate_code !== e.target.value) set({ wilayat: "" });
              }}
            >
              <option value="">{t("pick")}</option>
              {(ref?.governorates ?? []).map((g) => (
                <option key={g.code} value={g.code}>
                  {name(g)}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor={`${id}wil`}>{t("wilayat")}</label>
            <select id={`${id}wil`} className={cls} value={value.wilayat} disabled={!govCode} onChange={(e) => set({ wilayat: e.target.value })}>
              <option value="">{t("pick")}</option>
              {(ref?.wilayats ?? [])
                .filter((w) => w.governorate_code === govCode)
                .map((w) => (
                  <option key={w.code} value={w.code}>
                    {name(w)}
                  </option>
                ))}
            </select>
          </div>
          {field("village", t("village"), 80)}
          {field("way_no", t("way"), 20, { ltr: true })}
          {field("house_no", t("house"), 20, { ltr: true })}
          {field("national_address_id", t("naid"), 40, { ltr: true })}
          {field("landmark", t("landmark"), 300, { ph: t("landmarkPh"), full: true })}
          {contact && (
            <>
              <div className="fld full">
                <b className="addr-h">{t("contact")}</b>
                <small className="mut">{t("contactS")}</small>
              </div>
              {field("contact_name", t("contactName"), 80)}
              {field("contact_phone", t("contactPhone"), 20, { ltr: true, inputMode: "tel", ph: "9123 4567" })}
              {!contactPhoneOk(value) && <p className="badt small full">{t("badPhone")}</p>}
              <label className="addr-chk full">
                <input type="checkbox" checked={value.call_ahead} onChange={(e) => set({ call_ahead: e.target.checked })} />
                <span>
                  {t("callAhead")}
                  <small className="mut"> · {t("callAheadS")}</small>
                </span>
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
}
