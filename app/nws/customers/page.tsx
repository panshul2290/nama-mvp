"use client";

import "../ops.css";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { downloadCsv, Kpi, n3, omr3, one, pct, St, Tabs, useNow, useRealtime, useRpc } from "@/components/nws/ops";
import { fmtDate, fmtDateTime, ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { STATUS_TEXT } from "@/components/OrderBits";
import { Loading } from "@/components/Shell";
import { orderNo } from "@/lib/format";
import type { ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import type { OrderStatus } from "@/lib/types";

type Segment = "household" | "commercial" | "government" | "farm";
type Customer = {
  id: string; full_name: string; phone: string | null; segment: Segment; id_type: string | null; id_no: string | null; id_verified: boolean;
  account_blocked: boolean; lang: string; loyalty_points: number; created_at: string;
};
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
const SEG_LABEL: Record<string, string> = { household: "Household", commercial: "Commercial", government: "Government", farm: "Farm", industrial: "Industrial" };
const ID_LABEL: Record<string, string> = { civil_id: "Civil ID", resident_card: "Resident card", passport: "Passport" };
const CONTRACT_TONE: Record<string, string> = { active: "ok", pending_owner: "warn", paused: "warn", ended: "", declined: "bad" };
const CONTRACT_LABEL: Record<string, string> = { active: "Active", pending_owner: "Pending owner", paused: "Paused", ended: "Ended", declined: "Declined" };
const ORG_TONE = { pending: "warn", active: "ok", suspended: "bad" } as const;

type Tab = "cust" | "b2b" | "contracts" | "notif";

export default function CustomersPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Customers />
    </Suspense>
  );
}

function Customers() {
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
    const [c, w, o, g, ao, inv, k, n] = await Promise.all([
      db.from("profiles").select("id, full_name, phone, segment, id_type, id_no, id_verified, account_blocked, lang, loyalty_points, created_at").eq("role", "customer").order("created_at", { ascending: false }),
      db.from("wallet_tx").select("customer_id, amount"),
      db.from("orders").select("customer_id").limit(10000),
      db.from("organizations").select("*").order("name"),
      db.from("orders").select("org_id, total").not("org_id", "is", null).eq("billing", "account").is("invoice_id", null).neq("status", "cancelled"),
      db.from("invoices").select("org_id, total, status, due_at").neq("status", "paid"),
      db
        .from("contracts")
        .select("id, contract_no, service_type, gallons, frequency, plan, slot, start_date, end_date, monthly_est, status, customer_id, customer:profiles(full_name), org:organizations(name), company:companies(name), property:properties(label, area)")
        .order("created_at", { ascending: false }),
      db.from("notifications").select("id, event, channels, title, created_at, read_at, user:profiles(full_name)").order("created_at", { ascending: false }).limit(200),
    ]);
    setCustomers((c.data ?? []) as Customer[]);
    const wm = new Map<string, number>();
    for (const r of (w.data ?? []) as { customer_id: string; amount: string }[]) wm.set(r.customer_id, (wm.get(r.customer_id) ?? 0) + Number(r.amount));
    setWallet(wm);
    const om = new Map<string, number>();
    for (const r of (o.data ?? []) as { customer_id: string }[]) om.set(r.customer_id, (om.get(r.customer_id) ?? 0) + 1);
    setOrderCount(om);
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
    setNotifs((n.data ?? []) as unknown as Notif[]);
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);
  useRealtime("nws-customers", ["notifications"], load, 1500);

  return (
    <>
      <div className="vhead">
        <div>
          <h1>Customers</h1>
          <p>Look up any customer, their properties, contracts, wallet, orders and complaints. Manage corporate and government accounts on credit terms.</p>
        </div>
      </div>
      <Tabs<Tab>
        tabs={[
          ["cust", "Customers"],
          ["b2b", "Corporate accounts", orgs?.length],
          ["contracts", "Contracts", contracts?.length],
          ["notif", "Notifications log"],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "cust" && <CustomersTab customers={customers} wallet={wallet} orderCount={orderCount} contracts={contracts ?? []} onOpen={setSel} />}
      {tab === "b2b" && <OrgsTab orgs={orgs} use={orgUse} reload={load} />}
      {tab === "contracts" && <ContractsTab contracts={contracts} />}
      {tab === "notif" && <NotifTab notifs={notifs} />}
      {sel && <CustomerDrawer id={sel} wallet={wallet.get(sel) ?? 0} onClose={() => setSel(null)} reload={load} />}
    </>
  );
}

