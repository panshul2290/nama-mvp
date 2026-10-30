// GET /api/v1/permits (scope permits:read).
import { callApi, num, qp } from "@/lib/api/server";

export async function GET(req: Request) {
  const q = qp(req);
  return callApi(req, "/api/v1/permits", "api_v1_permits", {
    p_status: q.get("status"), p_expiring_days: num(q.get("expiring_days")), p_limit: num(q.get("limit")), p_cursor: q.get("cursor"),
  });
}
