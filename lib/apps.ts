// The five apps on this site and which one a page belongs to. Each app keeps its own
// Supabase session (its own auth cookie), so one browser can be signed in to NWS,
// Company, Business and the customer app at once, each with a different account.
// Pure functions: used by the browser client, the proxy, the auth callback and tests.
import type { Role } from "./types";

export type AppKey = "nws" | "customer" | "business" | "driver" | "company";
export const APP_KEYS: AppKey[] = ["nws", "customer", "business", "driver", "company"];
export const asApp = (v: string | null | undefined): AppKey | null => (APP_KEYS.includes(v as AppKey) ? (v as AppKey) : null);

/** Desktop (web) apps get the full-screen sign-in; the phone apps keep the in-frame one. */
export const isDesktopApp = (a: AppKey | null) => a === "nws" || a === "business" || a === "company";

/** The app each role signs in to. */
export const appFor = (role: Role): AppKey =>
  role === "nws_staff" ? "nws" : role === "owner" ? "company" : role === "business" ? "business" : role === "driver" ? "driver" : "customer";

/** Where each role lands after signing in. */
export function homeFor(role: Role | null | undefined, hasTanker = false): string {
  switch (role) {
    case "nws_staff":
      return "/nws";
    case "owner":
      return "/company";
    case "business":
      return "/business";
    case "driver":
      return hasTanker ? "/driver" : "/onboarding";
    case "customer":
      return "/customer";
    default:
      return "/login";
  }
}

/** An app's own home (the driver app sends drivers without a tanker on to /onboarding itself). */
export const appHome = (app: AppKey) => `/${app}`;

// Each app's pages. /onboarding is the driver app's first-run screen.
const AREAS: [string, AppKey][] = [
  ["/nws", "nws"],
  ["/company", "company"],
  ["/business", "business"],
  ["/customer", "customer"],
  ["/driver", "driver"],
  ["/onboarding", "driver"],
];
/** Sign-in pages shared by all apps: they name the app with ?app=. */
export const AUTH_PATHS = ["/login", "/login/reset", "/signup", "/switch", "/auth/callback"];

const trim = (path: string) => path.replace(/\/+$/, "") || "/";

/** The app whose pages live under this path (/nws/…, /driver/…), or null. */
export function areaApp(path: string): AppKey | null {
  const p = trim(path);
  return AREAS.find(([prefix]) => p === prefix || p.startsWith(`${prefix}/`))?.[1] ?? null;
}

/**
 * The app a page belongs to: a one-app build (the Android APKs, NEXT_PUBLIC_APP_TARGET)
 * is always its own app; otherwise the path prefix, or ?app= on the shared sign-in pages.
 * Null for the launcher and for sign-in pages opened without ?app=.
 */
export function appForPage(path: string, search: string | URLSearchParams = "", target?: string | null): AppKey | null {
  const fixed = asApp(target);
  if (fixed) return fixed;
  const area = areaApp(path);
  if (area) return area;
  if (!AUTH_PATHS.includes(trim(path))) return null;
  return asApp(new URLSearchParams(search).get("app"));
}

/** Auth cookie (and storage key) per app. Pages without an app use a shared one that never keeps a session. */
export const SHARED_COOKIE = "sb-nama";
export const cookieNameFor = (app: AppKey | null) => (app ? `sb-nama-${app}` : SHARED_COOKIE);

/** The single-cookie session from before per-app sessions (sb-<project>-auth-token…): cleared once. */
export const isLegacyAuthCookie = (name: string) => /^sb-(?!nama(-|$|\.))[A-Za-z0-9]+-auth-token/.test(name);
