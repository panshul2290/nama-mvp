"use client";

// Shared building blocks for the operations screens (Live operations, Orders, Fleet,
// Permits, Customers, Complaints): tabs, KPI tiles, dialogs, RPC runner, formatting.
// The formatters here are English (exports keep English); screens use useFmt()
// (components/portal/i18n) for the viewer's language and label() (lib/labels) for the
// Arabic of SERVICE_NAME, CHANNEL_LABEL and SEV_LABEL.
import { useCallback, useEffect, useRef, useState } from "react";
import { useStaff } from "@/components/nws/StaffContext";
import { saveCsv, saveTable, TABLE_FORMATS, type CsvCell, type TableFormat } from "@/lib/csv";
import { PORTAL } from "@/components/portal/dict";
import { fmtNumber } from "@/components/portal/i18n";
import { friendlyError } from "@/lib/errors";
import { useLang, type Lang } from "@/lib/i18n";
import { label } from "@/lib/labels";
import { AT_RISK_MINUTES, servedAt, slaDue } from "@/lib/sla";
import { supabase } from "@/lib/supabase/client";
import { omanTime } from "@/lib/time";
import type { OrderStatus } from "@/lib/types";
import { useFocusTrap } from "@/lib/useFocusTrap";

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** How long an unacknowledged driver SOS stays in the Live operations banner and the wall screen's SOS band. */
export const SOS_BANNER_MS = HOUR;

/** One-relation embeds come back as an object or a one-element array depending on the FK; normalise. */
export const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export const n3 = (v: number | string | null | undefined) => Number(v ?? 0).toFixed(3);
export const omr3 = (v: number | string | null | undefined) => `${n3(v)} OMR`;
export const pct = (num: number, den: number) => (den ? `${Math.round((num / den) * 1000) / 10}%` : "—");
export const hm = (iso: string | null | undefined) => omanTime(iso) || "—";

/** "4 min ago" from an ISO time and a ticking clock (keeps render pure). */
export function ago(iso: string | null | undefined, now: number) {
  if (!iso) return "—";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** A clock that ticks every `ms` so screens can show ages without calling Date.now() in render. */
export function useNow(ms = 10_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export const SERVICE_NAME = { DW: "Drinking water", WW: "Wastewater", TE: "Treated effluent" } as const;
export const CHANNEL_LABEL: Record<string, string> = { app: "App", call_centre: "Call centre", business: "Business", contract: "Contract" };
export const SEV_LABEL = { high: "High", med: "Medium", low: "Low" } as const;
export const SEV_TONE = { high: "bad", med: "warn", low: "act" } as const;

/** Order SLA (lib/sla): served by the slot end, or within 2 h of release/creation for ASAP orders. */
export function orderSla(
  o: { status: OrderStatus; service_type?: string; slot_end?: string | null; released_at?: string | null; created_at: string; collected_at?: string | null; delivered_at?: string | null },
  now: number,
  lang: Lang = "en",
): { text: string; tone: "ok" | "warn" | "bad" | "" } {
  if (o.status === "cancelled") return { text: "—", tone: "" };
  const due = slaDue(o);
  const served = servedAt({ ...o, service_type: o.service_type ?? "" });
  const onTime = { text: label("sla", "onTime", lang), tone: "ok" as const };
  const late = { text: label("sla", "late", lang), tone: "bad" as const };
  if (served || o.status === "delivered") {
    const at = served ? Date.parse(served) : due;
    return at <= due ? onTime : late;
  }
  if (now > due) return late;
  if (due - now < AT_RISK_MINUTES * 60_000) return { text: label("sla", "atRisk", lang), tone: "warn" };
  return onTime;
}

/** Run a staff RPC with a toast; resolves true on success. */
export function useRpc() {
  const { toast } = useStaff();
  const { lang } = useLang();
  return useCallback(
    async (name: string, args: Record<string, unknown>, ok?: string) => {
      const { error } = await supabase().rpc(name, args);
      if (error) {
        toast(friendlyError(error, lang), true);
        return false;
      }
      if (ok) toast(ok);
      return true;
    },
    [toast, lang],
  );
}

/**
 * Subscribe to realtime changes on some tables and call `onChange` at most once per `delay` ms
 * (a burst of GPS fixes reloads once, not once per fix). `filters` narrows a table to some rows,
 * e.g. { orders: "id=eq.<uuid>" }.
 */
export function useRealtime(name: string, tables: string[], onChange: () => void, delay = 600, filters?: Record<string, string>) {
  const cb = useRef(onChange);
  useEffect(() => {
    cb.current = onChange;
  });
  const key = tables.join(",");
  const fkey = filters ? JSON.stringify(filters) : "";
  useEffect(() => {
    const db = supabase();
    const f = fkey ? (JSON.parse(fkey) as Record<string, string>) : {};
    let t: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      if (t) return;
      t = setTimeout(() => {
        t = undefined;
        cb.current();
      }, delay);
    };
    let ch = db.channel(name);
    for (const table of key.split(",")) ch = ch.on("postgres_changes", { event: "*", schema: "public", table, ...(f[table] ? { filter: f[table] } : {}) }, soon);
    ch.subscribe();
    return () => {
      clearTimeout(t);
      db.removeChannel(ch);
    };
  }, [name, key, fkey, delay]);
}

/** Signed URL for a private file in the evidence bucket (null when missing). */
export function useSignedUrl(path: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!path) {
      Promise.resolve().then(() => live && setUrl(null));
      return;
    }
    supabase()
      .storage.from("evidence")
      .createSignedUrl(path, 600)
      .then(({ data }) => live && setUrl(data?.signedUrl ?? null));
    return () => {
      live = false;
    };
  }, [path]);
  return url;
}

