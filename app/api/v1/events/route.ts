// POST /api/v1/events (scope events:write): TFS station and STP plant meter events.
import { body, callApi } from "@/lib/api/server";

export async function POST(req: Request) {
  const b = await body(req);
  if (!b.ok) return b.response;
  return callApi(req, "/api/v1/events", "api_v1_event", { p_body: b.value });
}
