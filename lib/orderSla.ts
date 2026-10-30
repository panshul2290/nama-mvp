// Per-order on-time status for households (E17). The database's my_order_sla(order) is used
// when it exists; until then (or for an answer we can't read) lib/sla.ts gives the same rule.
import { isOnTime, servedAt, slaDue, type SlaOrder } from "./sla";

export type OrderSla = { onTime: boolean | null; dueAt: number; servedAt: number | null; source: "db" | "app" };

const pickBool = (o: Record<string, unknown>, keys: string[]): boolean | null | undefined => {
  for (const k of keys) if (k in o) return o[k] === null ? null : typeof o[k] === "boolean" ? (o[k] as boolean) : undefined;
  return undefined;
};
const pickTime = (o: Record<string, unknown>, keys: string[]): number | null | undefined => {
  for (const k of keys) {
    if (!(k in o)) continue;
    if (o[k] == null) return null;
    const t = Date.parse(String(o[k]));
    if (Number.isFinite(t)) return t;
  }
  return undefined;
};

/** The app's own reading of the shared rule. */
export function appSla(o: SlaOrder): OrderSla {
  const at = servedAt(o);
  return { onTime: isOnTime(o), dueAt: slaDue(o), servedAt: at ? Date.parse(at) : null, source: "app" };
}

/**
 * Read what my_order_sla() returned: a boolean, a row, or a one-row array, with the on-time flag
 * under on_time / is_on_time / met and optional due / served times. Anything unreadable → the app rule.
 */
export function readSla(raw: unknown, o: SlaOrder): OrderSla {
  const fallback = appSla(o);
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (typeof row === "boolean") return { ...fallback, onTime: row, source: "db" };
  if (!row || typeof row !== "object") return fallback;
  const r = row as Record<string, unknown>;
  const onTime = pickBool(r, ["on_time", "is_on_time", "met", "sla_met"]);
  if (onTime === undefined) return fallback;
  return {
    onTime,
    dueAt: pickTime(r, ["due_at", "deadline", "sla_due", "due"]) ?? fallback.dueAt,
    servedAt: pickTime(r, ["served_at", "done_at", "delivered_at"]) ?? fallback.servedAt,
    source: "db",
  };
}

export type SlaSummary = { served: number; onTime: number; late: number; pct: number | null };

/** On-time share over the orders that were served (open and cancelled orders don't count). */
export function slaSummary(rows: OrderSla[]): SlaSummary {
  const done = rows.filter((r) => r.onTime !== null);
  const onTime = done.filter((r) => r.onTime).length;
  return { served: done.length, onTime, late: done.length - onTime, pct: done.length ? Math.round((onTime / done.length) * 100) : null };
}
