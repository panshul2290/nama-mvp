// Integration API v1 (G11/A6): shared plumbing for the route handlers in app/api/v1.
//
// The handlers hold no secret. They call the api_v1_* RPCs with the publishable key and
// no session (the anon role); each RPC checks the caller's API key itself (hash, scope,
// rate limit) and logs the request (0028). Refused or failed calls are logged through
// api_log_failure. Spec: docs/api/openapi.yaml.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase/env";

let client: SupabaseClient | null = null;
function db() {
  client ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return client;
}

/** The API key from "Authorization: Bearer <key>" or "X-Api-Key: <key>". */
export function apiKey(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || null;
  return req.headers.get("x-api-key")?.trim() || null;
}

const STATUS: Record<string, number> = {
  api_unauthorized: 401, api_forbidden: 403, api_rate_limited: 429, not_found: 404,
  invalid_value: 400, reason_required: 400, invalid_state: 409,
};

/** Map a database error to an HTTP status and a stable error code. */
export function statusFor(message: string): { status: number; code: string } {
  const code = message.split(":")[0].trim();
  if (STATUS[code]) return { status: STATUS[code], code };
  if (/^invalid_[a-z_]+$/.test(code)) return { status: 400, code };
  return { status: 500, code: "server_error" };
}

export const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });

/** Run one API RPC for a request; the key is passed as p_key. */
export async function callApi(req: Request, path: string, rpc: string, args: Record<string, unknown>) {
  const key = apiKey(req);
  if (!key) return json({ error: { code: "api_unauthorized", message: "Send the API key as 'Authorization: Bearer <key>'." } }, 401, { "www-authenticate": "Bearer" });
  const { data, error } = await db().rpc(rpc, { p_key: key, ...args });
  if (error) {
    const msg = error.message ?? "";
    const { status, code } = statusFor(msg);
    await db().rpc("api_log_failure", { p_key: key, p_method: req.method, p_path: path, p_status: status, p_error: msg.slice(0, 300) });
    const message = status === 500 ? "Something went wrong; the request was logged." : msg.replace(/^[a-z_]+:\s*/, "");
    return json({ error: { code, message } }, status, status === 429 ? { "retry-after": "60" } : {});
  }
  return json(data);
}

/** Parse a JSON body or answer 400. */
export async function body<T = unknown>(req: Request): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: (await req.json()) as T };
  } catch {
    return { ok: false, response: json({ error: { code: "invalid_value", message: "The body must be JSON." } }, 400) };
  }
}

export const qp = (req: Request) => new URL(req.url).searchParams;
export const num = (v: string | null) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
