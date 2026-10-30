// The register list (staff_register_tankers, 0033) and the invitation loop, shared by
// Permits → Register, Permits → Campaign and the importer. Everything is filtered and paged
// in the database: no screen holds the ~11,000 register tankers.
import { friendlyError } from "@/lib/errors";
import type { Lang } from "@/lib/i18n";
import type { ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";

export type Stage = "register" | "invited" | "registered" | "applied" | "review" | "permitted";

export type RegFilter = {
  source?: "all" | "register" | "platform" | "register_only";
  cluster?: string;
  governorate?: string;
  service?: "" | ServiceType;
  stage?: "" | Stage | "reached_invited" | "reached_registered" | "reached_applied" | "reached_review" | "not_registered";
  permit?: "" | "valid" | "expiring" | "expired" | "pending" | "none" | "blocked";
  days?: number;
  invite?: "" | "never" | "invited" | "opted_out" | "no_phone";
  q?: string;
  batch?: string;
};

export type RegRow = {
  tanker_id: string; plate: string; service_type: ServiceType; governorate: string | null; cluster: string | null;
  in_register: boolean; on_platform: boolean; capacity_gal: number; capacity_known: boolean; is_online: boolean; blocked: boolean;
  company: string | null; owner_id: string | null; owner_name: string | null; phone: string | null; has_phone: boolean; claimed: boolean;
  invited_at: string | null; invite_count: number; opted_out: boolean;
  register_permit_status: "none" | "in_progress" | "valid" | null; register_permit_no: string | null;
  permit_id: string | null; permit_no: string | null; permit_expires: string | null; permit_valid: boolean;
  pending_id: string | null; pending_no: string | null; pending_stage: string | null; stage: Stage;
};

export type RegKpis = { valid: number; expiring_30: number; blocked: number; pending: number; on_platform: number; register_only: number; capacity_unknown: number };
export type RegPage = { total: number; privileged: boolean; kpis: RegKpis; rows: RegRow[] };

/** English stage names (exports); REG["stage.<stage>"] (components/nws/i18n/register) has the Arabic. */
export const STAGE_LABEL: Record<Stage, string> = {
  register: "In register only",
  invited: "Owner invited",
  registered: "Registered on platform",
  applied: "Permit applied",
  review: "Under review",
  permitted: "Permitted",
};
export const STAGE_TONE: Record<Stage, string> = { register: "", invited: "act", registered: "act", applied: "warn", review: "warn", permitted: "ok" };

/** Drop empty keys so the database sees only real filters. */
export const cleanFilter = (f: RegFilter) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "" && v != null && v !== "all"));

export async function fetchRegister(f: RegFilter, limit: number, offset: number, lang: Lang = "en"): Promise<{ data: RegPage | null; error: string | null }> {
  const { data, error } = await supabase().rpc("staff_register_tankers", { p_filter: cleanFilter(f), p_limit: limit, p_offset: offset });
  return { data: (data as RegPage | null) ?? null, error: error ? friendlyError(error, lang) : null };
}

/** Every matching row in pages of 2,000 (for CSV export), up to `cap`. */
export async function fetchAllRegister(f: RegFilter, cap = 20000, onProgress?: (n: number, total: number) => void, lang: Lang = "en") {
  const rows: RegRow[] = [];
  let total = 0;
  for (let off = 0; off < cap; off += 2000) {
    const { data, error } = await fetchRegister(f, 2000, off, lang);
    if (error || !data) return { rows, total, error: error ?? "No data" };
    total = data.total;
    rows.push(...data.rows);
    onProgress?.(rows.length, total);
    if (rows.length >= total || data.rows.length < 2000) break;
  }
  return { rows, total, error: null as string | null };
}

export type InviteResult = { queued: number; considered: number; daily_left: number; minutes: number; skipped: Record<string, number> };

/** Calls staff_invite_registry_owners until nothing more is queued (≤ 500 per call), or the daily cap. */
export async function inviteLoop(
  // lang: the SMS language; uiLang: the language of the error text shown on screen.
  args: { owners?: string[]; batch?: string; filter?: RegFilter; lang: "en" | "ar"; reason: string; uiLang?: Lang },
  onProgress?: (queued: number) => void,
): Promise<{ queued: number; last: InviteResult | null; skipped: Record<string, number>; error: string | null }> {
  let queued = 0;
  let last: InviteResult | null = null;
  const skipped: Record<string, number> = {};
  const ownerChunks = args.owners ? Array.from({ length: Math.ceil(args.owners.length / 500) }, (_, i) => args.owners!.slice(i * 500, i * 500 + 500)) : [null];
  for (const ids of ownerChunks) {
    for (let guard = 0; guard < 60; guard++) {
      const { data, error } = await supabase().rpc("staff_invite_registry_owners", {
        p_owner_ids: ids, p_batch_id: args.batch ?? null, p_filter: args.filter ? cleanFilter(args.filter) : null, p_lang: args.lang, p_limit: 500, p_reason: args.reason,
      });
      if (error) return { queued, last, skipped, error: friendlyError(error, args.uiLang) };
      last = data as InviteResult;
      queued += last.queued;
      onProgress?.(queued);
      // Owner lists are one call per chunk; batch and filter runs repeat until nothing is left.
      const done = !!ids || last.queued === 0 || last.daily_left === 0;
      if (ids) for (const [k, n] of Object.entries(last.skipped)) skipped[k] = (skipped[k] ?? 0) + n;
      else if (done) {
        // The last pass sees this run's own invitations as "invited recently": leave them out.
        for (const [k, n] of Object.entries(last.skipped)) skipped[k] = k === "cooldown" ? Math.max(0, n - (queued - last.queued)) : n;
      }
      if (done) break;
    }
    if (last && last.daily_left === 0) break;
  }
  return { queued, last, skipped, error: null };
}

/** English skip reasons; REG["skip.<reason>"] has the Arabic. */
export const SKIP_LABEL: Record<string, string> = {
  no_phone: "no mobile number",
  opted_out: "opted out",
  registered: "already on the platform",
  max_invites: "invited the maximum number of times",
  cooldown: "invited recently",
  sms_off: "SMS switched off on their account",
  daily_cap: "over today's limit",
};
