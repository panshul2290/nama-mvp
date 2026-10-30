"use client";

// Language helpers for the web portals, on top of lib/i18n.tsx (the same LangProvider, useLang and
// useT as the customer and driver apps; the choice is remembered on the device as "nama.lang").
// useFmt() formats numbers, money and Muscat dates for the current language: Arabic shows Arabic
// month and day names and Arabic-Indic digits, as the apps do. Exports (CSV/XLS) keep the plain
// English formatters (kit.tsx, ops.tsx), so their headers and values stay English.
import { useMemo } from "react";
import { localDigits, useLang, type Lang } from "@/lib/i18n";
import { fmtOman, omanDate, omanDateTime, omanDay, omanLocale, omanStamp, omanTime } from "@/lib/time";
import { PORTAL } from "./dict";

export { PORTAL, withCommon } from "./dict";

type V = number | string | null | undefined;
type When = string | number | Date | null | undefined;
const num = (v: V) => Number(v ?? 0) || 0;

/** Plain number formatting for a language (grouping, fixed decimals). */
export function fmtNumber(v: V, lang: Lang, opts: Intl.NumberFormatOptions = {}) {
  return num(v).toLocaleString(lang === "ar" ? "ar-OM" : "en-US", opts);
}

/** Formatters bound to a language; useFmt() gives the current one. */
export function fmtFor(lang: Lang) {
  const ar = lang === "ar";
  const loc = omanLocale(lang);
  const n3 = (v: V) => fmtNumber(v, lang, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const dash = (s: string) => s || "—";
  return {
    lang,
    ar,
    /** Western → Arabic-Indic digits in Arabic (for numbers already formatted as text). */
    d: (s: string | number) => localDigits(s, lang),
    /** 1234.5 → "1,235" / "١٬٢٣٥". */
    n: (v: V, digits = 0) => fmtNumber(v, lang, { minimumFractionDigits: digits, maximumFractionDigits: digits }),
    /** Three decimals, e.g. a table cell in OMR. */
    n3,
    /** "OMR 1,284.600" / "١٬٢٨٤٫٦٠٠ ر.ع." */
    omr: (v: V) => (ar ? `${n3(v)} ر.ع.` : `OMR ${n3(v)}`),
    /** "12.345 OMR" / "١٢٫٣٤٥ ر.ع." (the NWS screens' style). */
    omr3: (v: V) => (ar ? `${n3(v)} ر.ع.` : `${n3(v)} OMR`),
    /** "12,000 gal" / "١٢٬٠٠٠ جالون". */
    gal: (v: V) => `${fmtNumber(v, lang)} ${ar ? "جالون" : "gal"}`,
    /** A percentage from a fraction (0.153 → "15.3%"). */
    pct: (fraction: number, digits = 1) => (ar ? `${fmtNumber(fraction * 100, lang, { minimumFractionDigits: digits, maximumFractionDigits: digits })}٪` : `${(fraction * 100).toFixed(digits)}%`),
    /** num/den as a percentage, "—" when den is 0. */
    ratio: (n: number, d: number) => (d ? (ar ? `${fmtNumber(Math.round((n / d) * 1000) / 10, lang, { maximumFractionDigits: 1 })}٪` : `${Math.round((n / d) * 1000) / 10}%`) : "—"),
    // Muscat dates and times (lib/time); "—" when empty.
    date: (v: When) => dash(omanDate(v, loc)),
    day: (v: When) => dash(omanDay(v, loc)),
    dateTime: (v: When) => dash(omanDateTime(v, loc)),
    time: (v: When) => dash(omanTime(v, loc)),
    stamp: (v: When) => dash(omanStamp(v, loc)),
    /** Any other date format, e.g. { weekday: "long", day: "numeric", month: "long" }. */
    fmt: (v: When, opts: Intl.DateTimeFormatOptions) => fmtOman(v, opts, loc),
    /** "4 min ago" / "قبل ٤ د" from an ISO time and a ticking clock. */
    ago: (iso: string | null | undefined, now: number) => {
      if (!iso) return "—";
      const s = Math.max(0, (now - Date.parse(iso)) / 1000);
      const [key, n] = s < 60 ? ["agoS", Math.floor(s)] : s < 3600 ? ["agoM", Math.floor(s / 60)] : s < 86400 ? ["agoH", Math.floor(s / 3600)] : ["agoD", Math.floor(s / 86400)];
      return PORTAL[key as string][lang].replace("{n}", localDigits(n as number, lang));
    },
  };
}

export type Fmt = ReturnType<typeof fmtFor>;

export function useFmt(): Fmt {
  const { lang } = useLang();
  return useMemo(() => fmtFor(lang), [lang]);
}

/** English | العربية switch for the portal top bar and the NWS sidebar. */
export function PortalLangToggle({ className = "" }: { className?: string }) {
  const { lang, setLang } = useLang();
  return (
    <div className={`plang ${className}`} role="group" aria-label={PORTAL.language[lang]}>
      <button type="button" lang="en" aria-pressed={lang === "en"} className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>
        English
      </button>
      <button type="button" lang="ar" aria-pressed={lang === "ar"} className={lang === "ar" ? "on" : ""} onClick={() => setLang("ar")}>
        العربية
      </button>
    </div>
  );
}
