// POST /api/v1/notifications/claim (scope notify:send). A gateway worker takes queued
// messages of a channel set to "External gateway" (lib/notify/worker.ts).
import { body, callApi } from "@/lib/api/server";

export async function POST(req: Request) {
  const b = await body<{ channel?: string; limit?: number }>(req);
  if (!b.ok) return b.response;
  return callApi(req, "/api/v1/notifications/claim", "api_v1_notifications_claim", { p_channel: b.value.channel ?? null, p_limit: b.value.limit ?? 50 });
}
