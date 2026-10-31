// Raw phone numbers are not a selectable column (0049, security review SEC-04): screens select
// profiles.phone_masked, and the full number comes from contact_phones(ids), which gives it only
// to people allowed to call that person (the person, the driver on their job, their company
// owner, their organisation, the NWS roles that phone people) and masked to viewer/finance staff.
import type { SupabaseClient } from "@supabase/supabase-js";

/** id → phone (raw where allowed, masked otherwise) for the given profiles. */
export async function contactPhones(db: SupabaseClient, ids: (string | null | undefined)[]): Promise<Map<string, string | null>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const { data } = await db.rpc("contact_phones", { p_ids: want });
  return new Map(((data ?? []) as { id: string; phone: string | null }[]).map((r) => [r.id, r.phone]));
}

/** Adds `phone` to rows that carry an id (by default `id`). */
export async function withPhones<T extends Record<string, unknown>>(db: SupabaseClient, rows: T[], key: keyof T = "id"): Promise<(T & { phone: string | null })[]> {
  const phones = await contactPhones(db, rows.map((r) => r[key] as string | null));
  return rows.map((r) => ({ ...r, phone: phones.get(r[key] as string) ?? null }));
}
