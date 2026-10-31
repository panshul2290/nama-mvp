"use client";

import { createContext, use, useCallback, useEffect, useState } from "react";
import type { PortalProfile } from "@/components/portal/PortalShell";
import { useLive } from "@/components/portal/kit";
import { permitSummary, type Permit } from "@/components/nws/fleetData";
import { CO } from "@/components/company/i18n";
import { fmtFor, useFmt } from "@/components/portal/i18n";
import { useT, type Lang } from "@/lib/i18n";
import { PERMIT_STAGE } from "@/lib/labels";
import { withPhones } from "@/lib/phones";
import { supabase } from "@/lib/supabase/client";
import type { ServiceType } from "@/lib/pricing";
import type { Alert, Contract, Device, TankerDocument } from "@/lib/types";

/** public.owner_company(): the company row plus ledger balances. */
export type OwnerCompany = {
  id: string; name: string; cr_no: string; phone: string | null; email: string | null; bank_name: string | null; iban: string | null;
  rating: number | string; since: string; status: "pending" | "active" | "suspended"; created_at: string;
  earnings_balance: number | string; fill_credit: number | string;
};

/**
 * A load problem shown above the page: a failed query, or a list cut off at its cap. `key` and `vars`
 * are a CO dictionary entry, translated when shown; `text` identifies the issue (dedupe, no-op updates).
 */
type Issue = { tone: "bad" | "info"; key: string; vars: Record<string, string | number>; text: string };
const issueOf = (tone: Issue["tone"], key: string, vars: Record<string, string | number>): Issue => ({ tone, key, vars, text: JSON.stringify([key, vars]) });
type Report = (key: string, issue: Issue | null) => void;

const Ctx = createContext<{ profile: PortalProfile; company: OwnerCompany; reloadCompany: () => Promise<void>; issues: Issue[]; report: Report } | null>(null);

export function CompanyProvider({ profile, company, reloadCompany, children }: { profile: PortalProfile; company: OwnerCompany; reloadCompany: () => Promise<void>; children: React.ReactNode }) {
  const [byKey, setByKey] = useState<Record<string, Issue>>({});
  const report = useCallback<Report>((key, issue) => {
    setByKey((prev) => {
      if (issue ? prev[key]?.text === issue.text && prev[key]?.tone === issue.tone : !(key in prev)) return prev;
      const next = { ...prev };
      if (issue) next[key] = issue;
      else delete next[key];
      return next;
    });
  }, []);
  // The same message from two hooks on one page is shown once.
  const issues = [...new Map(Object.values(byKey).map((i) => [i.text, i])).values()];
  return <Ctx value={{ profile, company, reloadCompany, issues, report }}>{children}</Ctx>;
}

export function useCompany() {
  const v = use(Ctx);
  if (!v) throw new Error("useCompany must be used inside the company portal");
  return v;
}

/** Banners for failed or truncated company queries; rendered once by the layout. */
export function CompanyIssues() {
  const { issues } = useCompany();
  const t = useT(CO);
  const f = useFmt();
  return issues.map((i) => {
    const v = i.vars;
    const vars = { ...v, what: t(String(v.what)), ...(typeof v.shown === "number" ? { shown: f.n(v.shown), total: f.n(v.total), days: f.n(v.days) } : {}) };
    return (
      <div key={i.text} className={`banner ${i.tone === "bad" ? "badb" : "info"}`} role={i.tone === "bad" ? "alert" : "status"}>
        {t(i.key, vars)}
      </div>
    );
  });
}

/** Report this hook's issues under `key`, and clear them when the page goes away. */
function useIssue(key: string) {
  const { report } = useCompany();
  useEffect(() => () => report(key, null), [key, report]);
  return useCallback((issue: Issue | null) => report(key, issue), [key, report]);
}

// `what` is a CO key (wFleet, wJobs, …).
const loadFailed = (what: string, message: string): Issue => issueOf("bad", "loadFailed", { what, msg: message });

