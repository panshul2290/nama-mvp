"use client";

import { supabase } from "@/lib/supabase/client";
import type { Role } from "@/lib/types";

// "Keep me signed in": when unticked at sign-in, the session ends with the
// browser session. Supabase keeps the session in cookies either way, so we
// remember the choice and sign out on the first load of a new browser session.
const EPHEMERAL = "nama.ephemeral";
const ALIVE = "nama.alive";

export function rememberSession(keep: boolean) {
  try {
    if (keep) localStorage.removeItem(EPHEMERAL);
    else localStorage.setItem(EPHEMERAL, "1");
    sessionStorage.setItem(ALIVE, "1");
  } catch {
    /* storage blocked: keep the default (stay signed in) */
  }
}

/** Signs out if the user asked not to stay signed in and this is a new browser session. */
export async function enforceSessionChoice(): Promise<boolean> {
  try {
    if (localStorage.getItem(EPHEMERAL) === "1" && sessionStorage.getItem(ALIVE) !== "1") {
      localStorage.removeItem(EPHEMERAL);
      await supabase().auth.signOut();
      return true;
    }
    sessionStorage.setItem(ALIVE, "1");
  } catch {
    /* ignore */
  }
  return false;
}

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

export type AppKey = "nws" | "customer" | "business" | "driver" | "company";
export const APP_KEYS: AppKey[] = ["nws", "customer", "business", "driver", "company"];
export const asApp = (v: string | null | undefined): AppKey | null => (APP_KEYS.includes(v as AppKey) ? (v as AppKey) : null);
/** Desktop (web) apps get the full-screen sign-in; the phone apps keep the in-frame one. */
export const isDesktopApp = (a: AppKey | null) => a === "nws" || a === "business" || a === "company";
/** The app each role signs in to. */
export const appFor = (role: Role): AppKey =>
  role === "nws_staff" ? "nws" : role === "owner" ? "company" : role === "business" ? "business" : role === "driver" ? "driver" : "customer";
