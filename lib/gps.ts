// Freshness rules shared by the customer's tracking screen.
// Mirrors public.location_stale() (0003_gps_freshness.sql).
export const STALE_AFTER_S = 60;

export function agoText(seconds: number): string {
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${Math.floor(seconds)} s ago`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}
