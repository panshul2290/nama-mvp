import { Icon } from "@/components/icons";
import { hhmm } from "@/lib/format";
import { omr, omrValue, ruleNumber, SERVICE_LABEL, type PricingRules, type Quote, type RuleStatus, type ServiceType } from "@/lib/pricing";
import type { Order, OrderStatus } from "@/lib/types";

export const STATUS_TEXT: Record<OrderStatus, [string, "act" | "ok" | "warn" | "bad"]> = {
  requested: ["Finding a tanker", "warn"],
  accepted: ["Driver assigned", "act"],
  arriving: ["On the way", "act"],
  arrived: ["Arrived", "act"],
  delivered: ["Delivered", "ok"],
  cancelled: ["Cancelled", "bad"],
};

export const SERVICE_SHORT: Record<ServiceType, string> = { DW: "Drinking water", WW: "Wastewater", TE: "Treated water" };

export function StatusPill({ status }: { status: OrderStatus }) {
  const [text, tone] = STATUS_TEXT[status];
  return <span className={`st ${tone}`}>{text}</span>;
}

export function TypeTag({ type }: { type: ServiceType }) {
  return <span className={`tag ${type}`}>{SERVICE_SHORT[type]}</span>;
}

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
  return (
    <div className="tlh">
      {STEPS.map((s, i) => {
        const state = i < done ? "done" : i === done && order.status !== "cancelled" ? "cur" : "";
        const t = hhmm(order[s.at] as string | null);
        return (
          <div key={s.key} className={state}>
            <i>{state === "done" && <Icon name="check" />}</i>
            <b>{s.label}</b>
            <small>{t || (state === "cur" ? "now" : "")}</small>
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
  if (!status || status === "confirmed") return null;
  return <span className="st warn ptag">{status === "assumption" ? "Assumption" : "Pending NWS clarification"}</span>;
}

const vatLabel = (rules?: PricingRules | null) => {
  const r = rules ? ruleNumber(rules, "vat_rate") : NaN;
  return Number.isFinite(r) ? `VAT ${Math.round(r * 1000) / 10}%` : "VAT";
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
  return (
    <div className="bill">
      <Line label={`Water charge · ${order.gallons.toLocaleString()} gal`} amount={Number(order.water_charge).toFixed(3)} status={b?.water} />
      <Line label="Delivery fee" amount={Number(order.delivery_fee).toFixed(3)} status={b?.fee} />
      <Line label={vatLabel(rules)} amount={Number(order.vat).toFixed(3)} status={b?.vat} />
      <Line className="tot" label="Total" amount={omrValue(order.total)} status={b?.total} />
    </div>
  );
}

export { SERVICE_LABEL };
