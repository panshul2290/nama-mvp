// Display helpers shared by the customer and driver screens.

// Short, human-friendly order reference ("TO-48229") derived from the UUID.
// Display only; the UUID stays the real key.
export function orderCode(id: string): string {
  return `TO-${(parseInt(id.replace(/-/g, "").slice(0, 8), 16) % 90000) + 10000}`;
}

export function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export const firstName = (full: string | null | undefined) => (full ?? "").trim().split(/\s+/)[0] || "there";

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export const kmText = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);

// Rough city driving estimate at ~25 km/h.
export const etaMinutes = (km: number) => Math.max(1, Math.round((km / 25) * 60));

export const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
