// Driver location sending rules (pure, unit-tested in tests/unit/tracking.test.ts).
import { distanceKm } from "./geo";

export const MAX_ACCURACY_M = 100; // the server rejects worse fixes too
export const MOVING_INTERVAL_MS = 10_000; // send every 10 s while moving…
export const PARKED_INTERVAL_MS = 30_000; // …and at most every 30 s otherwise
export const MOVED_M = 15; // "moving" = more than 15 m from the last sent fix
export const MAX_FIX_AGE_MS = 60_000; // never send a fix older than this

export type Fix = { lat: number; lng: number; accuracy: number; at: number /* epoch ms, device time */ };
export type Sent = { lat: number; lng: number; at: number /* epoch ms, when sent */ };

export const usable = (f: Fix | null, now: number): f is Fix => !!f && f.accuracy <= MAX_ACCURACY_M && now - f.at <= MAX_FIX_AGE_MS;

/** Decide whether to send `fix` now, given the last fix we sent. Called on a 10 s tick. */
export function shouldSend(fix: Fix | null, last: Sent | null, now: number): boolean {
  if (!usable(fix, now)) return false;
  if (!last) return true;
  const movedM = distanceKm(fix, last) * 1000;
  if (movedM > MOVED_M) return now - last.at >= MOVING_INTERVAL_MS - 500; // tolerate timer jitter
  return now - last.at >= PARKED_INTERVAL_MS - 500;
}
