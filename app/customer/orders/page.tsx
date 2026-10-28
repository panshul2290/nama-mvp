"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useCustomer } from "@/components/CustomerContext";
import { useCx } from "@/components/customer/i18n";
import { ddate, dshort, gal, omr3, windowText } from "@/components/customer/fmt";
import { useProperties } from "@/components/customer/hooks";
import { StatusTag } from "@/components/customer/ui";
import { Loading } from "@/components/Shell";
import { useToast } from "@/components/useToast";
import { friendlyError } from "@/lib/errors";
import { localDigits } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { ACTIVE_STATUSES, ref, type Company, type Contract, type Order } from "@/lib/types";

type Tab = "active" | "sched" | "past" | "contracts";
const TABS: Tab[] = ["active", "sched", "past", "contracts"];
const CT_TONE: Record<Contract["status"], string> = { pending_owner: "warn", active: "ok", paused: "warn", ended: "", declined: "bad" };

export default function OrdersPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Orders />
    </Suspense>
  );
}

function Orders() {
  const profile = useCustomer();
  const { t, lang } = useCx();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const tab: Tab = TABS.includes(params.get("tab") as Tab) ? (params.get("tab") as Tab) : "active";
  const [pf, setPf] = useState("all");
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [contracts, setContracts] = useState<Contract[] | null>(null);
  const [companies, setCompanies] = useState<Record<string, Company>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const { props } = useProperties(profile.id);

  useEffect(() => {
    supabase()
      .from("orders")
      .select("*")
      .eq("customer_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(100)
      .then(({ data }) => setOrders((data ?? []) as Order[]));
  }, [profile.id]);

  const loadContracts = useCallback(() => {
    const db = supabase();
    db.from("contracts")
      .select("*")
      .eq("customer_id", profile.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => setContracts((data ?? []) as Contract[]));
    db.from("companies")
      .select("id, name, rating, since")
      .then(({ data }) => setCompanies(Object.fromEntries(((data ?? []) as Company[]).map((c) => [c.id, c]))));
  }, [profile.id]);
  useEffect(() => {
    loadContracts();
  }, [loadContracts]);

  async function act(c: Contract, action: "pause" | "resume" | "end") {
    if (action === "end" && !window.confirm(t("endConfirm"))) return;
    setBusy(c.id);
    const { data, error } = await supabase().rpc("contract_set_status", { p_contract_id: c.id, p_action: action }).single<Contract>();
    setBusy(null);
    if (error || !data) return toast.show(friendlyError(error));
    setContracts((list) => (list ?? []).map((x) => (x.id === data.id ? data : x)));
  }

  const propLabel = (id: string | null | undefined) => props?.find((p) => p.id === id)?.label;
  const mine = (orders ?? []).filter((o) => pf === "all" || o.property_id === pf);
  const list =
    tab === "active"
      ? mine.filter((o) => ACTIVE_STATUSES.includes(o.status) || o.status === "pending_approval")
      : tab === "sched"
        ? mine.filter((o) => o.status === "scheduled").sort((a, b) => (a.slot_start ?? "").localeCompare(b.slot_start ?? ""))
        : mine.filter((o) => o.status === "delivered" || o.status === "cancelled");

  return (
    <main className="screen">
      <div className="ptop">
        <h3>{t("tOrders")}</h3>
      </div>
      <div className="seg" role="tablist">
        {TABS.map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? "on" : ""}
            onClick={() => router.replace(k === "active" ? "/customer/orders" : `/customer/orders?tab=${k}`)}
          >
            {t(k === "sched" ? "sched" : k)}
          </button>
        ))}
      </div>

      {tab === "contracts" ? (
        <>
          <Link href="/customer/contract" className="cta">
            {t("newContract")}
          </Link>
          {contracts === null ? (
            <div className="empty">{t("loading")}</div>
          ) : contracts.length === 0 ? (
            <div className="empty">{t("noContracts")}</div>
          ) : (
            contracts.map((c) => (
              <div key={c.id} className="card">
                <div className="row">
                  <h4>{ref.contract(c.contract_no)}</h4>
                  <span className={`st ${CT_TONE[c.status]}`}>{t(`ct_${c.status}`)}</span>
                </div>
                <p>
                  {t(`${c.service_type}q`)} · {gal(c.gallons, lang)} · {t(`fq_${c.frequency}`)} · {t(c.slot === "evening" ? "slotEve" : "slotMorn")}
                  <br />
                  {propLabel(c.property_id) ?? ""} · {companies[c.company_id]?.name ?? ""}
                  <br />
                  {omr3(c.monthly_est, lang)} {t("perMonth")} · {ddate(c.start_date, lang)} – {ddate(c.end_date, lang)}
                </p>
                {c.status === "pending_owner" && <p className="small mut" style={{ marginTop: 6 }}>{t("ctPending")}</p>}
                {(c.status === "active" || c.status === "paused" || c.status === "pending_owner") && (
                  <div className="btns" style={{ marginTop: 10 }}>
                    {c.status !== "pending_owner" && (
                      <button className="btn sm" disabled={busy === c.id} onClick={() => act(c, c.status === "paused" ? "resume" : "pause")}>
                        {t(c.status === "paused" ? "resume" : "pause")}
                      </button>
                    )}
                    <button className="btn sm bad" disabled={busy === c.id} onClick={() => act(c, "end")}>
                      {t("endCt")}
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </>
      ) : (
        <>
          {props && props.length > 0 && (
            <div className="opts" style={{ marginBottom: 12 }}>
              <button className={`opt ${pf === "all" ? "on" : ""}`} onClick={() => setPf("all")}>
                {t("allProps")}
              </button>
              {props.map((p) => (
                <button key={p.id} className={`opt ${pf === p.id ? "on" : ""}`} onClick={() => setPf(p.id)}>
                  {p.label}
                </button>
              ))}
            </div>
          )}
          {orders === null ? (
            <div className="empty">{t("loading")}</div>
          ) : list.length === 0 ? (
            <div className="empty">
              {t("none")}
              <br />
              <br />
              <Link href="/customer/request" className="btn pri">
                {t("reqTanker")}
              </Link>
            </div>
          ) : (
            list.map((o) => (
              <Link key={o.id} href={`/customer/order?id=${o.id}`} className="card">
                <div className="row">
                  <h4>{ref.order(o.order_no)}</h4>
                  <StatusTag order={o} />
                </div>
                <p>
                  {t(`${o.service_type}q`)} · {gal(o.gallons, lang)} · {propLabel(o.property_id) || o.area}
                  <br />
                  {o.status === "scheduled" ? windowText(o.slot_start, o.slot_end, lang) : dshort(o.created_at, lang)} · {omr3(o.total, lang)}
                  {o.rating ? ` · ${localDigits(o.rating, lang)}★` : ""}
                  {o.contract_id ? ` · ${t("contractTag")}` : ""}
                </p>
              </Link>
            ))
          )}
        </>
      )}
      {toast.node}
    </main>
  );
}
