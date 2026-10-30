"use client";

import { useEffect, useState } from "react";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";

// The Reports tabs ask the database for their figures (0029: report_operations,
// report_consumption, report_feedback): every order in range is counted there, so nothing
// is capped or summed in the browser. Test-zone orders are never included.

export function useReport<T>(rpc: string, days: number) {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null } | null>(null);
  const key = `${rpc}:${days}`;
  useEffect(() => {
    let live = true;
    supabase()
      .rpc(rpc, { p_days: days })
      .then(({ data, error }) => {
        if (live) setState({ key, data: (data as T | null) ?? null, error: error ? friendlyError(error) : null });
      });
    return () => {
      live = false;
    };
  }, [rpc, days, key]);
  // A stale answer for another range isn't shown while the new one loads.
  return state?.key === key ? state : { data: null, error: null };
}

export function ReportState({ error, what }: { error: string | null; what: string }) {
  if (error) return <div className="banner badb" role="alert">Couldn’t load the {what} report: {error}</div>;
  return <div className="panel"><div className="empty">Loading…</div></div>;
}
