// GET /api/v1/orders (scope orders:read). No customer identity or exact location.
import { callApi, num, qp } from "@/lib/api/server";

export async function GET(req: Request) {
  const q = qp(req);
  return callApi(req, "/api/v1/orders", "api_v1_orders", {
    p_since: q.get("since"), p_status: q.get("status"), p_limit: num(q.get("limit")), p_cursor: q.get("cursor"), p_include_test: q.get("include_test") === "true",
  });
}
