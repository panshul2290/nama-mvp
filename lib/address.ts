"use client";

// Optional address details and delivery contact (0040): the form state, the jsonb sent to
// set_property_details / set_order_details, the display lines, and the wilayat list.
import { useEffect, useState } from "react";
import { normalizePhone } from "./phone";
import { supabase } from "./supabase/client";

export type AddressDetails = {
  wilayat_code?: string | null;
  village?: string | null;
  way_no?: string | null;
  house_no?: string | null;
  national_address_id?: string | null;
  landmark?: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  call_ahead?: boolean | null;
};

export type DetailsForm = {
  wilayat: string;
  village: string;
  way_no: string;
  house_no: string;
  national_address_id: string;
  landmark: string;
  contact_name: string;
  contact_phone: string;
  call_ahead: boolean;
};

export const EMPTY_DETAILS: DetailsForm = { wilayat: "", village: "", way_no: "", house_no: "", national_address_id: "", landmark: "", contact_name: "", contact_phone: "", call_ahead: false };

export const detailsFromRow = (r: AddressDetails | null | undefined): DetailsForm => ({
  wilayat: r?.wilayat_code ?? "",
  village: r?.village ?? "",
  way_no: r?.way_no ?? "",
  house_no: r?.house_no ?? "",
  national_address_id: r?.national_address_id ?? "",
  landmark: r?.landmark ?? "",
  contact_name: r?.contact_name ?? "",
  contact_phone: r?.contact_phone ?? "",
  call_ahead: Boolean(r?.call_ahead),
});

export const hasDetails = (f: DetailsForm) => f.call_ahead || Object.entries(f).some(([k, v]) => k !== "call_ahead" && String(v).trim() !== "");

/** The contact mobile is fine (empty, or a number normalize_phone accepts). */
export const contactPhoneOk = (f: DetailsForm) => !f.contact_phone.trim() || normalizePhone(f.contact_phone) !== null;

/** The jsonb for the RPCs (the server checks and tidies it again). */
export const detailsPayload = (f: DetailsForm) => ({
  ...f,
  contact_phone: f.contact_phone.trim() ? (normalizePhone(f.contact_phone) ?? f.contact_phone.trim()) : "",
});

export type Wilayat = { code: string; governorate_code: string; name: string; name_ar: string; sort: number };
export type Governorate = { code: string; name: string; name_ar: string; sort: number };

let cache: Promise<{ wilayats: Wilayat[]; governorates: Governorate[] }> | null = null;

/** Governorates and their wilayats (reference data, loaded once per page). */
export function useWilayats() {
  const [data, setData] = useState<{ wilayats: Wilayat[]; governorates: Governorate[] } | null>(null);
  useEffect(() => {
    if (!cache) {
      const db = supabase();
      cache = Promise.all([
        db.from("wilayats").select("code, governorate_code, name, name_ar, sort").order("sort"),
        db.from("governorates").select("code, name, name_ar, sort").order("sort"),
      ]).then(([w, g]) => {
        if (w.error || g.error) cache = null;
        return { wilayats: (w.data ?? []) as Wilayat[], governorates: (g.data ?? []) as Governorate[] };
      });
    }
    let live = true;
    cache.then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, []);
  return data;
}

/** Display parts of the details, in the given language (the contact is shown separately). */
export function detailParts(
  r: AddressDetails | null | undefined,
  lang: "en" | "ar",
  wilayats: Wilayat[] | undefined,
  t: (k: string, v?: Record<string, string | number>) => string,
): string[] {
  if (!r) return [];
  const w = r.wilayat_code ? wilayats?.find((x) => x.code === r.wilayat_code) : undefined;
  return [
    w ? (lang === "ar" ? w.name_ar : w.name) : (r.wilayat_code ?? null),
    r.village || null,
    r.way_no ? t("lWay", { n: r.way_no }) : null,
    r.house_no ? t("lHouse", { n: r.house_no }) : null,
    r.national_address_id ? t("lNaid", { n: r.national_address_id }) : null,
  ].filter((x): x is string => Boolean(x));
}

/** A map link for a point (shared on WhatsApp). */
export const mapLink = (lat: number, lng: number) => `https://maps.google.com/?q=${lat.toFixed(5)},${lng.toFixed(5)}`;
