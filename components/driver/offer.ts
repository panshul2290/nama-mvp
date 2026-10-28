// "New job for you": the newest open job, offered for 60 s from when this device first saw it.
import type { OpenRequest } from "@/lib/types";

export const OFFER_S = 60;

export function pickOffer(jobs: OpenRequest[], seenAt: Record<string, number>, now: number): { job: OpenRequest; left: number } | null {
  if (!now) return null;
  const fresh = jobs.filter((j) => seenAt[j.id] && now - seenAt[j.id] < OFFER_S * 1000);
  if (!fresh.length) return null;
  const job = fresh.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  return { job, left: Math.max(1, Math.ceil((OFFER_S * 1000 - (now - seenAt[job.id])) / 1000)) };
}
