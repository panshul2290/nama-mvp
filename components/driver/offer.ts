// "New job for you". With auto-dispatch (0026) the server offers a job to one tanker at a time
// until offer_expires_at; that offer comes first. Otherwise: the newest open job, offered for
// 60 s from when this device first saw it.
import type { OpenRequest } from "@/lib/types";

export const OFFER_S = 60;

/** open_requests_near rows from 0026 on. */
export type OfferRow = OpenRequest & { offer_expires_at?: string | null; fee_factors?: Record<string, unknown> | null };
export type Offer = { job: OfferRow; left: number; server: boolean };

export function pickOffer(jobs: OfferRow[], seenAt: Record<string, number>, now: number): Offer | null {
  if (!now) return null;
  const mine = jobs
    .filter((j) => j.offer_expires_at && Date.parse(j.offer_expires_at) > now)
    .sort((a, b) => Date.parse(a.offer_expires_at as string) - Date.parse(b.offer_expires_at as string))[0];
  if (mine) return { job: mine, left: Math.max(1, Math.ceil((Date.parse(mine.offer_expires_at as string) - now) / 1000)), server: true };
  const fresh = jobs.filter((j) => !j.offer_expires_at && seenAt[j.id] && now - seenAt[j.id] < OFFER_S * 1000);
  if (!fresh.length) return null;
  const job = fresh.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  return { job, left: Math.max(1, Math.ceil((OFFER_S * 1000 - (now - seenAt[job.id])) / 1000)), server: false };
}

export type FeeFactorKey = "distance" | "demand" | "peak" | "priority";

/** The fee multipliers worth showing on an offer (those that aren't × 1). */
export function feeFactorList(f: Record<string, unknown> | null | undefined): [FeeFactorKey, number][] {
  if (!f) return [];
  const out: [FeeFactorKey, number][] = [];
  for (const [k, key] of [["distance_mult", "distance"], ["demand_mult", "demand"], ["peak_mult", "peak"], ["priority_mult", "priority"]] as const) {
    const v = Number(f[k]);
    if (Number.isFinite(v) && v > 0 && Math.abs(v - 1) > 0.0005) out.push([key, v]);
  }
  return out;
}
