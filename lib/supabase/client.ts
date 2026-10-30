"use client";

import { createBrowserClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { appForPage, cookieNameFor, type AppKey } from "@/lib/apps";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";

// One client per app, each with its own auth cookie (lib/apps.ts), so each app has its
// own session. An APK build is one app (NEXT_PUBLIC_APP_TARGET, set by scripts/build-mobile.mjs).
const TARGET = process.env.NEXT_PUBLIC_APP_TARGET;
const clients = new Map<string, SupabaseClient>();

/** The app of the page being shown (path prefix, or ?app= on the sign-in pages). */
export function currentApp(): AppKey | null {
  if (typeof window === "undefined") return appForPage("/", "", TARGET);
  return appForPage(window.location.pathname, window.location.search, TARGET);
}

/** The Supabase client of this page's app, or of the given app. */
export function supabase(app: AppKey | null = currentApp()): SupabaseClient {
  const name = cookieNameFor(TARGET ? currentApp() : app);
  let client = clients.get(name);
  if (!client) {
    // tokens-only keeps each cookie small (the user object goes to localStorage), so five
    // apps' sessions stay well under the request-header limit. The proxy uses the same.
    client = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, { isSingleton: false, cookieOptions: { name }, cookies: { encode: "tokens-only" } });
    clients.set(name, client);
  }
  return client;
}

/**
 * A throwaway client that keeps its session in memory only. Sign-in, SMS-code checks
 * and sign-up run on it, so an account that belongs to another app never reaches this
 * app's cookie: see admit() in components/portal/session.ts.
 */
export function scratchClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "sb-nama-scratch" },
  });
}
