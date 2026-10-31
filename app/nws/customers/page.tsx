"use client";

import "../ops.css";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { COMPLAINTS } from "@/components/nws/i18n/complaints";
import { CUSTOMERS } from "@/components/nws/i18n/customers";
import { downloadCsv, Kpi, maskPhone, n3, one, St, Tabs, useNow, useRealtime, useRpc } from "@/components/nws/ops";
import { Phone, RevealButton, usePrivacy } from "@/components/nws/Privacy";
import { PropertyTrend } from "@/components/nws/PropertyTrend";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { statusText } from "@/components/OrderBits";
import { useFmt } from "@/components/portal/i18n";
import { Loading } from "@/components/Shell";
import { orderNo } from "@/lib/format";
import { useLang, useT } from "@/lib/i18n";
import { contractStatus, freqLabel } from "@/lib/labels";
import type { ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import type { OrderStatus } from "@/lib/types";

type Segment = "household" | "commercial" | "government" | "farm";
type Customer = {
  id: string; full_name: string; phone: string | null; segment: Segment; id_type: string | null; id_no: string | null; id_verified: boolean; id_status?: string;
  account_blocked: boolean; lang: string; loyalty_points: number; created_at: string; role: "customer" | "business"; org_id: string | null; share_usage: boolean | null;
};
// id_type, id_no and loyalty_points are private columns: staff read them through staff_private_profiles().
type Private = { id: string; id_type: string | null; id_no: string | null; loyalty_points: number; share_usage: boolean | null };
type PublicCustomer = Omit<Customer, "id_type" | "id_no" | "loyalty_points" | "share_usage">;
const PUBLIC_COLS = "id, full_name, phone:phone_masked, segment, id_verified, id_status, account_blocked, lang, created_at, role, org_id";
function withPrivate(rows: PublicCustomer[], priv: Private[] | null): Customer[] {
  const m = new Map((priv ?? []).map((p) => [p.id, p]));
  return rows.map((r) => ({ ...r, id_type: m.get(r.id)?.id_type ?? null, id_no: m.get(r.id)?.id_no ?? null, loyalty_points: m.get(r.id)?.loyalty_points ?? 0, share_usage: m.get(r.id)?.share_usage ?? null }));
}
type Org = {
  id: string; name: string; cr_no: string; segment: string; credit_limit: string; terms_days: number; approval_limit: string; invoicing: string;
  paused: boolean; status: "pending" | "active" | "suspended"; created_at: string;
};
type Contract = {
  id: string; contract_no: number; service_type: ServiceType; gallons: number; frequency: string; plan: string; slot: string; start_date: string; end_date: string;
  monthly_est: string; status: string; customer_id: string | null;
  customer: { full_name: string } | { full_name: string }[] | null;
  org: { name: string } | { name: string }[] | null;
  company: { name: string } | { name: string }[] | null;
  property: { label: string; area: string } | { label: string; area: string }[] | null;
};
type Notif = { id: number; event: string; channels: string[]; title: string; created_at: string; read_at: string | null; user: { full_name: string } | { full_name: string }[] | null };

const SEGMENTS: Segment[] = ["household", "commercial", "government", "farm"];
// English segment and ID names for the CSV export (exports keep English); the screen uses CUSTOMERS seg_* / id_*.
const SEG_LABEL: Record<string, string> = { household: "Residential", commercial: "Commercial", government: "Government", farm: "Farm", industrial: "Industrial" };
/** Short customer reference for calls and exports (the prototype's C-1001 style). */
const custRef = (id: string) => `C-${id.slice(0, 6).toUpperCase()}`;

const ORG_TONE = { pending: "warn", active: "ok", suspended: "bad" } as const;

type Tab = "cust" | "b2b" | "contracts" | "notif";

/** Translated segment / ID type names, falling back to the stored code. */
function useNames() {
  const t = useT(CUSTOMERS);
  return useMemo(
    () => ({
      seg: (s: string) => (CUSTOMERS[`seg_${s}`] ? t(`seg_${s}`) : s),
      idType: (s: string) => (CUSTOMERS[`id_${s}`] ? t(`id_${s}`) : s),
    }),
    [t],
  );
}

export default function CustomersPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Customers />
    </Suspense>
  );
}