function CustomersTab({
  customers,
  wallet,
  orderCount,
  contracts,
  onOpen,
}: {
  customers: Customer[] | null;
  wallet: Map<string, number>;
  orderCount: Map<string, number>;
  contracts: Contract[];
  onOpen: (id: string) => void;
}) {
  const [seg, setSeg] = useState<Segment | "all">("all");
  const [q, setQ] = useState("");
  const all = useMemo(() => customers ?? [], [customers]);
  const list = all.filter((c) => {
    if (seg !== "all" && c.segment !== seg) return false;
    const s = q.trim().toLowerCase();
    return !s || c.full_name.toLowerCase().includes(s) || (c.phone ?? "").replace(/\s/g, "").includes(s.replace(/\s/g, ""));
  });
  const verified = all.filter((c) => c.id_verified).length;
  const withBalance = all.filter((c) => (wallet.get(c.id) ?? 0) > 0).length;

  return (
    <>
      <div className="okpis">
        <Kpi label="Registered customers" value={customers ? all.length.toLocaleString() : "—"} sub={`${all.filter((c) => c.account_blocked).length} blocked`} />
        <Kpi label="ID-verified" value={pct(verified, all.length)} sub={`${verified} of ${all.length}`} tone="ok" />
        <Kpi label="Active contracts" value={contracts.filter((k) => k.status === "active").length} sub={`${contracts.filter((k) => k.status === "pending_owner").length} awaiting a tanker company`} />
        <Kpi label="Wallets with balance" value={withBalance} sub={`${n3([...wallet.values()].reduce((a, b) => a + Math.max(0, b), 0))} OMR held`} />
      </div>
      <div className="panel">
        <div className="toolbar">
          <div className="chips" role="group" aria-label="Segment">
            {(["all", ...SEGMENTS] as const).map((k) => (
              <button key={k} className={`chip ${seg === k ? "on" : ""}`} onClick={() => setSeg(k)}>
                {k === "all" ? "All segments" : SEG_LABEL[k]}
                <span className="tc">{k === "all" ? all.length : all.filter((c) => c.segment === k).length}</span>
              </button>
            ))}
          </div>
          <div className="filters">
            <input className="in" placeholder="Search name or mobile" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search customers" style={{ width: 210 }} />
            <button
              className="btn sm"
              onClick={() =>
                downloadCsv("customers", [
                  ["Name", "Segment", "ID type", "ID number", "ID verified", "Mobile", "Wallet (OMR)", "Orders", "Status"],
                  ...list.map((c) => [c.full_name, c.segment, c.id_type, c.id_no, c.id_verified ? "yes" : "no", c.phone, n3(wallet.get(c.id)), orderCount.get(c.id) ?? 0, c.account_blocked ? "Blocked" : "Active"]),
                ])
              }
            >
              Export CSV
            </button>
          </div>
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Segment</th>
                <th>ID</th>
                <th>Mobile</th>
                <th className="num">Wallet</th>
                <th className="num">Orders</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {!customers && (
                <tr><td colSpan={7} className="empty">Loading…</td></tr>
              )}
              {customers && list.length === 0 && (
                <tr><td colSpan={7} className="empty">No customers match.</td></tr>
              )}
              {list.map((c) => (
                <tr key={c.id} className="click" onClick={() => onOpen(c.id)}>
                  <td>
                    <b>{c.full_name || "Unnamed customer"}</b>
                    <small style={{ display: "block" }}>joined {fmtDate(c.created_at)}</small>
                  </td>
                  <td>{SEG_LABEL[c.segment] ?? c.segment}</td>
                  <td>
                    {c.id_type ? `${ID_LABEL[c.id_type] ?? c.id_type} ${c.id_no ?? ""}` : <span className="mut">Not provided</span>}{" "}
                    <St tone={c.id_verified ? "ok" : "warn"}>{c.id_verified ? "Verified" : "Unverified"}</St>
                  </td>
                  <td>{c.phone || "—"}</td>
                  <td className="num">{n3(wallet.get(c.id))}</td>
                  <td className="num">{orderCount.get(c.id) ?? 0}</td>
                  <td><St tone={c.account_blocked ? "bad" : "ok"}>{c.account_blocked ? "Blocked" : "Active"}</St></td>
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
  props: { id: string; label: string; address: string; area: string; tank_gal: number }[];
  orders: { id: string; order_no: number; service_type: ServiceType; gallons: number; status: OrderStatus; total: string; created_at: string }[];
  contracts: { id: string; contract_no: number; service_type: ServiceType; gallons: number; frequency: string; status: string }[];
  complaints: { id: string; case_no: number; category: string; state: string; created_at: string }[];
  tx: { id: number; kind: string; amount: string; memo: string; created_at: string }[];
};

function CustomerDrawer({ id, wallet, onClose, reload }: { id: string; wallet: number; onClose: () => void; reload: () => Promise<void> }) {
  const { can } = useStaff();
  const run = useRpc();
  const [c, setC] = useState<Customer | null>(null);
  const [d, setD] = useState<Detail | null>(null);
  const [dlg, setDlg] = useState<"goodwill" | "block" | "verify" | null>(null);

  const load = useCallback(async () => {
    const db = supabase();
    const [p, pr, o, k, x, t] = await Promise.all([
      db.from("profiles").select("id, full_name, phone, segment, id_type, id_no, id_verified, account_blocked, lang, loyalty_points, created_at").eq("id", id).maybeSingle(),
      db.from("properties").select("id, label, address, area, tank_gal").eq("customer_id", id).order("created_at"),
      db.from("orders").select("id, order_no, service_type, gallons, status, total, created_at").eq("customer_id", id).order("created_at", { ascending: false }).limit(30),
      db.from("contracts").select("id, contract_no, service_type, gallons, frequency, status").eq("customer_id", id).order("created_at", { ascending: false }),
      db.from("complaints").select("id, case_no, category, state, created_at").eq("customer_id", id).order("created_at", { ascending: false }),
      db.from("wallet_tx").select("id, kind, amount, memo, created_at").eq("customer_id", id).order("created_at", { ascending: false }).limit(50),
    ]);
    setC(p.data as Customer | null);
    setD({
      props: (pr.data ?? []) as Detail["props"],
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
  const canVerify = can("operator", "admin", "complaints_agent");

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" aria-label="Customer detail">
        {!c ? (
          <div className="empty">Loading…</div>
        ) : (
          <>
            <div className="vhead">
              <div>
                <h1>{c.full_name || "Unnamed customer"}</h1>
                <p>
                  {SEG_LABEL[c.segment]} · joined {fmtDate(c.created_at)} · <St tone={c.account_blocked ? "bad" : "ok"}>{c.account_blocked ? "Blocked" : "Active"}</St>
                </p>
              </div>
              <button className="btn" onClick={onClose}>Close</button>
            </div>
            <div className="panel">
              <dl className="kv" style={{ paddingTop: 14 }}>
                <dt>Mobile</dt>
                <dd>{c.phone || "—"} {c.phone && <St tone="ok">OTP verified</St>}</dd>
                <dt>ID</dt>
                <dd>
                  {c.id_type ? `${ID_LABEL[c.id_type] ?? c.id_type} ${c.id_no ?? ""}` : "Not provided"} <St tone={c.id_verified ? "ok" : "warn"}>{c.id_verified ? "Verified" : "Unverified"}</St>
                </dd>
                <dt>Segment</dt>
                <dd>{SEG_LABEL[c.segment]}</dd>
                <dt>Language</dt>
                <dd>{c.lang === "ar" ? "Arabic" : "English"}</dd>
                <dt>Wallet</dt>
                <dd>{omr3(wallet)} · {c.loyalty_points.toLocaleString()} loyalty points</dd>
              </dl>
              <div className="pad btns">
                <button className="btn" disabled={!canGood} title={canGood ? undefined : "Complaints agents, finance and admins only"} onClick={() => setDlg("goodwill")}>
                  Add 2.000 OMR goodwill credit
                </button>
                <button className={`btn ${c.account_blocked ? "" : "bad"}`} disabled={!canBlock} title={canBlock ? undefined : "Operators and admins only"} onClick={() => setDlg("block")}>
                  {c.account_blocked ? "Unblock" : "Block account"}
                </button>
                {!c.id_verified && (
                  <button className="btn" disabled={!canVerify} title={canVerify ? undefined : "Operators, complaints agents and admins only"} onClick={() => setDlg("verify")}>
                    Verify ID
                  </button>
                )}
                <button className="btn" disabled title="Impersonation isn't available in this pilot">
                  Open as customer
                </button>
              </div>
            </div>

            <div className="grid2">
              <div>
                <div className="panel">
                  <h2>Properties <small>{d?.props.length ?? 0}</small></h2>
                  <div className="tblwrap">
                    <table>
                      <tbody>
                        {d?.props.length === 0 && <tr><td className="mut">No saved properties.</td></tr>}
                        {d?.props.map((p) => (
                          <tr key={p.id}>
                            <td><b>{p.label}</b><small style={{ display: "block" }}>{[p.address, p.area].filter(Boolean).join(" · ") || "—"}</small></td>
                            <td className="num">{p.tank_gal.toLocaleString()} gal</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="panel">
                  <h2>Contracts <small>{d?.contracts.length ?? 0}</small></h2>
                  <div className="tblwrap">
                    <table>
                      <tbody>
                        {d?.contracts.length === 0 && <tr><td className="mut">No contracts.</td></tr>}
                        {d?.contracts.map((k) => (
                          <tr key={k.id}>
                            <td>CT-{k.contract_no}</td>
                            <td><span className={`tag ${k.service_type}`}>{k.service_type}</span> {k.gallons.toLocaleString()} gal · {k.frequency}</td>
                            <td><St tone={CONTRACT_TONE[k.status]}>{CONTRACT_LABEL[k.status] ?? k.status}</St></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="panel">
                  <h2>Complaints <small>{d?.complaints.length ?? 0}</small></h2>
                  <div className="tblwrap">
                    <table>
                      <tbody>
                        {d?.complaints.length === 0 && <tr><td className="mut">None.</td></tr>}
                        {d?.complaints.map((x) => (
                          <tr key={x.id}>
                            <td><Link className="lk" href={`/nws/complaints?id=${x.id}`}>C-{x.case_no}</Link></td>
                            <td>{x.category.replace(/_/g, " ")}</td>
                            <td><St tone={x.state === "resolved" ? "ok" : x.state === "escalated" ? "bad" : x.state === "new" ? "warn" : "act"}>{x.state[0].toUpperCase() + x.state.slice(1)}</St></td>
                            <td><small>{fmtDate(x.created_at)}</small></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div>
                <div className="panel">
                  <h2>Orders <small>{d?.orders.length ?? 0}{d?.orders.length === 30 ? " (latest 30)" : ""}</small></h2>
                  <div className="tblwrap">
                    <table>
                      <tbody>
                        {d?.orders.length === 0 && <tr><td className="mut">No orders.</td></tr>}
                        {d?.orders.map((o) => (
                          <tr key={o.id}>
                            <td className={`stripe ${o.service_type}`}><Link className="lk" href={`/nws/orders/${o.id}`}>{orderNo(o.order_no)}</Link><small style={{ display: "block" }}>{fmtDate(o.created_at)}</small></td>
                            <td>{o.gallons.toLocaleString()} gal</td>
                            <td><St tone={STATUS_TEXT[o.status][1]}>{STATUS_TEXT[o.status][0]}</St></td>
                            <td className="num">{n3(o.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="panel">
                  <h2>Wallet transactions <small>balance {omr3(wallet)}</small></h2>
                  <div className="tblwrap">
                    <table>
                      <tbody>
                        {d?.tx.length === 0 && <tr><td className="mut">No wallet activity.</td></tr>}
                        {d?.tx.map((t) => (
                          <tr key={t.id}>
                            <td><small>{fmtDateTime(t.created_at)}</small></td>
                            <td>{t.kind.replace(/_/g, " ")}<small style={{ display: "block" }}>{t.memo}</small></td>
                            <td className="num" style={{ color: Number(t.amount) < 0 ? "var(--bad)" : "var(--ok)" }}>
                              {Number(t.amount) > 0 ? "+" : ""}
                              {n3(t.amount)}
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
          title={`Goodwill credit for ${c.full_name}`}
          body="Adds 2.000 OMR to the customer's wallet."
          confirm="Add 2.000 OMR"
          onCancel={() => setDlg(null)}
          onConfirm={(r) => act("goodwill", r, "2.000 OMR goodwill credit added", 2)}
        />
      )}
      {dlg === "block" && c && (
        <ReasonDialog
          title={c.account_blocked ? `Unblock ${c.full_name}` : `Block ${c.full_name}`}
          body={c.account_blocked ? "The customer can place orders again." : "The customer can't place new orders until unblocked."}
          confirm={c.account_blocked ? "Unblock" : "Block account"}
          danger={!c.account_blocked}
          onCancel={() => setDlg(null)}
          onConfirm={(r) => act(c.account_blocked ? "unblock" : "block", r, c.account_blocked ? "Account unblocked" : "Account blocked")}
        />
      )}
      {dlg === "verify" && c && (
        <ReasonDialog
          title={`Verify ID for ${c.full_name}`}
          body="Confirm the ID was checked against the original document or the ROP record."
          confirm="Mark verified"
          onCancel={() => setDlg(null)}
          onConfirm={(r) => act("verify_id", r, "ID marked as verified")}
        />
      )}
    </>
  );
}

function OrgsTab({ orgs, use, reload }: { orgs: Org[] | null; use: Map<string, { used: number; overdue: number; uninvoiced: number }>; reload: () => Promise<void> }) {
  const { can } = useStaff();
  const run = useRpc();
  const [dlg, setDlg] = useState<{ org: Org; action: "raise_limit" | "pause" | "resume" | "activate" | "invoice" } | null>(null);
  const fin = can("finance", "admin");
  const title = fin ? undefined : "Finance and admins only";
  const TEXT = {
    raise_limit: ["Raise credit limit by 500.000 OMR", "Raise limit", "Credit limit raised"],
    pause: ["Pause orders", "Pause orders", "Orders paused"],
    resume: ["Resume orders", "Resume orders", "Orders resumed"],
    activate: ["Activate account", "Activate", "Account activated"],
    invoice: ["Invoice now", "Issue invoice", "Invoice issued"],
  } as const;

  return (
    <div className="panel">
      <h2>
        Corporate and government accounts <small>credit terms, invoicing cycles and overdue balances</small>
      </h2>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Segment</th>
              <th>Status</th>
              <th className="num">Credit limit</th>
              <th className="num">Used</th>
              <th>Terms</th>
              <th>Invoicing</th>
              <th className="num">Overdue</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {!orgs && <tr><td colSpan={9} className="empty">Loading…</td></tr>}
            {orgs?.length === 0 && <tr><td colSpan={9} className="empty">No business accounts yet.</td></tr>}
            {orgs?.map((o) => {
              const u = use.get(o.id) ?? { used: 0, overdue: 0, uninvoiced: 0 };
              const over = u.used > Number(o.credit_limit);
              return (
                <tr key={o.id}>
                  <td><b>{o.name}</b><small style={{ display: "block" }}>CR {o.cr_no}</small></td>
                  <td>{SEG_LABEL[o.segment] ?? o.segment}</td>
                  <td>
                    <St tone={ORG_TONE[o.status]}>{o.status[0].toUpperCase() + o.status.slice(1)}</St>
                    {o.paused && <St tone="bad">Orders paused</St>}
                  </td>
                  <td className="num">{n3(o.credit_limit)}</td>
                  <td className="num" style={over ? { color: "var(--bad)" } : undefined}>{n3(u.used)}</td>
                  <td>Net {o.terms_days} days</td>
                  <td>{o.invoicing === "weekly" ? "Weekly" : "Monthly"}</td>
                  <td className="num">{u.overdue > 0 ? <span style={{ color: "var(--bad)" }}>{n3(u.overdue)}</span> : "—"}</td>
                  <td>
                    <div className="btns" style={{ flexWrap: "nowrap" }}>
                      <button className="btn sm" disabled={!fin} title={title} onClick={() => setDlg({ org: o, action: "raise_limit" })}>Raise limit +500</button>
                      <button className={`btn sm ${o.paused ? "" : "bad"}`} disabled={!fin} title={title} onClick={() => setDlg({ org: o, action: o.paused ? "resume" : "pause" })}>
                        {o.paused ? "Resume orders" : "Pause orders"}
                      </button>
                      {o.status !== "active" && (
                        <button className="btn sm pri" disabled={!fin} title={title} onClick={() => setDlg({ org: o, action: "activate" })}>Activate</button>
                      )}
                      <button className="btn sm" disabled={!fin || u.uninvoiced <= 0} title={!fin ? title : u.uninvoiced <= 0 ? "No uninvoiced account orders" : undefined} onClick={() => setDlg({ org: o, action: "invoice" })}>
                        Invoice now
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="note">Used = uninvoiced account orders plus unpaid invoices. Invoices go to the account&apos;s admin and finance members.</p>
      {dlg && (
        <ReasonDialog
          title={`${TEXT[dlg.action][0]} — ${dlg.org.name}`}
          confirm={TEXT[dlg.action][1]}
          danger={dlg.action === "pause"}
          onCancel={() => setDlg(null)}
          onConfirm={async (r) => {
            if (await run("staff_org_action", { p_org_id: dlg.org.id, p_action: dlg.action, p_reason: r, p_amount: dlg.action === "raise_limit" ? 500 : null }, TEXT[dlg.action][2])) {
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
  const [f, setF] = useState("all");
  const list = (contracts ?? []).filter((k) => f === "all" || k.status === f);
  return (
    <div className="panel">
      <div className="toolbar">
        <div className="chips">
          {["all", "active", "pending_owner", "paused", "ended", "declined"].map((k) => (
            <button key={k} className={`chip ${f === k ? "on" : ""}`} onClick={() => setF(k)}>
              {k === "all" ? "All" : CONTRACT_LABEL[k]}
              <span className="tc">{(contracts ?? []).filter((x) => k === "all" || x.status === k).length}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>Contract</th>
              <th>Customer</th>
              <th>Tanker company</th>
              <th>Property</th>
              <th>Service</th>
              <th>Frequency</th>
              <th>Term</th>
              <th className="num">Monthly</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {!contracts && <tr><td colSpan={9} className="empty">Loading…</td></tr>}
            {contracts && list.length === 0 && <tr><td colSpan={9} className="empty">No contracts.</td></tr>}
            {list.map((k) => {
              const p = one(k.property);
              return (
                <tr key={k.id}>
                  <td className={`stripe ${k.service_type}`}><b>CT-{k.contract_no}</b></td>
                  <td>{one(k.customer)?.full_name || one(k.org)?.name || "—"}{one(k.org) && <small style={{ display: "block" }}>Business account</small>}</td>
                  <td>{one(k.company)?.name ?? "—"}</td>
                  <td>{p ? <>{p.label}<small style={{ display: "block" }}>{p.area}</small></> : "—"}</td>
                  <td><span className={`tag ${k.service_type}`}>{k.service_type}</span> {k.gallons.toLocaleString()} gal</td>
                  <td>{k.frequency[0].toUpperCase() + k.frequency.slice(1)} · {k.slot}<small style={{ display: "block" }}>{k.plan} plan</small></td>
                  <td><small>{fmtDate(k.start_date)} – {fmtDate(k.end_date)}</small></td>
                  <td className="num">{n3(k.monthly_est)}</td>
                  <td><St tone={CONTRACT_TONE[k.status]}>{CONTRACT_LABEL[k.status] ?? k.status}</St></td>
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
  const now = useNow(30_000);
  return (
    <div className="panel">
      <h2>
        Notifications sent <small>push, SMS and WhatsApp · latest 200</small>
      </h2>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Event</th>
              <th>Channels</th>
              <th>Recipient</th>
              <th>Message</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {!notifs && <tr><td colSpan={6} className="empty">Loading…</td></tr>}
            {notifs?.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  No notifications visible. Staff can only read notifications once the database grants a staff read policy on the notifications table.
                </td>
              </tr>
            )}
            {notifs?.map((n) => (
              <tr key={n.id}>
                <td><small>{fmtDateTime(n.created_at)}</small></td>
                <td>{n.event.replace(/_/g, " ")}</td>
                <td>{n.channels.map((c) => (c === "sms" ? "SMS" : c === "whatsapp" ? "WhatsApp" : c[0].toUpperCase() + c.slice(1))).join(", ")}</td>
                <td>{one(n.user)?.full_name || "—"}</td>
                <td>{n.title}</td>
                <td>{n.read_at ? <St tone="ok">Read</St> : <St tone={now - Date.parse(n.created_at) > 86_400_000 ? "" : "act"}>Delivered</St>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">SMS and WhatsApp are simulated in the pilot: messages are logged here, not sent.</p>
    </div>
  );
}
