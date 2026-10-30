// How the customer app names an order's stage (kept free of React so it can be unit-tested).
import type { Order } from "@/lib/types";

export type TagOrder = Pick<Order, "status" | "service_type" | "payment_status"> & { filled_at?: string | null };

/**
 * A DW/TE tanker goes to the filling station first. The first GPS fix after accepting already makes
 * the order 'arriving', so until the fill is confirmed it is "assigned, filling", not "on the way".
 */
export const fillPending = (o: TagOrder) => o.service_type !== "WW" && (o.status === "accepted" || o.status === "arriving") && !o.filled_at;

/** Translation key for the order's status as the customer sees it. */
export const statusKey = (o: TagOrder) =>
  o.status === "cancelled" && o.payment_status === "failed"
    ? "st_payfail"
    : o.status === "delivered" && o.service_type === "WW"
      ? "st_completed"
      : fillPending(o)
        ? "st_accepted"
        : `st_${o.status}`;
