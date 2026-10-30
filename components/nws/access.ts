// Which NWS staff roles see which section — the prototype's role matrix (Settings → Users and roles),
// adjusted where a role's own database actions live on another screen (an operator issues penalties
// from Permits → Violations; operators run emergency mode, incidents and fraud review).
// UI only: the database enforces every action (require_staff) and admin passes every check.
import type { StaffRole } from "@/lib/types";

const ALL: StaffRole[] = ["admin", "operator", "permit_officer", "inspector", "complaints_agent", "finance", "viewer"];

export const SECTION_ROLES: Record<string, StaffRole[]> = {
  "/nws": ["admin", "operator", "inspector", "viewer"],
  "/nws/orders": ["admin", "operator", "complaints_agent", "finance", "viewer"],
  "/nws/fleet": ["admin", "operator", "permit_officer", "inspector", "viewer"],
  "/nws/permits": ["admin", "operator", "permit_officer", "inspector", "complaints_agent", "viewer"],
  "/nws/customers": ["admin", "operator", "permit_officer", "complaints_agent", "finance", "viewer"],
  "/nws/complaints": ["admin", "operator", "complaints_agent", "viewer"],
  "/nws/reports": ["admin", "operator", "permit_officer", "complaints_agent", "finance", "viewer"],
  // Settings pages (Administration is admin-only in the matrix; Payments is Finance's module).
  "/nws/settings/users": ["admin"],
  "/nws/settings/pricing": ["admin", "finance"],
  "/nws/settings/penalties": ["admin"],
  "/nws/settings/promotions": ["admin", "finance"],
  "/nws/settings/zones": ["admin"],
  "/nws/settings/emergency": ["admin", "operator"],
  "/nws/settings/notifications": ["admin"],
  "/nws/settings/payments": ["admin", "finance"],
  "/nws/settings/fraud": ["admin", "operator", "finance"],
  "/nws/settings/privacy": ["admin"],
  "/nws/settings/audit": ["admin"],
  "/nws/settings/health": ["admin", "operator"],
  // API keys and webhooks are admin-only (RLS); operators run IVMS devices and the simulator.
  "/nws/settings/integrations": ["admin", "operator"],
};

/** The most specific section a path belongs to (order details belong to Orders, and so on). */
function sectionOf(path: string): string | null {
  const keys = Object.keys(SECTION_ROLES).filter((k) => (k === "/nws" ? path === "/nws" : path === k || path.startsWith(k + "/")));
  return keys.sort((a, b) => b.length - a.length)[0] ?? null;
}

export function canSee(role: StaffRole, path: string): boolean {
  if (path === "/nws/settings") return settingsFor(role).length > 0;
  const s = sectionOf(path);
  return s ? (SECTION_ROLES[s] ?? ALL).includes(role) : true;
}

/** The settings pages a role may open, in sub-navigation order. */
export function settingsFor(role: StaffRole): string[] {
  return Object.keys(SECTION_ROLES).filter((k) => k.startsWith("/nws/settings/") && SECTION_ROLES[k].includes(role));
}

/** Where a role lands: the first main section it may open. */
export function homeFor(role: StaffRole): string {
  const order = ["/nws", "/nws/orders", "/nws/permits", "/nws/complaints", "/nws/customers", "/nws/reports"];
  return order.find((p) => canSee(role, p)) ?? settingsFor(role)[0] ?? "/nws/reports";
}

/** Read-only roles get a banner: they can look but not act. */
export const READ_ONLY: StaffRole[] = ["viewer"];
