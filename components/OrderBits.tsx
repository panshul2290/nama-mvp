import { Icon } from "@/components/icons";
import { hhmm } from "@/lib/format";
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

export function Bill({ quote }: { quote: Quote }) {
  return (
    <div className="bill">
      <div>
        <span>Water charge</span>
        <span>{(quote.water / 1000).toFixed(3)}</span>
      </div>
      <div>
        <span>Delivery fee</span>
        <span>{(quote.fee / 1000).toFixed(3)}</span>
      </div>
      <div>
        <span>VAT 5%</span>
        <span>{(quote.vat / 1000).toFixed(3)}</span>
      </div>
      <div className="tot">
        <span>Total</span>
        <span>{omr(quote.total)}</span>
      </div>
    </div>
  );
}

export function OrderBill({ order }: { order: Order }) {
  return (
    <div className="bill">
      <div>
        <span>Water charge · {order.gallons.toLocaleString()} gal</span>
        <span>{Number(order.water_charge).toFixed(3)}</span>
      </div>
      <div>
        <span>Delivery fee</span>
        <span>{Number(order.delivery_fee).toFixed(3)}</span>
      </div>
      <div>
        <span>VAT 5%</span>
        <span>{Number(order.vat).toFixed(3)}</span>
      </div>
      <div className="tot">
        <span>Total</span>
        <span>{omrValue(order.total)}</span>
      </div>
    </div>
  );
}

export { SERVICE_LABEL };
