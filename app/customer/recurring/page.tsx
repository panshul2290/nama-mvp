"use client";

// Recurring orders (0044): regular deliveries for a farm or villa without a tanker-company
// contract. Each delivery becomes a normal order 12 hours before its window, priced then at the
// tariff of the day; the customer is told the day before and can skip it or pause the plan.
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useCustomer } from "@/components/CustomerContext";
import { useDeliveryWindows, usePaymentMethods, useProperties } from "@/components/customer/hooks";
import { useCx } from "@/components/customer/i18n";
import { gal } from "@/components/customer/fmt";
import { windowsFromRows } from "@/components/customer/slots";
import { BackButton, Loading } from "@/components/Shell";
import { useToast } from "@/components/useToast";
import { friendlyError } from "@/lib/errors";
import { VOLUME_PRESETS, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { omanToday } from "@/lib/time";

type Plan = {
  id: string; plan_no: number; property_id: string | null; area: string; service_type: ServiceType; gallons: number; every_n: number; unit: "days" | "weeks";
  window_from: string; window_to: string; start_on: string; end_on: string | null; max_count: number | null; created_count: number;
  pay_method: string; card_last4: string | null; status: "active" | "paused" | "ended"; last_error: string | null;
};
type Row = { plan: Plan; next_on: string | null; next_state: string | null; next_order: string | null };
const TYPES: ServiceType[] = ["DW", "TE", "WW"];
const WINDOWS = [["08:00", "10:00"], ["10:00", "12:00"], ["16:00", "18:00"], ["18:00", "20:00"]];

export default function RecurringPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Recurring />
    </Suspense>
  );
}