function Customers() {
  const t = useT(CUSTOMERS);
  const linked = useSearchParams().get("id");
  const [tab, setTab] = useState<Tab>("cust");
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [wallet, setWallet] = useState<Map<string, number>>(new Map());
  const [orderCount, setOrderCount] = useState<Map<string, number>>(new Map());
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgUse, setOrgUse] = useState<Map<string, { used: number; overdue: number; uninvoiced: number }>>(new Map());
  const [contracts, setContracts] = useState<Contract[] | null>(null);
  const [notifs, setNotifs] = useState<Notif[] | null>(null);
  const [sel, setSel] = useState<string | null>(linked);
  const [seen, setSeen] = useState(linked);
  // A new ?id= (search result link) opens that customer's drawer.
  if (linked !== seen) {
    setSeen(linked);
    setSel(linked);
  }

  const load = useCallback(async () => {
    const db = supabase();
    const nowIso = new Date().toISOString();
    const [c, priv, w, g, ao, inv, k] = await Promise.all([
      db.from("profiles").select(PUBLIC_COLS).in("role", ["customer", "business"]).order("created_at", { ascending: false }),
      db.rpc("staff_private_profiles", { p_ids: null }),
      db.rpc("staff_customer_stats"),
      db.from("organizations").select("*").order("name"),
      db.from("orders").select("org_id, total").not("org_id", "is", null).eq("billing", "account").eq("is_test", false).is("invoice_id", null).neq("status", "cancelled"),
      db.from("invoices").select("org_id, total, status, due_at").neq("status", "paid"),
      db
        .from("contracts")
        .select("id, contract_no, service_type, gallons, frequency, plan, slot, start_date, end_date, monthly_est, status, customer_id, customer:profiles(full_name), org:organizations(name), company:companies(name), property:properties(label, area)")
        .order("created_at", { ascending: false }),
    ]);
    setCustomers(withPrivate((c.data ?? []) as PublicCustomer[], priv.data as Private[] | null));
    // Wallet and order counts come from one RPC (a plain select would stop at 1000 rows).
    const stats = (w.data ?? []) as { customer_id: string; wallet: string; orders: number }[];
    setWallet(new Map(stats.map((s) => [s.customer_id, Number(s.wallet)])));
    setOrderCount(new Map(stats.map((s) => [s.customer_id, s.orders])));
    setOrgs((g.data ?? []) as Org[]);
    const um = new Map<string, { used: number; overdue: number; uninvoiced: number }>();
    const get = (id: string) => um.get(id) ?? (um.set(id, { used: 0, overdue: 0, uninvoiced: 0 }), um.get(id)!);
    for (const r of (ao.data ?? []) as { org_id: string; total: string }[]) {
      const u = get(r.org_id);
      u.used += Number(r.total);
      u.uninvoiced += Number(r.total);
    }
    for (const r of (inv.data ?? []) as { org_id: string; total: string; status: string; due_at: string }[]) {
      const u = get(r.org_id);
      u.used += Number(r.total);
      if (r.status === "overdue" || r.due_at < nowIso) u.overdue += Number(r.total);
    }
    setOrgUse(um);
    setContracts((k.data ?? []) as unknown as Contract[]);
  }, []);
  // A new notification only refreshes the log, not every customer figure.
  const loadNotifs = useCallback(async () => {
    const { data } = await supabase().from("notifications").select("id, event, channels, title, created_at, read_at, user:profiles(full_name)").order("created_at", { ascending: false }).limit(200);
    setNotifs((data ?? []) as unknown as Notif[]);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void Promise.all([load(), loadNotifs()]), 0);
    return () => clearTimeout(t);
  }, [load, loadNotifs]);
  useRealtime("nws-customers", ["notifications"], loadNotifs, 1500);
  const orgName = useMemo(() => new Map((orgs ?? []).map((o) => [o.id, o.name])), [orgs]);

  return (
    <>
      <div className="vhead">
        <div>
          <h1>{t("title")}</h1>
          <p>{t("lead")}</p>
        </div>
      </div>
      <Tabs<Tab>
        tabs={[
          ["cust", t("tabCust")],
          ["b2b", t("tabB2b"), orgs?.length],
          ["contracts", t("tabContracts"), contracts?.length],
          ["notif", t("tabNotif")],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "cust" && <CustomersTab customers={customers} orgName={orgName} wallet={wallet} orderCount={orderCount} contracts={contracts ?? []} onOpen={setSel} />}
      {tab === "b2b" && <OrgsTab orgs={orgs} use={orgUse} reload={load} />}
      {tab === "contracts" && <ContractsTab contracts={contracts} />}
      {tab === "notif" && <NotifTab notifs={notifs} />}
      {sel && <CustomerDrawer id={sel} wallet={wallet.get(sel) ?? 0} onClose={() => setSel(null)} reload={load} />}
    </>
  );
}