// ---------------------------------------------------------------- fleet data
export type FTanker = {
  id: string; plate: string; service_type: ServiceType; capacity_gal: number; is_online: boolean; blocked: boolean; blocked_reason: string | null;
  last_lat: number | null; last_lng: number | null; last_seen_at: string | null; location_age_s: number | null; created_at: string;
  op_card_expiry?: string | null; insurance_expiry?: string | null; vehicle_status?: string;
  /** 0048: a register tanker claimed without a matching owner mobile waits for NWS ("pending"). */
  adoption_state?: "pending" | "approved" | "rejected" | null;
};
export type FDriver = { id: string; full_name: string; phone: string | null; role: string; created_at: string };
export type FAssignment = { id: string; tanker_id: string; driver_id: string; assigned_at: string; unassigned_at: string | null };
export type FPermit = Permit & {
  tanker_id: string; stage: "submitted" | "documents" | "inspection" | "decision"; info_requested: string | null; reason: string | null; created_at: string;
  info_response: string | null; info_responded_at: string | null;
};
/** A contract with who it is for (RLS: owners read the customer, organisation and site of their own contracts). */
export type FContract = Contract & {
  customer: { full_name: string } | null; org: { name: string } | null; property: { label: string; area: string } | null;
};
export const contractCustomer = (c: FContract, lang: Lang = "en") => c.org?.name ?? (c.customer?.full_name || CO[c.org_id ? "bizAccount" : "household"][lang]);
export const contractSite = (c: FContract) => (c.property ? [c.property.label, c.property.area].filter(Boolean).join(" · ") : "");
export type FOrder = {
  id: string; order_no: number; status: string; service_type: ServiceType; gallons: number; area: string; tanker_id: string | null; driver_id: string | null;
  driver_name: string | null; tanker_plate: string | null; created_at: string; released_at: string | null; accepted_at: string | null;
  collected_at: string | null; delivered_at: string | null;
  slot_start: string | null; slot_end: string | null; slot_label: string | null; rating: number | null; tip: string; driver_earnings: string;
  contract_id: string | null; org_id: string | null; channel: string;
};

export type Fleet = {
  tankers: FTanker[];
  drivers: FDriver[];
  assignments: FAssignment[];
  permits: FPermit[];
  devices: Device[];
  docs: TankerDocument[];
  alerts: Alert[];
  contracts: FContract[];
  loaded: boolean;
};

const EMPTY: Fleet = { tankers: [], drivers: [], assignments: [], permits: [], devices: [], docs: [], alerts: [], contracts: [], loaded: false };

/** Everything the owner can see about their fleet (RLS: owners read their company's rows). */
export function useFleet(key: string, extraTables: string[] = []) {
  const { company } = useCompany();
  const [fleet, setFleet] = useState<Fleet>(EMPTY);
  const issue = useIssue(`fleet-${key}`);

  const load = useCallback(async () => {
    const db = supabase();
    const [t, d, a, p, dv, doc, al, c] = await Promise.all([
      db.from("tankers").select("id, plate, service_type, capacity_gal, is_online, blocked, blocked_reason, last_lat, last_lng, last_seen_at, location_age_s, created_at, op_card_expiry, insurance_expiry, vehicle_status, adoption_state").eq("company_id", company.id).order("plate"),
      db.from("profiles").select("id, full_name, role, created_at").eq("company_id", company.id).eq("role", "driver").order("full_name")
        .then(async (r) => (r.error ? r : { ...r, data: await withPhones(db, (r.data ?? []) as Record<string, unknown>[]) })),
      db.from("tanker_assignments").select("id, tanker_id, driver_id, assigned_at, unassigned_at").is("unassigned_at", null),
      db.from("permits").select("id, tanker_id, permit_no, type, status, issued_at, expires_at, stage, info_requested, info_response, info_responded_at, reason, created_at").order("created_at", { ascending: false }),
      db.from("devices").select("id, tanker_id, firmware, sensors, installed_at"),
      db.from("tanker_documents").select("id, tanker_id, driver_id, kind, ref_no, valid_to, file_path, status, uploaded_at, review_note").order("valid_to", { ascending: false }),
      db.from("alerts").select("id, tanker_id, order_id, type, severity, message, lat, lng, state, created_at, acted_at, action_note").neq("state", "resolved").order("created_at", { ascending: false }).limit(50),
      db.from("contracts").select("*, customer:profiles(full_name), org:organizations(name), property:properties(label, area)").eq("company_id", company.id).order("created_at", { ascending: false }),
    ]);
    // A failed query keeps what was loaded before instead of showing an empty fleet.
    const failed = [t, d, a, p, dv, doc, al, c].find((r) => r.error)?.error;
    issue(failed ? loadFailed("wFleet", failed.message) : null);
    setFleet((prev) => ({
      tankers: t.error ? prev.tankers : ((t.data ?? []) as FTanker[]),
      drivers: d.error ? prev.drivers : ((d.data ?? []) as FDriver[]),
      assignments: a.error ? prev.assignments : ((a.data ?? []) as FAssignment[]),
      permits: p.error ? prev.permits : ((p.data ?? []) as FPermit[]),
      devices: dv.error ? prev.devices : ((dv.data ?? []) as Device[]),
      docs: doc.error ? prev.docs : ((doc.data ?? []) as TankerDocument[]),
      alerts: al.error ? prev.alerts : ((al.data ?? []) as Alert[]),
      contracts: c.error ? prev.contracts : ((c.data ?? []) as unknown as FContract[]),
      loaded: true,
    }));
  }, [company.id, issue]);

  useLive(`fleet-${key}`, ["tankers", "tanker_assignments", "permits", "tanker_documents", "alerts", "contracts", ...extraTables], load, 45_000);
  return { ...fleet, reload: load };
}

