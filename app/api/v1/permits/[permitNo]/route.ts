// PATCH /api/v1/permits/{permit_no} (scope permits:write): a TAS-style system's decision.
import { body, callApi } from "@/lib/api/server";

type Patch = { status?: string; reason?: string; expires_at?: string | null };

export async function PATCH(req: Request, ctx: { params: Promise<{ permitNo: string }> }) {
  const { permitNo } = await ctx.params;
  const b = await body<Patch>(req);
  if (!b.ok) return b.response;
  return callApi(req, `/api/v1/permits/${permitNo}`, "api_v1_permit_update", {
    p_permit_no: decodeURIComponent(permitNo), p_status: b.value.status ?? null, p_reason: b.value.reason ?? null, p_expires_at: b.value.expires_at ?? null,
  });
}
