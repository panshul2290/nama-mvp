// POST /api/v1/notifications/report (scope notify:send): the provider's answer for one message.
import { body, callApi } from "@/lib/api/server";

type Report = { id?: number; ok?: boolean; provider_ref?: string; response?: unknown; error?: string; permanent?: boolean };

export async function POST(req: Request) {
  const b = await body<Report>(req);
  if (!b.ok) return b.response;
  const r = b.value;
  return callApi(req, "/api/v1/notifications/report", "api_v1_notifications_report", {
    p_id: r.id ?? null, p_ok: r.ok ?? false, p_provider_ref: r.provider_ref ?? null, p_response: r.response ?? null, p_error: r.error ?? null, p_permanent: r.permanent ?? false,
  });
}