/** Download rows as CSV (first row = headers). */
export function downloadCsv(name: string, rows: CsvCell[][]) {
  saveCsv(`${name}.csv`, rows);
}

/** Save rows in any of the export formats the design lists (CSV, XLS, XML, TXT, HTML, ASCII). */
export function downloadTable(name: string, rows: CsvCell[][], fmt: TableFormat) {
  saveTable(name, rows, fmt);
}

/** One button per export format, as in the prototype (Export CSV / XLS / XML / TXT / HTML / ASCII). */
export function ExportButtons({ onExport, disabled }: { onExport: (fmt: TableFormat) => void; disabled?: boolean }) {
  const { lang } = useLang();
  return (
    <div className="btns">
      {TABLE_FORMATS.map((f) => (
        <button key={f} className="btn sm" disabled={disabled} onClick={() => onExport(f)}>
          {PORTAL.exportFmt[lang].replace("{fmt}", f.toUpperCase())}
        </button>
      ))}
    </div>
  );
}

export function Tabs<K extends string>({ tabs, value, onChange }: { tabs: [K, string, number?][]; value: K; onChange: (k: K) => void }) {
  const { lang } = useLang();
  return (
    <div className="otabs" role="tablist">
      {tabs.map(([k, l, n]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>
          {l}
          {n != null && <span className="tc">{fmtNumber(n, lang)}</span>}
        </button>
      ))}
    </div>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "ok" | "warn" | "bad" | "" }) {
  return (
    <div className="okpi">
      <span>{label}</span>
      <b>{value}</b>
      {sub != null && <small className={tone ?? ""}>{sub}</small>}
    </div>
  );
}

export function St({ tone, children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`st ${tone ?? ""}`}>{children}</span>;
}

/** A modal shell (wider than ReasonDialog) for forms. */
export function Modal({ title, wide, onClose, children }: { title: string; wide?: boolean; onClose: () => void; children: React.ReactNode }) {
  const trap = useFocusTrap(onClose);
  return (
    <div ref={trap} className="dlg" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className={wide ? "wide" : ""} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** Small horizontal bar chart (inline, no dependencies). */
export function Bars({ rows, unit = "" }: { rows: [string, number][]; unit?: string }) {
  const { lang } = useLang();
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <div className="obars">
      {rows.map(([l, v]) => (
        <div key={l} className="obar">
          <span>{l}</span>
          <svg viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true">
            <rect x="0" y="0" width="100" height="12" rx="3" className="trk" />
            <rect x="0" y="0" width={(v / max) * 100} height="12" rx="3" className="fil" />
          </svg>
          <b>
            {fmtNumber(v, lang, { maximumFractionDigits: 3 })}
            {unit}
          </b>
        </div>
      ))}
    </div>
  );
}

/** Masked phone, e.g. +968 9••• ••12. */
export const maskPhone = (p: string | null | undefined) =>
  p ? [...p].map((c, i) => (i >= 6 && i < p.length - 2 && /\d/.test(c) ? "•" : c)).join("") : "—";
