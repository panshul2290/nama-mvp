"use client";

// English / Arabic for the customer and driver apps. Each app keeps its own
// dictionary ({ key: { en, ar } }) and calls useT(dict). The language is
// remembered on the device and saved to profiles.lang (used for notifications).
import { createContext, use, useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";

export type Lang = "en" | "ar";
export type Dict = Record<string, { en: string; ar: string }>;

const KEY = "nama.lang";
const Ctx = createContext<{ lang: Lang; dir: "ltr" | "rtl"; setLang: (l: Lang) => void }>({ lang: "en", dir: "ltr", setLang: () => {} });

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");
  // Read after mount (the server render is always English), as AppFrame's clock does.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const saved = localStorage.getItem(KEY);
        if (saved === "ar" || saved === "en") setLangState(saved);
      } catch {
        /* storage unavailable: stay in English */
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(KEY, l);
    } catch {
      /* ignore */
    }
    const db = supabase();
    db.auth.getUser().then(({ data }) => {
      if (data.user) db.from("profiles").update({ lang: l }).eq("id", data.user.id).then(() => {});
    });
  }, []);
  const value = useMemo(() => ({ lang, dir: (lang === "ar" ? "rtl" : "ltr") as "ltr" | "rtl", setLang }), [lang, setLang]);
  return <Ctx value={value}>{children}</Ctx>;
}

export const useLang = () => use(Ctx);

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
/** Western digits → Arabic-Indic digits when the language is Arabic. */
export const localDigits = (s: string | number, lang: Lang) => (lang === "ar" ? String(s).replace(/[0-9]/g, (d) => AR_DIGITS[Number(d)]) : String(s));

/** t(key, vars) for a dictionary; {name} placeholders are filled from vars. Falls back to English, then the key. */
export function useT(dict: Dict) {
  const { lang } = useLang();
  return useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const entry = dict[key];
      let s = entry ? entry[lang] || entry.en : key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
      return s;
    },
    [dict, lang],
  );
}

/** EN | ع toggle used in the prototype's app headers. */
export function LangToggle() {
  const { lang, setLang } = useLang();
  return (
    <button type="button" className="lang-tg" onClick={() => setLang(lang === "en" ? "ar" : "en")} aria-label={lang === "en" ? "التبديل إلى العربية" : "Switch to English"}>
      {lang === "en" ? "ع" : "EN"}
    </button>
  );
}
