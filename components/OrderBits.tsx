import { Icon } from "@/components/icons";
import { hhmm } from "@/lib/format";
import { localDigits, useLang, type Dict, type Lang } from "@/lib/i18n";
import { label } from "@/lib/labels";
import { omanLocale, omanTime } from "@/lib/time";
import { omr, omrValue, ruleNumber, SERVICE_LABEL, type PricingRules, type Quote, type RuleStatus, type ServiceType } from "@/lib/pricing";
import type { Order, OrderStatus } from "@/lib/types";

export const STATUS_TEXT: Record<OrderStatus, [string, "act" | "ok" | "warn" | "bad"]> = {
  scheduled: ["Scheduled", "act"],
  pending_approval: ["Awaiting approval", "warn"],
  requested: ["Finding a tanker", "warn"],
  accepted: ["Driver assigned", "act"],
  arriving: ["On the way", "act"],
  arrived: ["Arrived", "act"],
  collected: ["Collected", "act"],
  delivered: ["Delivered", "ok"],
  cancelled: ["Cancelled", "bad"],
};

export const SERVICE_SHORT: Record<ServiceType, string> = { DW: "Drinking water", WW: "Wastewater", TE: "Treated water" };

/** Status text and tone; a wastewater job that reached "delivered" (discharged) reads "Completed". */
export function statusText(status: OrderStatus, type?: ServiceType, lang: Lang = "en"): [string, "act" | "ok" | "warn" | "bad"] {
  if (status === "delivered" && type === "WW") return [label("order", "completed", lang), "ok"];
  const [en, tone] = STATUS_TEXT[status];
  return [label("order", status, lang, en), tone];
}

export function StatusPill({ status, type }: { status: OrderStatus; type?: ServiceType }) {
  const { lang } = useLang();
  const [text, tone] = statusText(status, type, lang);
  return <span className={`st ${tone}`}>{text}</span>;
}

export function TypeTag({ type }: { type: ServiceType }) {
  const { lang } = useLang();
  return <span className={`tag ${type}`}>{label("svcShort", type, lang, SERVICE_SHORT[type])}</span>;
}

// Bill and tracker wording (the web portals and the apps' price tags).
const BITS: Dict = {
  assumption: { en: "Assumption", ar: "افتراض" },
  pendingNws: { en: "Pending NWS clarification", ar: "بانتظار توضيح نماء" },
  water: { en: "Water charge", ar: "سعر المياه" },
  waterGal: { en: "Water charge · {n} gal", ar: "سعر المياه · {n} جالون" },
  fee: { en: "Delivery fee", ar: "رسوم التوصيل" },
  vat: { en: "VAT", ar: "ضريبة القيمة المضافة" },
  vatPct: { en: "VAT {n}%", ar: "ضريبة القيمة المضافة {n}٪" },
  total: { en: "Total", ar: "الإجمالي" },
};
export { BITS as ORDER_BITS };
const bit = (k: string, lang: Lang, n?: string) => BITS[k][lang].replace("{n}", n ?? "");

const STEPS: { key: OrderStatus; label: string; at: keyof Order }[] = [
  { key: "requested", label: "Requested", at: "created_at" },
  { key: "accepted", label: "Accepted", at: "accepted_at" },
  { key: "arriving", label: "On the way", at: "arriving_at" },
  { key: "arrived", label: "Arrived", at: "arrived_at" },
  { key: "delivered", label: "Delivered", at: "delivered_at" },
];

export function stepIndex(status: OrderStatus) {
  return status === "delivered" ? STEPS.length : STEPS.findIndex((s) => s.key === status) + 1;
}

/** Horizontal 5-step tracker (prototype .tlh). */
export function Stepper({ order }: { order: Order }) {
  const done = stepIndex(order.status); // steps completed so far
  const { lang } = useLang();
  return (
    <div className="tlh">
      {STEPS.map((s, i) => {
        const state = i < done ? "done" : i === done && order.status !== "cancelled" ? "cur" : "";
        const t = lang === "ar" ? omanTime(order[s.at] as string | null, omanLocale(lang)) : hhmm(order[s.at] as string | null);
        return (
          <div key={s.key} className={state}>
            <i>{state === "done" && <Icon name="check" />}</i>
            <b>{label("step", s.key, lang, s.label)}</b>
            <small>{t || (state === "cur" ? label("step", "now", lang) : "")}</small>
          </div>
        );
      })}
    </div>
  );
}

/** 5-segment progress bar for the active-order card. */
export function Progress({ status }: { status: OrderStatus }) {
  const done = stepIndex(status);
  return (
    <span className="seg5" aria-hidden="true">
      {STEPS.map((s, i) => (
        <i key={s.key} className={i < done ? "on" : i === done ? "half" : ""} />
      ))}
    </span>
  );
}

/** Flags a price line that rests on a rule NWS hasn't confirmed. */
export function RuleTag({ status }: { status?: RuleStatus | string | null }) {
  const { lang } = useLang();
  if (!status || status === "confirmed") return null;
  return <span className="st warn ptag">{bit(status === "assumption" ? "assumption" : "pendingNws", lang)}</span>;
}

const vatLabel = (rules?: PricingRules | null, lang: Lang = "en") => {
  const r = rules ? ruleNumber(rules, "vat_rate") : NaN;
  return Number.isFinite(r) ? bit("vatPct", lang, localDigits(Math.round(r * 1000) / 10, lang)) : bit("vat", lang);
};

function Line({ label, amount, status, className }: { label: string; amount: string; status?: string | null; className?: string }) {
  return (
    <div className={className}>
      <span>
        {label} <RuleTag status={status} />
      </span>
      <span>{amount}</span>
    </div>
  );
}

export function Bill({ quote, rules }: { quote: Quote; rules: PricingRules }) {
  const f = (b: number) => (b / 1000).toFixed(3);
  return (
    <div className="bill">
      <Line label="Water charge" amount={f(quote.water)} status={quote.status.water} />
      <Line label="Delivery fee" amount={f(quote.fee)} status={quote.status.fee} />
      <Line label={vatLabel(rules)} amount={f(quote.vat)} status={quote.status.vat} />
      <Line className="tot" label="Total" amount={omr(quote.total)} status={quote.status.total} />
    </div>
  );
}

export function OrderBill({ order, rules }: { order: Order; rules?: PricingRules | null }) {
  const b = order.price_basis;
  const { lang } = useLang();
  const ar = lang === "ar";
  const a3 = (v: number | string) => (ar ? Number(v).toLocaleString("ar-OM", { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : Number(v).toFixed(3));
  return (
    <div className="bill">
      <Line label={bit("waterGal", lang, ar ? order.gallons.toLocaleString("ar-OM") : order.gallons.toLocaleString())} amount={a3(order.water_charge)} status={b?.water} />
      <Line label={bit("fee", lang)} amount={a3(order.delivery_fee)} status={b?.fee} />
      <Line label={vatLabel(rules, lang)} amount={a3(order.vat)} status={b?.vat} />
      <Line className="tot" label={bit("total", lang)} amount={ar ? `${a3(order.total)} ر.ع.` : omrValue(order.total)} status={b?.total} />
    </div>
  );
}

export { SERVICE_LABEL };
