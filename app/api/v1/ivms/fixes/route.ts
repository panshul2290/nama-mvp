// POST /api/v1/ivms/fixes (scope ivms:write). Body: an array of fixes, or { "fixes": [...] }.
import { body, callApi } from "@/lib/api/server";

export async function POST(req: Request) {
  const b = await body<unknown>(req);
  if (!b.ok) return b.response;
  const v = b.value;
  const fixes = Array.isArray(v) ? v : ((v as { fixes?: unknown } | null)?.fixes ?? []);
  return callApi(req, "/api/v1/ivms/fixes", "api_v1_ivms_fixes", { p_fixes: fixes });
}
