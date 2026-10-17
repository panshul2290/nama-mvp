import { omr, omrValue, SERVICE_LABEL, type Quote, type ServiceType } from "@/lib/pricing";
import type { Order, OrderStatus } from "@/lib/types";

export const STATUS_TEXT: Record<OrderStatus, [string, "act" | "ok" | "warn" | "bad"]> = {
  requested: ["Finding a tanker", "warn"],
  accepted: ["Driver assigned", "act"],
  arriving: ["On the way", "act"],
  arrived: ["Arrived", "act"],
  delivered: ["Delivered", "ok"],
  cancelled: ["Cancelled", "bad"],
};

export function StatusPill({ status }: { status: OrderStatus }) {
  const [text, tone] = STATUS_TEXT[status];
  return <span className={`st ${tone}`}>{text}</span>;
}

export function TypeTag({ type, long }: { type: ServiceType; long?: boolean }) {
  return <span className={`tag ${type}`}>{long ? SERVICE_LABEL[type] : type}</span>;
}

const hhmm = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;

const STEPS: { key: OrderStatus; label: string; now: string; at: keyof Order }[] = [
  { key: "requested", label: "Requested", now: "Looking for a driver near you", at: "created_at" },
  { key: "accepted", label: "Driver accepted", now: "Driver accepted your request", at: "accepted_at" },
  { key: "arriving", label: "On the way", now: "Tanker is on the way", at: "arriving_at" },
  { key: "arrived", label: "Arrived", now: "Tanker has arrived", at: "arrived_at" },
  { key: "delivered", label: "Delivered", now: "Delivered", at: "delivered_at" },
];

export function Timeline({ order }: { order: Order }) {
  const idx = STEPS.findIndex((s) => s.key === order.status);
  return (
    <ul className="tl">
      {STEPS.map((s, i) => {
        const state = order.status === "delivered" || i < idx ? "done" : i === idx ? "cur" : "";
        const t = hhmm(order[s.at] as string | null);
        return (
          <li key={s.key} className={state}>
            {state === "cur" && order.status !== "delivered" ? s.now : s.label}
            {t && state && <small>{t}</small>}
          </li>
        );
      })}
    </ul>
  );
}

export function PriceLines({ quote, gallons }: { quote: Quote; gallons: number }) {
  return (
    <ul className="lines">
      <li>
        <span>Water · {gallons.toLocaleString()} gal</span>
        <span>{omr(quote.water)}</span>
      </li>
      <li>
        <span>Delivery fee</span>
        <span>{omr(quote.fee)}</span>
      </li>
      <li>
        <span>VAT 5%</span>
        <span>{omr(quote.vat)}</span>
      </li>
      <li className="total">
        <span>Total</span>
        <span>{omr(quote.total)}</span>
      </li>
    </ul>
  );
}

export function OrderPriceLines({ order }: { order: Order }) {
  return (
    <ul className="lines">
      <li>
        <span>Water · {order.gallons.toLocaleString()} gal</span>
        <span>{omrValue(order.water_charge)}</span>
      </li>
      <li>
        <span>Delivery fee</span>
        <span>{omrValue(order.delivery_fee)}</span>
      </li>
      <li>
        <span>VAT 5%</span>
        <span>{omrValue(order.vat)}</span>
      </li>
      <li className="total">
        <span>Total</span>
        <span>{omrValue(order.total)}</span>
      </li>
    </ul>
  );
}