// ---------------------------------------------------------------- helpers
export const driverOf = (f: Pick<Fleet, "assignments" | "drivers">, tankerId: string) => {
  const a = f.assignments.find((x) => x.tanker_id === tankerId);
  return a ? (f.drivers.find((d) => d.id === a.driver_id) ?? null) : null;
};
export const tankerOf = (f: Pick<Fleet, "assignments" | "tankers">, driverId: string) => {
  const a = f.assignments.find((x) => x.driver_id === driverId);
  return a ? (f.tankers.find((t) => t.id === a.tanker_id) ?? null) : null;
};

export function tankerPermit(t: FTanker, permits: FPermit[]) {
  return permitSummary({ service_type: t.service_type, permits: permits.filter((p) => p.tanker_id === t.id) });
}

/**
 * The permit summary's text in a language (permitSummary in components/nws/fleetData is English).
 * Same judgement as permitSummary: the newest approved, unexpired permit of the tanker's service.
 */
export function permitText(t: FTanker, permits: FPermit[], lang: Lang, now = Date.now()): string {
  const p = tankerPermit(t, permits);
  if (lang === "en") return p.text;
  const c = (k: string) => CO[k][lang];
  if (p.valid) {
    const mine = permits.filter((x) => x.tanker_id === t.id).sort((a, b) => b.expires_at.localeCompare(a.expires_at));
    const v = mine.find((x) => x.status === "approved" && x.type === t.service_type && Date.parse(x.expires_at) > now);
    if (!v) return p.text;
    const days = Math.ceil((Date.parse(v.expires_at) - now) / 86_400_000);
    const f = fmtFor(lang);
    return p.tone === "warn" ? (days === 1 ? c("pmExpiresIn1") : c("pmExpiresIn").replace("{n}", f.n(days))) : c("pmValidTo").replace("{date}", f.date(v.expires_at));
  }
  const key: Record<string, string> = { "Pending review": "pmPending", Expired: "pmExpired", Rejected: "pmRejected", "Wrong service type": "pmWrongType", "No permit": "pmNone" };
  return key[p.text] ? c(key[p.text]) : p.text;
}

/** One-word fleet status, as in the prototype's Tankers table. A suspended company's tankers can't work. */
export function tankerStatus(t: FTanker, permits: FPermit[], suspended = false, lang: Lang = "en"): [string, "ok" | "warn" | "bad" | ""] {
  const c = (k: string) => CO[k][lang];
  if (suspended) return [c("stSuspended"), "bad"];
  if (t.blocked) return [c("stBlocked"), "bad"];
  if (t.adoption_state === "pending") return [c("stAdoptionPending"), "warn"];
  const p = tankerPermit(t, permits);
  if (!p.valid) return [p.text === "Pending review" ? c("stPendingPermit") : c("stNoValidPermit"), p.text === "Pending review" ? "warn" : "bad"];
  return t.is_online ? [c("online"), "ok"] : [c("offline"), ""];
}

export const DOC_KINDS = [
  { kind: "mulkiya", label: "Mulkiya" },
  { kind: "tank_cleanliness", label: "Tank cleanliness" },
  { kind: "rop_inspection", label: "ROP inspection" },
  { kind: "insurance", label: "Insurance" },
  { kind: "ivms_certificate", label: "IVMS certificate" },
  { kind: "water_test", label: "Water test" },
] as const;
export const DOC_LABEL: Record<string, string> = { ...Object.fromEntries(DOC_KINDS.map((d) => [d.kind, d.label])), heavy_licence: "Heavy vehicle licence" };
/** A document kind's name in a language (DOC_LABEL stays English for exports). */
export const docLabel = (kind: string, lang: Lang = "en") => CO[`doc_${kind}`]?.[lang] ?? DOC_LABEL[kind] ?? kind;

/**
 * A rejected upload that is newer than the document that counts (so the owner sees "Rejected — re-upload"
 * with NWS's reason instead of the older document silently taking its place).
 */
