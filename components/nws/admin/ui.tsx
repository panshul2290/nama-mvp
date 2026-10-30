"use client";

import { useState } from "react";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { saveCsv, type CsvCell } from "@/lib/csv";
import { friendlyError } from "@/lib/errors";
import { muscatDayStart } from "@/lib/sla";
import { omanDateKey, omanDay } from "@/lib/time";
import { useFocusTrap } from "@/lib/useFocusTrap";

// Shared bits for the Reports and Settings screens.

export const omr = (v: number | string | null | undefined, digits = 3) =>
  Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const int = (v: number) => Math.round(v).toLocaleString();
export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;

const DAY_MS = 86_400_000;

/** ISO timestamp `days` days ago (start of that Muscat day). */
export function sinceIso(days: number) {
  return new Date(muscatDayStart().getTime() - (days - 1) * DAY_MS).toISOString();
}

/** Muscat calendar day key, YYYY-MM-DD. */
export const dayKey = (iso: string | Date) => omanDateKey(iso);
export const dayLabel = (key: string) => omanDay(key);

/** Every day key from `days` days ago to today, for gap-free time series. */
export function dayKeys(days: number) {
  const noon = muscatDayStart().getTime() + DAY_MS / 2;
  return Array.from({ length: days }, (_, i) => dayKey(new Date(noon - (days - 1 - i) * DAY_MS)));
}

export function median(xs: number[]) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Group rows and fold them into an accumulator per key, sorted by `sort` (desc). */
export function groupBy<T, A>(rows: T[], key: (r: T) => string, init: () => A, add: (acc: A, r: T) => void) {
  const m = new Map<string, A>();
  for (const r of rows) {
    const k = key(r);
    let a = m.get(k);
    if (!a) m.set(k, (a = init()));
    add(a, r);
  }
  return m;
}

/** Download rows as a CSV file (client-side). */
export function downloadCsv(name: string, rows: CsvCell[][]) {
  saveCsv(`${name.replace(/[^\w-]+/g, "_")}_${dayKey(new Date())}.csv`, rows);
}

export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="vhead">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div className="btns">{children}</div>}
    </div>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className="okpi">
      <span>{label}</span>
      <b>{value}</b>
      {sub != null && <small className={tone}>{sub}</small>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="rtabs" role="tablist">
      {tabs.map(([id, label]) => (
        <button key={id} role="tab" aria-selected={value === id} className={value === id ? "on" : ""} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ on, onClick, disabled, label }: { on: boolean; onClick: () => void; disabled?: boolean; label: string }) {
  return <button type="button" className={`switch ${on ? "on" : ""}`} aria-pressed={on} aria-label={label} title={label} disabled={disabled} onClick={onClick} />;
}

export function Chips<T extends string>({ items, value, onChange }: { items: [T, string, number?][]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="chips">
      {items.map(([id, label, n]) => (
        <button key={id} className={`chip ${value === id ? "on" : ""}`} onClick={() => onChange(id)}>
          {label}
          {n != null && <span className="tc">{n}</span>}
        </button>
      ))}
    </div>
  );
}

export function Empty({ cols, children }: { cols: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={cols} className="empty">{children}</td>
    </tr>
  );
}

/** Banner shown to roles the database won't let change this screen. */
export function ReadOnlyNote({ who }: { who: string }) {
  return <div className="banner info">View only — changes here are made by {who}. The database enforces this for every action.</div>;
}

type RpcResult = PromiseLike<{ error: { message?: string } | null }>;
type Ask = {
  title: string;
  body?: string;
  confirm: string;
  danger?: boolean;
  extra?: React.ReactNode;
  /** Toast shown on success. */
  ok: string;
  run: (reason: string) => RpcResult;
  done?: () => void;
};

/** An audited write: ask for a reason, call the RPC, toast the outcome. */
export function useAudited() {
  const { toast } = useStaff();
  const [ask, setAsk] = useState<Ask | null>(null);
  const dialog = ask && (
    <ReasonDialog
      title={ask.title}
      body={ask.body}
      confirm={ask.confirm}
      danger={ask.danger}
      extra={ask.extra}
      onCancel={() => setAsk(null)}
      onConfirm={async (reason) => {
        const { error } = await ask.run(reason);
        if (error) return toast(friendlyError(error), true);
        toast(ask.ok);
        setAsk(null);
        ask.done?.();
      }}
    />
  );
  return { ask: setAsk, dialog };
}

/** Run an RPC without a reason prompt and toast the outcome; resolves true on success. */
export function useRun() {
  const { toast } = useStaff();
  return async (p: RpcResult, ok: string) => {
    const { error } = await p;
    if (error) {
      toast(friendlyError(error), true);
      return false;
    }
    toast(ok);
    return true;
  };
}

/** A plain confirmation for actions the database audits without a reason. */
export function ConfirmDialog({ title, body, confirm, onCancel, onConfirm }: { title: string; body: React.ReactNode; confirm: string; onCancel: () => void; onConfirm: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const trap = useFocusTrap(busy ? undefined : onCancel);
  return (
    <div ref={trap} className="dlg" role="dialog" aria-modal="true" aria-label={title} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="mut" style={{ fontSize: 13.5, marginBottom: 16 }}>{body}</div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn pri" disabled={busy} onClick={async () => { setBusy(true); await onConfirm(); setBusy(false); }}>
            {busy ? "Working…" : confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Fetch up to `cap` rows in pages of 1,000 (PostgREST's default max rows per request).
 * `page(from, to)` must apply `.range(from, to)` to an ordered query (newest first,
 * so a cut-off keeps the latest rows). `truncated` is true when more rows matched than `cap`.
 */
export async function fetchPaged<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message?: string } | null }>, cap = 5000) {
  const rows: T[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const to = Math.min(from + 1000, cap) - 1;
    const { data, error } = await page(from, to);
    if (error) return { rows, error, truncated: false };
    const got = (data ?? []) as T[];
    rows.push(...got);
    if (got.length < to - from + 1) return { rows, error: null, truncated: false };
  }
  // Full up to the cap: one more row tells whether anything was left out.
  const more = await page(cap, cap);
  return { rows, error: null, truncated: !more.error && ((more.data ?? []) as T[]).length > 0 };
}

/** "Showing the latest N …" for a capped list, or null when nothing was left out. */
export const cappedNote = (truncated: boolean, shown: number, what: string) =>
  truncated ? `Showing the latest ${shown.toLocaleString()} ${what} in this period — totals cover only these.` : null;