function CustomersTab({
  customers,
  orgName,
  wallet,
  orderCount,
  contracts,
  onOpen,
}: {
  customers: Customer[] | null;
  orgName: Map<string, string>;
  wallet: Map<string, number>;
  orderCount: Map<string, number>;
  contracts: Contract[];
  onOpen: (id: string) => void;
}) {
  const t = useT(CUSTOMERS);
  const f = useFmt();
  const names = useNames();
  // ID numbers are masked for everyone (encrypted at rest); phones for roles outside the privacy reveal list.
  const privacy = usePrivacy();
  const [seg, setSeg] = useState<Segment | "all">("all");
  const [q, setQ] = useState("");
  const all = useMemo(() => customers ?? [], [customers]);
  const list = all.filter((c) => {
    if (seg !== "all" && c.segment !== seg) return false;
    const s = q.trim().toLowerCase();
    return !s || c.full_name.toLowerCase().includes(s) || custRef(c.id).toLowerCase().includes(s) || (c.phone ?? "").replace(/\s/g, "").includes(s.replace(/\s/g, ""));
  });
  const verified = all.filter((c) => c.id_verified).length;
  const withBalance = all.filter((c) => (wallet.get(c.id) ?? 0) > 0).length;

  return (
    <>
      <div className="okpis">
        <Kpi label={t("kRegistered")} value={customers ? f.n(all.length) : "—"} sub={t("kBlockedN", { n: f.n(all.filter((c) => c.account_blocked).length) })} />
        <Kpi label={t("kVerified")} value={f.ratio(verified, all.length)} sub={t("kOfN", { n: f.n(verified), total: f.n(all.length) })} tone="ok" />
        <Kpi label={t("kContracts")} value={f.n(contracts.filter((k) => k.status === "active").length)} sub={t("kAwaitingCo", { n: f.n(contracts.filter((k) => k.status === "pending_owner").length) })} />
        <Kpi label={t("kWallets")} value={f.n(withBalance)} sub={t("kHeld", { amt: f.omr3([...wallet.values()].reduce((a, b) => a + Math.max(0, b), 0)) })} />
      </div>
      <div className="panel">
        <div className="toolbar">
          <div className="chips" role="group" aria-label={t("segment")}>
            {(["all", ...SEGMENTS] as const).map((k) => (
              <button key={k} className={`chip ${seg === k ? "on" : ""}`} onClick={() => setSeg(k)}>
                {k === "all" ? t("allSegments") : names.seg(k)}
                <span className="tc">{f.n(k === "all" ? all.length : all.filter((c) => c.segment === k).length)}</span>
              </button>
            ))}
          </div>
          <div className="filters">
            <input className="in" placeholder={t("searchPh")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("searchAria")} style={{ width: 210 }} />
            <button
              className="btn sm"
              onClick={() =>
                downloadCsv("customers", [
                  ["Reference", "Name", "Account", "Segment", "ID type", "ID number", "ID verified", "Mobile", "Wallet (OMR)", "Orders", "Status"],
                  ...list.map((c) => [custRef(c.id), c.full_name, c.role === "business" ? `Business (B2B) ${orgName.get(c.org_id ?? "") ?? ""}`.trim() : "Customer", SEG_LABEL[c.segment] ?? c.segment, c.id_type, c.id_no, c.id_verified ? "yes" : "no", privacy.maskPhones ? maskPhone(c.phone) : c.phone, n3(wallet.get(c.id)), orderCount.get(c.id) ?? 0, c.account_blocked ? "Blocked" : "Active"]),
                ])
              }
            >
              {t("exportCsv")}
            </button>
          </div>
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("colCustomer")}</th>
                <th>{t("segment")}</th>
                <th>{t("colId")}</th>
                <th>{t("colMobile")}</th>
                <th className="num">{t("colWallet")}</th>
                <th className="num">{t("colOrders")}</th>
                <th>{t("status")}</th>
              </tr>
            </thead>
            <tbody>
              {!customers && (
                <tr><td colSpan={7} className="empty">{t("loading")}</td></tr>
              )}
              {customers && list.length === 0 && (
                <tr><td colSpan={7} className="empty">{t("noMatch")}</td></tr>
              )}
              {list.map((c) => (
                <tr key={c.id} className="click" onClick={() => onOpen(c.id)}>
                  <td>
                    <b>{c.full_name || t("unnamed")}</b>
                    <small style={{ display: "block" }}>
                      <bdi dir="ltr">{custRef(c.id)}</bdi> · {t("joined", { date: f.date(c.created_at) })}
                      {c.role === "business" && ` · ${t("b2b")}${c.org_id && orgName.get(c.org_id) ? ` · ${orgName.get(c.org_id)}` : ""}`}
                    </small>
                  </td>
                  <td>{names.seg(c.segment)}</td>
                  <td>
                    {c.id_type ? <>{names.idType(c.id_type)} <bdi dir="ltr">{c.id_no ?? ""}</bdi></> : <span className="mut">{t("notProvided")}</span>}{" "}
                    <IdState c={c} />
                  </td>
                  <td><Phone value={c.phone} maskPhones={privacy.maskPhones} /></td>
                  <td className="num">{f.n3(wallet.get(c.id))}</td>
                  <td className="num">{f.n(orderCount.get(c.id) ?? 0)}</td>
                  <td><St tone={c.account_blocked ? "bad" : "ok"}>{c.account_blocked ? t("blocked") : t("active")}</St></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

type Detail = {
  props: { id: string; label: string; address: string; area: string; tank_gal: number; interval: number | null; next: string | null }[];
  orders: { id: string; order_no: number; service_type: ServiceType; gallons: number; status: OrderStatus; total: string; created_at: string }[];
  contracts: { id: string; contract_no: number; service_type: ServiceType; gallons: number; frequency: string; status: string }[];
  complaints: { id: string; case_no: number; category: string; state: string; created_at: string }[];
  tx: { id: number; kind: string; amount: string; memo: string; created_at: string }[];
};

function CustomerDrawer({ id, wallet, onClose, reload }: { id: string; wallet: number; onClose: () => void; reload: () => Promise<void> }) {
  const { can } = useStaff();
  const t = useT(CUSTOMERS);
  const tc = useT(COMPLAINTS);
  const f = useFmt();
  const { lang } = useLang();
  const names = useNames();
  const privacy = usePrivacy();
  const [trend, setTrend] = useState<string | null>(null);
  const run = useRpc();
  const [c, setC] = useState<Customer | null>(null);
  const [d, setD] = useState<Detail | null>(null);
  const [dlg, setDlg] = useState<"goodwill" | "block" | "verify" | "rejectId" | null>(null);

  const load = useCallback(async () => {
    const db = supabase();
    const [p, priv, pr, o, k, x, t, dv] = await Promise.all([
      db.from("profiles").select(PUBLIC_COLS).eq("id", id).maybeSingle(),
      db.rpc("staff_private_profiles", { p_ids: [id] }),
      db.from("properties").select("id, label, address, area, tank_gal").eq("customer_id", id).order("created_at"),
      db.from("orders").select("id, order_no, service_type, gallons, status, total, created_at").eq("customer_id", id).order("created_at", { ascending: false }).limit(30),
      db.from("contracts").select("id, contract_no, service_type, gallons, frequency, status").eq("customer_id", id).order("created_at", { ascending: false }),
      db.from("complaints").select("id, case_no, category, state, created_at").eq("customer_id", id).order("created_at", { ascending: false }),
      db.from("wallet_tx").select("id, kind, amount, memo, created_at").eq("customer_id", id).order("created_at", { ascending: false }).limit(50),
      db.from("orders").select("property_id, delivered_at").eq("customer_id", id).eq("status", "delivered").not("property_id", "is", null).order("delivered_at").limit(500),
    ]);
    // Usual interval = average days between deliveries to the property; next refill = last + interval.
    const byProp = new Map<string, number[]>();
    for (const r of (dv.data ?? []) as { property_id: string; delivered_at: string | null }[])
      if (r.delivered_at) byProp.set(r.property_id, [...(byProp.get(r.property_id) ?? []), Date.parse(r.delivered_at)]);
    const cadence = (pid: string) => {
      const ts = byProp.get(pid) ?? [];
      if (ts.length < 2) return { interval: null, next: null };
      const days = (ts[ts.length - 1] - ts[0]) / 86_400_000 / (ts.length - 1);
      return { interval: Math.max(1, Math.round(days)), next: new Date(ts[ts.length - 1] + days * 86_400_000).toISOString() };
    };
    setC(p.data ? withPrivate([p.data as PublicCustomer], priv.data as Private[] | null)[0] : null);
    setD({
      props: ((pr.data ?? []) as Omit<Detail["props"][number], "interval" | "next">[]).map((x) => ({ ...x, ...cadence(x.id) })),
      orders: (o.data ?? []) as Detail["orders"],
      contracts: (k.data ?? []) as Detail["contracts"],
      complaints: (x.data ?? []) as Detail["complaints"],
      tx: (t.data ?? []) as Detail["tx"],
    });
  }, [id]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  async function act(action: string, reason: string, ok: string, amount?: number) {
    if (await run("staff_customer_action", { p_customer_id: id, p_action: action, p_reason: reason, p_amount: amount ?? null }, ok)) {
      setDlg(null);
      await Promise.all([load(), reload()]);
    }
  }

  const canGood = can("complaints_agent", "finance", "admin");
  const canBlock = can("operator", "admin");
  // 0050: identities are verified by the roles that see the ID scans (0049).
  const canVerify = can("permit_officer", "inspector", "admin");
  const caseState = (s: string) => (CUSTOMERS[`cstate_${s}`] ? t(`cstate_${s}`) : s);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" aria-label={t("drawerAria")}>
        {!c ? (
          <div className="empty">{t("loading")}</div>
        ) : (
          <>
            <div className="vhead">
              <div>
                <h1>{c.full_name || t("unnamed")}</h1>
                <p>
                  <bdi dir="ltr">{custRef(c.id)}</bdi> · {names.seg(c.segment)} · {t("joined", { date: f.date(c.created_at) })} · <St tone={c.account_blocked ? "bad" : "ok"}>{c.account_blocked ? t("blocked") : t("active")}</St>
                </p>
              </div>
              <button className="btn" onClick={onClose}>{t("close")}</button>
            </div>
            <div className="panel">
              <dl className="kv" style={{ paddingTop: 14 }}>
                <dt>{t("colMobile")}</dt>
                <dd><Phone value={c.phone} maskPhones={privacy.maskPhones} /> {c.phone && <St tone="ok">{t("otpVerified")}</St>} {c.phone && <RevealButton profileId={c.id} kind="contact" privileged={privacy.privileged} />}</dd>
                <dt>{t("colId")}</dt>
                <dd>
                  {c.id_type ? <>{names.idType(c.id_type)} <bdi dir="ltr">{c.id_no ?? ""}</bdi></> : t("notProvided")} <IdState c={c} />
                  {c.id_no && <RevealButton profileId={c.id} kind="identity" privileged={privacy.privileged} />}
                </dd>
                <dt>{t("segment")}</dt>
                <dd>{names.seg(c.segment)}</dd>
                <dt>{t("langLabel")}</dt>
                <dd>{c.lang === "ar" ? t("langAr") : t("langEn")}</dd>
                <dt>{t("colWallet")}</dt>
                <dd>{f.omr3(wallet)} · {t("loyalty", { n: f.n(c.loyalty_points) })}</dd>
                <dt>{t("consents")}</dt>
                <dd>{t("usageSharing", { state: c.share_usage ? t("consentOn") : t("consentOff") })}</dd>
                <dt>{t("account")}</dt>
                <dd>{c.role === "business" ? t("acctB2b") : t("acctApp")}</dd>
              </dl>
              <div className="pad btns">
                <button className="btn" disabled={!canGood} title={canGood ? undefined : t("onlyGood")} onClick={() => setDlg("goodwill")}>
                  {t("goodwillBtn")}
                </button>
                <button className={`btn ${c.account_blocked ? "" : "bad"}`} disabled={!canBlock} title={canBlock ? undefined : t("onlyBlock")} onClick={() => setDlg("block")}>
                  {c.account_blocked ? t("unblock") : t("blockAcct")}
                </button>
                {!c.id_verified && c.id_type && (
                  <button className="btn" disabled={!canVerify} title={canVerify ? undefined : t("onlyVerify")} onClick={() => setDlg("verify")}>
                    {t("verifyId")}
                  </button>
                )}
                {!c.id_verified && c.id_type && c.id_status !== "rejected" && (
                  <button className="btn" disabled={!canVerify} title={canVerify ? undefined : t("onlyVerify")} onClick={() => setDlg("rejectId")}>
                    {t("rejectId")}
                  </button>
                )}
              </div>
            </div>

            <div className="grid2">
              <div>
                <div className="panel">
                  <h2>{t("properties")} <small>{f.n(d?.props.length ?? 0)}</small></h2>
                  <div className="tblwrap">
                    <table>
                      <thead>
                        <tr><th>{t("colPropAddr")}</th><th className="num">{t("colTank")}</th><th>{t("colInterval")}</th></tr>
                      </thead>
                      <tbody>
                        {d?.props.length === 0 && <tr><td colSpan={3} className="mut">{t("noProps")}</td></tr>}
                        {d?.props.map((p) => (
                          <Fragment key={p.id}>
                          <tr>
                            <td><b>{p.label}</b><small style={{ display: "block" }}>{[p.address, p.area].filter(Boolean).join(" · ") || "—"}</small></td>
                            <td className="num">{f.gal(p.tank_gal)}</td>
                            <td>
                              {p.interval ? t("everyDays", { n: f.n(p.interval) }) : <span className="mut">{t("notEnough")}</span>}
                              {p.next && <small style={{ display: "block" }}>{t("nextRefill", { date: f.date(p.next) })}</small>}
                              <button className="btn sm ghost" onClick={() => setTrend(trend === p.id ? null : p.id)} aria-expanded={trend === p.id}>{trend === p.id ? t("hideTrend") : t("showTrend")}</button>
                            </td>
                          </tr>
                          {trend === p.id && (
                            <tr><td colSpan={3}><PropertyTrend propertyId={p.id} /></td></tr>
                          )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="panel">
                  <h2>{t("contracts")} <small>{f.n(d?.contracts.length ?? 0)}</small></h2>
                  <div className="tblwrap">
                    <table>
                      <tbody>
                        {d?.contracts.length === 0 && <tr><td className="mut">{t("noContracts")}</td></tr>}
                        {d?.contracts.map((k) => (
                          <tr key={k.id}>
                            <td><bdi dir="ltr">CT-{k.contract_no}</bdi></td>
                            <td><span className={`tag ${k.service_type}`}>{k.service_type}</span> {f.gal(k.gallons)} · {freqLabel(k.frequency, lang)}</td>
                            <td><St tone={contractStatus(k.status)[1]}>{contractStatus(k.status, "other", lang)[0]}</St></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="panel">
                  <h2>{t("complaints")} <small>{f.n(d?.complaints.length ?? 0)}</small></h2>
                  <div className="tblwrap">
                    <table>
                      <tbody>
                        {d?.complaints.length === 0 && <tr><td className="mut">{t("noneDot")}</td></tr>}
                        {d?.complaints.map((x) => (
                          <tr key={x.id}>
                            <td><Link className="lk" href={`/nws/complaints?id=${x.id}`}><bdi dir="ltr">C-{x.case_no}</bdi></Link></td>
                            <td>{COMPLAINTS[`cat_${x.category}`] ? tc(`cat_${x.category}`) : x.category.replace(/_/g, " ")}</td>
                            <td><St tone={x.state === "resolved" ? "ok" : x.state === "escalated" ? "bad" : x.state === "new" ? "warn" : "act"}>{caseState(x.state)}</St></td>
                            <td><small>{f.date(x.created_at)}</small></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div>
                <div className="panel">
                  <h2>{t("orders")} <small>{f.n(d?.orders.length ?? 0)}{d?.orders.length === 30 ? t("latest30") : ""}</small></h2>
                  <div className="tblwrap">
                    <table>
                      <tbody>
                        {d?.orders.length === 0 && <tr><td className="mut">{t("noOrders")}</td></tr>}
                        {d?.orders.map((o) => (
                          <tr key={o.id}>
                            <td className={`stripe ${o.service_type}`}><Link className="lk" href={`/nws/orders/${o.id}`}><bdi dir="ltr">{orderNo(o.order_no)}</bdi></Link><small style={{ display: "block" }}>{f.date(o.created_at)}</small></td>
                            <td>{f.gal(o.gallons)}</td>
                            <td><St tone={statusText(o.status, o.service_type)[1]}>{statusText(o.status, o.service_type, lang)[0]}</St></td>
                            <td className="num">{f.n3(o.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="panel">
                  <h2>{t("walletTx")} <small>{t("balanceX", { amt: f.omr3(wallet) })}</small></h2>
                  <div className="tblwrap">
                    <table>
                      <tbody>
                        {d?.tx.length === 0 && <tr><td className="mut">{t("noWallet")}</td></tr>}
                        {d?.tx.map((x) => (
                          <tr key={x.id}>
                            <td><small>{f.dateTime(x.created_at)}</small></td>
                            <td>{x.kind.replace(/_/g, " ")}<small style={{ display: "block" }}>{x.memo}</small></td>
                            <td className="num" style={{ color: Number(x.amount) < 0 ? "var(--bad)" : "var(--ok)" }}>
                              <bdi dir="ltr">
                                {Number(x.amount) > 0 ? "+" : ""}
                                {f.n3(x.amount)}
                              </bdi>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </aside>
      {dlg === "goodwill" && c && (
        <ReasonDialog
          title={t("gwTitle", { name: c.full_name })}
          body={t("gwBody")}
          confirm={t("gwConfirm")}
          onCancel={() => setDlg(null)}
          onConfirm={(r) => act("goodwill", r, t("gwOk"), 2)}
        />
      )}
      {dlg === "block" && c && (
        <ReasonDialog
          title={c.account_blocked ? t("unblockTitle", { name: c.full_name }) : t("blockTitle", { name: c.full_name })}
          body={c.account_blocked ? t("unblockBody") : t("blockBody")}
          confirm={c.account_blocked ? t("unblock") : t("blockAcct")}
          danger={!c.account_blocked}
          onCancel={() => setDlg(null)}
          onConfirm={(r) => act(c.account_blocked ? "unblock" : "block", r, c.account_blocked ? t("unblockedOk") : t("blockedOk"))}
        />
      )}
      {dlg === "verify" && c && (
        <ReasonDialog
          title={t("verifyTitle", { name: c.full_name })}
          body={t("verifyBody")}
          confirm={t("verifyConfirm")}
          onCancel={() => setDlg(null)}
          onConfirm={(r) => act("verify_id", r, t("verifyOk"))}
        />
      )}
      {dlg === "rejectId" && c && (
        <ReasonDialog
          title={t("rejectIdTitle", { name: c.full_name })}
          body={t("rejectIdBody")}
          confirm={t("rejectId")}
          danger
          onCancel={() => setDlg(null)}
          onConfirm={(r) => act("reject_id", r, t("rejectIdOk"))}
        />
      )}
    </>
  );
}

function OrgsTab({ orgs, use, reload }: { orgs: Org[] | null; use: Map<string, { used: number; overdue: number; uninvoiced: number }>; reload: () => Promise<void> }) {
  const { can } = useStaff();
  const t = useT(CUSTOMERS);
  const f = useFmt();
  const names = useNames();
  const run = useRpc();
  const [dlg, setDlg] = useState<{ org: Org; action: "raise_limit" | "pause" | "resume" | "activate" | "invoice" } | null>(null);
  const fin = can("finance", "admin");
  const title = fin ? undefined : t("onlyFin");
  // Dialog title, confirm button and success toast for each action.
  const text = (a: string): [string, string, string] => [t(`a_${a}_t`), t(`a_${a}_c`), t(`a_${a}_ok`)];

  return (
    <div className="panel">
      <h2>
        {t("orgsTitle")} <small>{t("orgsSub")}</small>
      </h2>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>{t("colAccount")}</th>
              <th>{t("segment")}</th>
              <th>{t("status")}</th>
              <th className="num">{t("colLimit")}</th>
              <th className="num">{t("colUsed")}</th>
              <th>{t("colTerms")}</th>
              <th>{t("colInvoicing")}</th>
              <th className="num">{t("colOverdue")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {!orgs && <tr><td colSpan={9} className="empty">{t("loading")}</td></tr>}
            {orgs?.length === 0 && <tr><td colSpan={9} className="empty">{t("noOrgs")}</td></tr>}
            {orgs?.map((o) => {
              const u = use.get(o.id) ?? { used: 0, overdue: 0, uninvoiced: 0 };
              const over = u.used > Number(o.credit_limit);
              return (
                <tr key={o.id}>
                  {/* i18n-ignore: CR is the Commercial Registration number's standard abbreviation */}
                  <td><b>{o.name}</b><small style={{ display: "block" }}>CR <bdi dir="ltr">{o.cr_no}</bdi></small></td>
                  <td>{names.seg(o.segment)}</td>
                  <td>
                    <St tone={ORG_TONE[o.status]}>{t(`org_${o.status}`)}</St>
                    {o.paused && <St tone="bad">{t("ordersPaused")}</St>}
                  </td>
                  <td className="num">{f.n3(o.credit_limit)}</td>
                  <td className="num" style={over ? { color: "var(--bad)" } : undefined}>{f.n3(u.used)}</td>
                  <td>{t("netDays", { n: f.n(o.terms_days) })}</td>
                  <td>{o.invoicing === "weekly" ? t("weekly") : t("monthly")}</td>
                  <td className="num">{u.overdue > 0 ? <span style={{ color: "var(--bad)" }}>{f.n3(u.overdue)}</span> : "—"}</td>
                  <td>
                    <div className="btns" style={{ flexWrap: "nowrap" }}>
                      <button className="btn sm" disabled={!fin} title={title} onClick={() => setDlg({ org: o, action: "raise_limit" })}>{t("raise500")}</button>
                      <button className={`btn sm ${o.paused ? "" : "bad"}`} disabled={!fin} title={title} onClick={() => setDlg({ org: o, action: o.paused ? "resume" : "pause" })}>
                        {o.paused ? t("resumeOrders") : t("pauseOrders")}
                      </button>
                      {o.status !== "active" && (
                        <button className="btn sm pri" disabled={!fin} title={title} onClick={() => setDlg({ org: o, action: "activate" })}>{t("activate")}</button>
                      )}
                      <button className="btn sm" disabled={!fin || u.uninvoiced <= 0} title={!fin ? title : u.uninvoiced <= 0 ? t("noUninvoiced") : undefined} onClick={() => setDlg({ org: o, action: "invoice" })}>
                        {t("invoiceNow")}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="note">{t("usedNote")}</p>
      {dlg && (
        <ReasonDialog
          title={`${text(dlg.action)[0]} — ${dlg.org.name}`}
          confirm={text(dlg.action)[1]}
          danger={dlg.action === "pause"}
          onCancel={() => setDlg(null)}
          onConfirm={async (r) => {
            if (await run("staff_org_action", { p_org_id: dlg.org.id, p_action: dlg.action, p_reason: r, p_amount: dlg.action === "raise_limit" ? 500 : null }, text(dlg.action)[2])) {
              setDlg(null);
              await reload();
            }
          }}
        />
      )}
    </div>
  );
}

function ContractsTab({ contracts }: { contracts: Contract[] | null }) {
  const t = useT(CUSTOMERS);
  const fm = useFmt();
  const { lang } = useLang();
  const [f, setF] = useState("all");
  const list = (contracts ?? []).filter((k) => f === "all" || k.status === f);
  return (
    <div className="panel">
      <div className="toolbar">
        <div className="chips">
          {["all", "active", "pending_owner", "paused", "ended", "declined"].map((k) => (
            <button key={k} className={`chip ${f === k ? "on" : ""}`} onClick={() => setF(k)}>
              {k === "all" ? t("all") : contractStatus(k, "other", lang)[0]}
              <span className="tc">{fm.n((contracts ?? []).filter((x) => k === "all" || x.status === k).length)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>{t("colContract")}</th>
              <th>{t("colCustomer")}</th>
              <th>{t("colCompany")}</th>
              <th>{t("colProperty")}</th>
              <th>{t("service")}</th>
              <th>{t("colFrequency")}</th>
              <th>{t("colTerm")}</th>
              <th className="num">{t("colMonthly")}</th>
              <th>{t("status")}</th>
            </tr>
          </thead>
          <tbody>
            {!contracts && <tr><td colSpan={9} className="empty">{t("loading")}</td></tr>}
            {contracts && list.length === 0 && <tr><td colSpan={9} className="empty">{t("noContracts")}</td></tr>}
            {list.map((k) => {
              const p = one(k.property);
              return (
                <tr key={k.id}>
                  <td className={`stripe ${k.service_type}`}><b dir="ltr">CT-{k.contract_no}</b></td>
                  <td>{one(k.customer)?.full_name || one(k.org)?.name || "—"}{one(k.org) && <small style={{ display: "block" }}>{t("bizAccount")}</small>}</td>
                  <td>{one(k.company)?.name ?? "—"}</td>
                  <td>{p ? <>{p.label}<small style={{ display: "block" }}>{p.area}</small></> : "—"}</td>
                  <td><span className={`tag ${k.service_type}`}>{k.service_type}</span> {fm.gal(k.gallons)}</td>
                  <td>{freqLabel(k.frequency, lang)} · {k.slot}<small style={{ display: "block" }}>{t("planX", { plan: k.plan })}</small></td>
                  <td><small>{fm.date(k.start_date)} – {fm.date(k.end_date)}</small></td>
                  <td className="num">{fm.n3(k.monthly_est)}</td>
                  <td><St tone={contractStatus(k.status)[1]}>{contractStatus(k.status, "other", lang)[0]}</St></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NotifTab({ notifs }: { notifs: Notif[] | null }) {
  const t = useT(CUSTOMERS);
  const f = useFmt();
  const now = useNow(30_000);
  const channel = (c: string) => (c === "sms" ? "SMS" : c === "whatsapp" ? "WhatsApp" : CUSTOMERS[`ch_${c}`] ? t(`ch_${c}`) : c[0].toUpperCase() + c.slice(1));
  return (
    <div className="panel">
      <h2>
        {t("notifTitle")} <small>{t("notifSub")}</small>
      </h2>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>{t("time")}</th>
              <th>{t("colEvent")}</th>
              <th>{t("colChannels")}</th>
              <th>{t("colRecipient")}</th>
              <th>{t("colMessage")}</th>
              <th>{t("status")}</th>
            </tr>
          </thead>
          <tbody>
            {!notifs && <tr><td colSpan={6} className="empty">{t("loading")}</td></tr>}
            {notifs?.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  {t("noNotifs")}
                </td>
              </tr>
            )}
            {notifs?.map((n) => (
              <tr key={n.id}>
                <td><small>{f.dateTime(n.created_at)}</small></td>
                <td>{n.event.replace(/_/g, " ")}</td>
                <td>{n.channels.map(channel).join(f.ar ? "، " : ", ")}</td>
                <td>{one(n.user)?.full_name || "—"}</td>
                <td>{n.title}</td>
                <td>{n.read_at ? <St tone="ok">{t("read")}</St> : <St tone={now - Date.parse(n.created_at) > 86_400_000 ? "" : "act"}>{t("delivered")}</St>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">{t("notifNote")}</p>
    </div>
  );
}

/** The identity state: declared by the person, verified or rejected by NWS (0050). */
function IdState({ c }: { c: { id_verified: boolean; id_status?: string; id_type: string | null } }) {
  const t = useT(CUSTOMERS);
  if (c.id_verified) return <St tone="ok">{t("verified")}</St>;
  if (c.id_status === "rejected") return <St tone="bad">{t("idRejectedSt")}</St>;
  if (c.id_type) return <St tone="warn">{t("idDeclaredSt")}</St>;
  return <St tone="warn">{t("unverified")}</St>;
}