export function rejectedDoc(docs: TankerDocument[], kind: string, by: { tanker?: string; driver?: string }) {
  const mine = docs.filter((d) => d.kind === kind && (by.tanker ? d.tanker_id === by.tanker : d.driver_id === by.driver)).sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
  return mine[0]?.status === "rejected" ? mine[0] : null;
}

/** The document that counts for a tanker/driver and kind: newest not-rejected one. */
export function currentDoc(docs: TankerDocument[], kind: string, by: { tanker?: string; driver?: string }) {
  return (
    docs
      .filter((d) => d.kind === kind && d.status !== "rejected" && (by.tanker ? d.tanker_id === by.tanker : d.driver_id === by.driver))
      .sort((a, b) => b.valid_to.localeCompare(a.valid_to))[0] ?? null
  );
}

export const STAGE_LABEL = PERMIT_STAGE;
export const FREQ_LABEL: Record<string, string> = { weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly" };


const ORDER_COLS =
  "id, order_no, status, service_type, gallons, area, tanker_id, driver_id, driver_name, tanker_plate, created_at, released_at, accepted_at, collected_at, delivered_at, slot_start, slot_end, slot_label, rating, tip, driver_earnings, contract_id, org_id, channel";

export const ORDER_CAP = 1000;
export const TX_CAP = 2000; // the API may return fewer (its max-rows); `count` reveals any shortfall

/** "Showing the latest N" when a capped query matched more rows than it returned (`what` is a CO key). */
const capped = (what: string, shown: number, total: number | null, days: number): Issue | null =>
  total != null && total > shown ? issueOf("info", "capped", { what, shown, total, days }) : null;

/**
 * Deliveries generated from the company's accepted contracts that no driver has taken yet
 * (RLS: orders_owner_contract, 0023). They are offered first to the company's tankers.
 */
export function useContractDeliveries(key: string) {
  const [orders, setOrders] = useState<FOrder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const issue = useIssue(`contract-orders-${key}`);
  const load = useCallback(async () => {
    const { data, error } = await supabase()
      .from("orders")
      .select(ORDER_COLS)
      .not("contract_id", "is", null)
      .is("tanker_id", null)
      .in("status", ["scheduled", "requested"])
      .order("slot_start", { ascending: true })
      .limit(200);
    if (error) issue(loadFailed("wContractDeliveries", error.message));
    else {
      issue(null);
      setOrders((data ?? []) as FOrder[]);
    }
    setLoaded(true);
  }, [issue]);
  useLive(`contract-orders-${key}`, ["orders", "contracts"], load, 60_000);
  return { orders, loaded };
}

/** Jobs served by the company's tankers since `days` ago (RLS: orders_owner). */
export function useCompanyOrders(key: string, days = 30) {
  const [orders, setOrders] = useState<FOrder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const issue = useIssue(`orders-${key}`);
  const load = useCallback(async () => {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const { data, error, count } = await supabase().from("orders").select(ORDER_COLS, { count: "exact" }).not("tanker_id", "is", null).gte("created_at", since).order("created_at", { ascending: false }).limit(ORDER_CAP);
    if (error) issue(loadFailed("wJobs", error.message));
    else {
      setOrders((data ?? []) as FOrder[]);
      issue(capped("wJobs", data?.length ?? 0, count, days));
    }
    setLoaded(true);
  }, [days, issue]);
  useLive(`orders-${key}`, ["orders"], load, 30_000);
  return { orders, loaded, reload: load };
}

export type FTx = { id: number; driver_id: string | null; tanker_id: string | null; bucket: "earnings" | "fill_credit"; kind: string; amount: string; order_id: string | null; penalty_id: string | null; payout_batch_id: string | null; memo: string; created_at: string };

/** The company's ledger since `days` ago (earnings, tips, penalties, payouts, filling credit). */
export function useCompanyTx(key: string, days = 90) {
  const [tx, setTx] = useState<FTx[]>([]);
  const [loaded, setLoaded] = useState(false);
  const issue = useIssue(`tx-${key}`);
  const load = useCallback(async () => {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const { data, error, count } = await supabase()
      .from("company_tx")
      .select("id, driver_id, tanker_id, bucket, kind, amount, order_id, penalty_id, payout_batch_id, memo, created_at", { count: "exact" })
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(TX_CAP);
    if (error) issue(loadFailed("wLedger", error.message));
    else {
      setTx((data ?? []) as FTx[]);
      issue(capped("wLedgerEntries", data?.length ?? 0, count, days));
    }
    setLoaded(true);
  }, [days, issue]);
  useLive(`tx-${key}`, ["company_tx"], load, 60_000);
  return { tx, loaded, reload: load };
}
