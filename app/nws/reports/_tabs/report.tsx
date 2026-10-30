"use client";

import { useEffect, useState } from "react";
import { REPORTS } from "@/components/nws/i18n/reports";
import { friendlyError } from "@/lib/errors";
import { useLang, useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

// The Reports tabs ask the database for their figures (0029: report_operations,
// report_consumption, report_feedback): every order in range is counted there, so nothing
// is capped or summed in the browser. Test-zone orders are never included.

export function useReport<T>(rpc: string, days: number) {
  const { lang } = useLang();
  const [state, setState] = useState<{ key: string; data: T | null; error: { message?: string } | null } | null>(null);
  const key = `${rpc}:${days}`;
  useEffect(() => {
    let live = true;
    supabase()
      .rpc(rpc, { p_days: days })
      .then(({ data, error }) => {
        if (live) setState({ key, data: (data as T | null) ?? null, error: error ?? null });
      });
    return () => {
      live = false;
    };
  }, [rpc, days, key]);
  // A stale answer for another range isn't shown while the new one loads. The error is
  // worded in the current language at render time.
  return state?.key === key ? { data: state.data, error: state.error ? friendlyError(state.error, lang) : null } : { data: null, error: null };
}

export function ReportState({ error, what }: { error: string | null; what: string }) {
  const t = useT(REPORTS);
  if (error) return <div className="banner badb" role="alert">{t("loadFail", { what, error })}</div>;
  return <div className="panel"><div className="empty">{t("loading")}</div></div>;
}