function Recurring() {
  const profile = useCustomer();
  const { t, n } = useCx();
  const params = useSearchParams();
  const toast = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [form, setForm] = useState(params.get("new") === "1");
  const load = useCallback(
    () =>
      supabase()
        .rpc("my_recurring_orders")
        .then(({ data }) => setRows((data ?? []) as Row[])),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  async function act(id: string, action: string) {
    const { error } = await supabase().rpc("recurring_action", { p_id: id, p_action: action });
    if (error) return toast.show(friendlyError(error));
    toast.show(t(`rc_${action}Done`));
    load();
  }

  return (
    <main className="screen">
      <div className="rq-h">
        <BackButton href="/customer" label={t("back")} />
        <div>
          <h3>{t("recurT")}</h3>
          <small>{t("recurS")}</small>
        </div>
      </div>
      <div className="reco">{t("recurRule")}</div>
      {form ? (
        <PlanForm
          userId={profile.id}
          onDone={() => {
            setForm(false);
            load();
            toast.show(t("recurSaved"));
          }}
          onCancel={() => setForm(false)}
        />
      ) : (
        <button className="cta" onClick={() => setForm(true)}>
          {t("recurNew")}
        </button>
      )}
      <h4 className="ch-sec">{t("recurMine")}</h4>
      {rows === null ? (
        <div className="empty">{t("loading")}</div>
      ) : rows.length === 0 ? (
        <div className="empty">{t("none")}</div>
      ) : (
        rows.map(({ plan: p, next_on, next_state, next_order }) => (
          <div key={p.id} className="card">
            <div className="row">
              <h4 dir="ltr">RP-{p.plan_no}</h4>
              <span className={`st ${p.status === "active" ? "ok" : p.status === "paused" ? "warn" : ""}`}>{t(`rcs_${p.status}`)}</span>
            </div>
            <p className="mut small" style={{ margin: "4px 0" }}>
              {t(p.service_type)} · {gal(p.gallons, "en")} · {p.area}
            </p>
            <p className="small" style={{ margin: "4px 0" }}>
              {t(p.unit === "weeks" ? "recurEveryW" : "recurEveryD", { n: n(p.every_n) })} · <bdi dir="ltr">{p.window_from.slice(0, 5)}–{p.window_to.slice(0, 5)}</bdi>
            </p>
            {next_on && p.status !== "ended" && (
              <p className="small" style={{ margin: "4px 0" }}>
                {t("recurNext", { d: next_on })}
                {next_state === "notified" ? ` · ${t("recurNotified")}` : ""}
                {next_order && (
                  <>
                    {" · "}
                    <Link className="lk" href={`/customer/order?id=${next_order}`}>
                      {t("view")}
                    </Link>
                  </>
                )}
              </p>
            )}
            {p.last_error && <p className="badt small">{t("recurErr")}</p>}
            <div className="btns" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {p.status === "active" && (
                <>
                  <button className="btn sm" onClick={() => act(p.id, "skip")}>
                    {t("recurSkip")}
                  </button>
                  <button className="btn sm" onClick={() => act(p.id, "pause")}>
                    {t("recurPause")}
                  </button>
                </>
              )}
              {p.status === "paused" && (
                <button className="btn sm pri" onClick={() => act(p.id, "resume")}>
                  {t("recurResume")}
                </button>
              )}
              {p.status !== "ended" && (
                <button className="btn sm" onClick={() => act(p.id, "end")}>
                  {t("recurEnd")}
                </button>
              )}
            </div>
          </div>
        ))
      )}
      {toast.node}
    </main>
  );
}

function PlanForm({ userId, onDone, onCancel }: { userId: string; onDone: () => void; onCancel: () => void }) {
  const { t } = useCx();
  const params = useSearchParams();
  const { props } = useProperties(userId);
  const { methods } = usePaymentMethods(userId);
  const windowRows = useDeliveryWindows(2);
  const tomorrow = useMemo(() => {
    const d = new Date(`${omanToday()}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }, []);
  // The windows NWS offers on a normal day (the template); the built-in ones as a fallback.
  const wins = useMemo(() => {
    const w = windowRows && windowRows.length ? windowsFromRows(windowRows as never).map((x) => [x.from, x.to]) : WINDOWS;
    return [...new Map(w.map((x) => [x.join("-"), x])).values()];
  }, [windowRows]);
  const pType = params.get("type") as ServiceType | null;
  const [type, setType] = useState<ServiceType>(pType && TYPES.includes(pType) ? pType : "DW");
  const [gallons, setGallons] = useState(Number(params.get("gallons")) || 3000);
  const [propId, setPropId] = useState<string>(params.get("property") ?? "");
  const [every, setEvery] = useState(1);
  const [unit, setUnit] = useState<"weeks" | "days">("weeks");
  const [win, setWin] = useState(0);
  const [start, setStart] = useState(tomorrow);
  const [endMode, setEndMode] = useState<"count" | "date">("count");
  const [count, setCount] = useState(8);
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = (methods ?? []).find((m) => m.is_default && m.brand !== "OmanNet") ?? (methods ?? []).find((m) => m.brand !== "OmanNet");
  const prop = props?.find((p) => p.id === propId) ?? props?.[0];

  async function save() {
    if (!prop) return;
    setBusy(true);
    setError(null);
    const w = wins[win] ?? WINDOWS[0];
    const { error } = await supabase().rpc("save_recurring_order", {
      p: {
        property_id: prop.id,
        service_type: type,
        gallons,
        every_n: every,
        unit,
        window_from: w[0],
        window_to: w[1],
        start_on: start,
        end_on: endMode === "date" ? end : null,
        max_count: endMode === "count" ? count : null,
        pay_method: "wallet_card",
        card_last4: card?.last4 ?? null,
      },
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    onDone();
  }

  if (props === null) return <div className="empty">{t("loading")}</div>;
  if (props.length === 0)
    return (
      <div className="banner">
        {t("recurNeedProp")}{" "}
        <Link className="lk" href="/customer/account?add=property">
          {t("addProp")}
        </Link>
      </div>
    );
  return (
    <div className="rq-card pad">
      <div className="fld">
        <label htmlFor="rcP">{t("property")}</label>
        <select id="rcP" value={prop?.id ?? ""} onChange={(e) => setPropId(e.target.value)}>
          {props.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="seg" role="tablist" aria-label={t("s1")}>
        {TYPES.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={type === k} className={type === k ? "on" : ""} onClick={() => setType(k)}>
            {t(`${k}q`)}
          </button>
        ))}
      </div>
      <div className="opts" style={{ marginTop: 10 }}>
        {VOLUME_PRESETS[type].map((v) => (
          <button key={v} type="button" className={`opt ${gallons === v ? "on" : ""}`} onClick={() => setGallons(v)}>
            {v.toLocaleString("en-US")}
          </button>
        ))}
      </div>
      <div className="fld" style={{ marginTop: 10 }}>
        <label htmlFor="rcE">{t("recurEvery")}</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input id="rcE" type="number" min={1} max={90} value={every} onChange={(e) => setEvery(Math.max(1, Math.min(90, Math.floor(Number(e.target.value) || 1))))} />
          <select aria-label={t("recurUnit")} value={unit} onChange={(e) => setUnit(e.target.value as "weeks" | "days")}>
            <option value="weeks">{t("recurWeeks")}</option>
            <option value="days">{t("recurDays")}</option>
          </select>
        </div>
      </div>
      <span className="lbl">{t("slot")}</span>
      <div className="opts">
        {wins.map((w, i) => (
          <button key={w.join("-")} type="button" className={`opt ${win === i ? "on" : ""}`} onClick={() => setWin(i)}>
            <bdi dir="ltr">
              {w[0]}–{w[1]}
            </bdi>
          </button>
        ))}
      </div>
      <div className="fld" style={{ marginTop: 10 }}>
        <label htmlFor="rcS">{t("recurStart")}</label>
        <input id="rcS" type="date" min={tomorrow} value={start} onChange={(e) => setStart(e.target.value)} />
      </div>
      <div className="seg" role="tablist" aria-label={t("recurEndBy")}>
        <button type="button" role="tab" aria-selected={endMode === "count"} className={endMode === "count" ? "on" : ""} onClick={() => setEndMode("count")}>
          {t("recurAfter")}
        </button>
        <button type="button" role="tab" aria-selected={endMode === "date"} className={endMode === "date" ? "on" : ""} onClick={() => setEndMode("date")}>
          {t("recurOn")}
        </button>
      </div>
      <div className="fld" style={{ marginTop: 10 }}>
        {endMode === "count" ? (
          <>
            <label htmlFor="rcC">{t("recurCount")}</label>
            <input id="rcC" type="number" min={1} max={500} value={count} onChange={(e) => setCount(Math.max(1, Math.min(500, Math.floor(Number(e.target.value) || 1))))} />
          </>
        ) : (
          <>
            <label htmlFor="rcD">{t("recurEndDate")}</label>
            <input id="rcD" type="date" min={start} value={end} onChange={(e) => setEnd(e.target.value)} />
          </>
        )}
      </div>
      <p className="mut small">{card ? t("recurPay", { l: card.last4 }) : t("recurPayNone")}</p>
      {error && <div className="banner badb">{error}</div>}
      <button className="cta" disabled={busy || (endMode === "date" && !end)} onClick={save}>
        {busy ? t("saving") : t("recurCreate")}
      </button>
      <button className="cta sec" onClick={onCancel}>
        {t("cancel")}
      </button>
    </div>
  );
}
