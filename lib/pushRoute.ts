// Where a tapped push notification opens (lib/push.ts). Pure, unit-tested in tests/unit/recommend.test.ts.

/** The data a push carries (set by the sender): where a tap should go. */
export type PushData = { route?: string; order_id?: string; event?: string; kind?: string };

/** Where a tapped notification opens, for each app. Pure. */
export function pushRoute(app: "customer" | "driver", d: PushData | null | undefined): string {
  if (!d) return app === "customer" ? "/customer/inbox" : "/driver/notifications";
  if (d.route && d.route.startsWith(`/${app}`)) return d.route;
  const ev = d.event ?? d.kind ?? "";
  if (app === "customer") {
    if (ev === "data_export_ready") return "/customer/account#data";
    if (d.order_id) return `/customer/order?id=${encodeURIComponent(d.order_id)}${ev === "new_message" ? "&chat=1" : ""}`;
    return "/customer/inbox";
  }
  if (ev === "new_job" || ev === "job_offer" || ev === "job_offered") return "/driver/jobs";
  if (ev === "fill_credit_low" || ev === "insufficient_fill_credit") return "/driver/earnings#fill";
  if (d.order_id || ev === "new_message" || ev === "job_assigned") return "/driver/trip";
  return "/driver/notifications";
}

