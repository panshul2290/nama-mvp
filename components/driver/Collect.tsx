"use client";

// "Collect: X OMR" or "Paid in app — collect nothing", with "Price set by Nama — you can't
// change it" (0034). Shown on the job offer, the trip screen and the proof of delivery.
import { DICT, useFmt } from "@/components/driver/i18n";
import { Icon } from "@/components/icons";
import { useT } from "@/lib/i18n";
import type { Order } from "@/lib/types";

/** What the driver collects at the door, as public.order_collect_omr(): cash on delivery only. */
export function collectFromOrder(o: Pick<Order, "pay_method" | "billing" | "payment_status" | "total" | "short_credit">): number {
  if (o.pay_method !== "cash" || (o.billing ?? "prepaid") !== "prepaid" || o.payment_status !== "authorized") return 0;
  return Math.round((Number(o.total) - Number(o.short_credit ?? 0)) * 1000) / 1000;
}

/** amount: OMR to collect (0 = paid in the app); undefined when the server didn't say (older database). */
export function CollectBox({ amount, compact = false }: { amount: number | string | null | undefined; compact?: boolean }) {
  const t = useT(DICT);
  const f = useFmt();
  if (amount == null || amount === "") return null;
  const n = Number(amount);
  const cash = n > 0;
  return (
    <div className={`d-collect ${cash ? "cash" : "paid"} ${compact ? "compact" : ""}`} role="note">
      <Icon name="coins" />
      <span>
        <b>{cash ? t("collectT", { amt: f.omr(n) }) : t("paidInApp")}</b>
        {!compact && <small>{cash ? t("collectCash") : t("paidInAppS")}</small>}
        <small className="d-collect-lock">{t("priceSetByNama")}</small>
      </span>
    </div>
  );
}
