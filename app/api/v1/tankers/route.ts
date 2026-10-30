// GET /api/v1/tankers (scope tankers:read).
import { callApi, num, qp } from "@/lib/api/server";

export async function GET(req: Request) {
  const q = qp(req);
  return callApi(req, "/api/v1/tankers", "api_v1_tankers", { p_limit: num(q.get("limit")), p_cursor: q.get("cursor") });
}
