"use client";

import { createContext, use, useCallback, useEffect, useRef, useState } from "react";
import { saveCsv, type CsvCell } from "@/lib/csv";
import { friendlyError } from "@/lib/errors";
import { muscatDayStart, muscatWeekStart } from "@/lib/sla";
import { supabase } from "@/lib/supabase/client";
import { useFocusTrap } from "@/lib/useFocusTrap";

// Shared building blocks for the Company portal (tanker owners) and the
// Business portal (B2B customers). Styles live in components/portal/portal.css.

// ---------------------------------------------------------------- formatting
const num = (v: number | string | null | undefined) => Number(v ?? 0) || 0;

/** "OMR 1,284.600" (OMR always has 3 decimals). */
export const omr = (v: number | string | null | undefined) =>
  `OMR ${num(v).toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`;
/** "1,284.600" for table cells. */
export const n3 = (v: number | string | null | undefined) => num(v).toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
export const gal = (v: number | null | undefined) => (v ?? 0).toLocaleString("en-US");

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
export const fmtShort = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—";
export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—");

const DAY = 86_400_000;
/** Whole days from now until a date (negative = in the past). */
export function daysUntil(iso: string, now = Date.now()) {
  const t = Date.parse(iso.length === 10 ? `${iso}T23:59:59` : iso);
  return Math.ceil((t - now) / DAY);
}

/** Start of the current week (Sunday 00:00 Muscat time), as the prototype counts weeks. */
export function weekStart(now = new Date()) {
  return muscatWeekStart(now);
}
/** The 1st of the current month, 00:00 Muscat time (UTC+4). */
export function monthStart(now = new Date()) {
  const m = new Date(now.getTime() + 4 * 3_600_000);
  return new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1) - 4 * 3_600_000);
}
/** Today's 00:00 in Muscat time. */
export function dayStart(now = new Date()) {
  return muscatDayStart(now);
}

/** Download rows as a CSV file (first row = header). */
export function downloadCsv(filename: string, rows: CsvCell[][]) {
  saveCsv(filename, rows);
}

// ---------------------------------------------------------------- toast
const ToastCtx = createContext<(m: string, bad?: boolean) => void>(() => undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const toast = useCallback((text: string, bad = false) => {
    setMsg({ text, bad });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 4000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <ToastCtx value={toast}>
      {children}
      {msg && (
        <div className={`toastn ${msg.bad ? "bad" : ""}`} role="status" aria-live="polite">
          {msg.text}
        </div>
      )}
    </ToastCtx>
  );
}

export const useToastn = () => use(ToastCtx);

// ---------------------------------------------------------------- UI pieces
export type Kpi = { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "ok" | "warn" | "bad" };

export function Kpis({ items }: { items: Kpi[] }) {
  return (
    <div className="okpis">
      {items.map((k) => (
        <div className="okpi" key={k.label}>
          <span>{k.label}</span>
          <b>{k.value}</b>
          {k.sub != null && <small className={k.tone ?? ""}>{k.sub}</small>}
        </div>
      ))}
    </div>
  );
}

/** Status pill using the portal's .st classes. */
export function St({ tone = "", children }: { tone?: "ok" | "warn" | "bad" | "act" | ""; children?: React.ReactNode }) {
  return <span className={`st ${tone}`}>{children}</span>;
}

/** Horizontal bars as inline SVG (no chart library). */
export function Bars({ rows, unit = "", empty = "No data yet." }: { rows: { label: string; value: number }[]; unit?: string; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <div className="empty">{empty}</div>;
  return (
    <div className="pbars">
      {rows.map((r) => (
        <div className="pbar" key={r.label}>
          <span className="pbar-l">{r.label}</span>
          <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
            <rect x="0" y="0" width="100" height="10" rx="2" className="trk" />
            <rect x="0" y="0" width={Math.max(0.5, (r.value / max) * 100)} height="10" rx="2" className="val" />
          </svg>
          <span className="pbar-v">
            {r.value.toLocaleString("en-US")}
            {unit}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Small vertical column chart (e.g. earnings per day). */
export function Columns({ rows, format = (v: number) => String(v) }: { rows: { label: string; value: number }[]; format?: (v: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const w = 100 / Math.max(1, rows.length);
  return (
    <div className="pcols">
      <svg viewBox="0 0 100 60" preserveAspectRatio="none" role="img" aria-label={rows.map((r) => `${r.label}: ${format(r.value)}`).join(", ")}>
        {rows.map((r, i) => {
          const h = (r.value / max) * 54;
          return <rect key={r.label + i} x={i * w + w * 0.18} y={60 - h} width={w * 0.64} height={Math.max(h, 0.6)} rx="1.2" className="val" />;
        })}
      </svg>
      <div className="pcols-l">
        {rows.map((r, i) => (
          <span key={r.label + i} style={{ width: `${w}%` }}>
            {r.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Dialog({ title, body, onClose, children, wide }: { title: string; body?: React.ReactNode; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const trap = useFocusTrap(onClose);
  return (
    <div ref={trap} className="dlg" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className={wide ? "wide" : ""} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {body && <p>{body}</p>}
        {children}
      </div>
    </div>
  );
}

/** Run an RPC-backed action with busy state, toast on success, friendly toast on error. */
export function useAction() {
  const toast = useToastn();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async (key: string, fn: () => PromiseLike<{ error: { message?: string } | null }>, ok?: string, onOk?: () => void) => {
      setBusy(key);
      const { error } = await fn();
      setBusy(null);
      if (error) {
        toast(friendlyError(error), true);
        return false;
      }
      if (ok) toast(ok);
      onOk?.();
      return true;
    },
    [toast],
  );
  return { busy, run };
}

/**
 * Load data on mount and whenever one of the listed tables changes (Supabase
 * Realtime, debounced), with a slow poll as a safety net. RLS still decides
 * which rows each change event carries.
 */
export function useLive(key: string, tables: string[], load: () => Promise<void> | void, pollMs = 60_000) {
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const tablesKey = tables.join(",");
  useEffect(() => {
    const db = supabase();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const first = setTimeout(() => loadRef.current(), 0);
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => loadRef.current(), 700);
    };
    let ch = db.channel(`${key}-${Math.random().toString(36).slice(2, 8)}`);
    for (const t of tablesKey.split(",").filter(Boolean)) ch = ch.on("postgres_changes", { event: "*", schema: "public", table: t }, soon);
    ch.subscribe();
    const poll = setInterval(() => loadRef.current(), pollMs);
    return () => {
      clearTimeout(first);
      clearTimeout(timer);
      clearInterval(poll);
      db.removeChannel(ch);
    };
  }, [key, tablesKey, pollMs]);
}
