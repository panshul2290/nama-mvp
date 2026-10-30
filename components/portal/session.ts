"use client";

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { appFor, homeFor, type AppKey } from "@/lib/apps";
import { currentApp, supabase } from "@/lib/supabase/client";
import type { Role } from "@/lib/types";

export { APP_KEYS, appFor, appHome, areaApp, asApp, homeFor, isDesktopApp, type AppKey } from "@/lib/apps";

// "Keep me signed in", per app: when unticked at sign-in, that app's session ends with
// the browser session. Supabase keeps the session in cookies either way, so we remember
// the choice and sign out on the first load of a new browser session.
const EPHEMERAL = "nama.ephemeral";
const ALIVE = "nama.alive";
const key = (base: string, app: AppKey | null) => (app ? `${base}.${app}` : base);

export function rememberSession(keep: boolean, app: AppKey | null = currentApp()) {
  try {
    if (keep) localStorage.removeItem(key(EPHEMERAL, app));
    else localStorage.setItem(key(EPHEMERAL, app), "1");
    sessionStorage.setItem(key(ALIVE, app), "1");
  } catch {
    /* storage blocked: keep the default (stay signed in) */
  }
}

/** Signs this app out if the user asked not to stay signed in and this is a new browser session. */
export async function enforceSessionChoice(app: AppKey | null = currentApp()): Promise<boolean> {
  try {
    if (localStorage.getItem(key(EPHEMERAL, app)) === "1" && sessionStorage.getItem(key(ALIVE, app)) !== "1") {
      await signOutApp(app);
      return true;
    }
    sessionStorage.setItem(key(ALIVE, app), "1");
  } catch {
    /* ignore */
  }
  return false;
}

/** Signs out of one app only: the other apps' sessions in this browser (and on other devices) stay. */
export async function signOutApp(app: AppKey | null = currentApp()) {
  try {
    localStorage.removeItem(key(EPHEMERAL, app));
  } catch {
    /* ignore */
  }
  signingOut = true;
  await supabase(app).auth.signOut({ scope: "local" });
}
let signingOut = false;

/**
 * When this app's session ends without the user signing out (password changed, signed out
 * elsewhere, refresh token expired), go to its sign-in with "your session ended" rather than
 * leaving the page to query as a signed-out visitor.
 */
export function useSessionEnd(signIn: string) {
  const router = useRouter();
  useEffect(() => {
    const { data } = supabase().auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_OUT") return;
      if (signingOut) return void (signingOut = false);
      router.replace(`${signIn}${signIn.includes("?") ? "&" : "?"}ended=1`);
    });
    return () => data.subscription.unsubscribe();
  }, [router, signIn]);
}

export type Admitted = { ok: true; app: AppKey; role: Role; home: string } | { ok: false; wrong: Role | null };

/**
 * After a sign-in on a scratch client (lib/supabase/client.ts): an account that belongs
 * to `app` (or, with no app, to any app) gets its session moved into its app's own
 * cookie; an account of another kind is signed out at once and never touches the app.
 */
export async function admit(app: AppKey | null, scratch: SupabaseClient, session: Session): Promise<Admitted> {
  const { data } = await scratch.from("profiles").select("role").eq("id", session.user.id).maybeSingle();
  const role = (data?.role ?? null) as Role | null;
  if (!role || (app && appFor(role) !== app)) {
    await scratch.auth.signOut({ scope: "local" });
    return { ok: false, wrong: role };
  }
  const target = app ?? appFor(role);
  const db = supabase(target);
  const { error } = await db.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (error) return { ok: false, wrong: null };
  // RLS returns only the tanker currently assigned to this driver.
  const hasTanker = role === "driver" ? Boolean((await db.from("tankers").select("id").maybeSingle()).data) : false;
  return { ok: true, app: target, role, home: homeFor(role, hasTanker) };
}

/** Where the "reset your password" email link lands: the callback signs in to this app, then opens /login/reset. */
export const resetRedirect = (app: AppKey | null) => `${window.location.origin}/auth/callback?${app ? `app=${app}&` : ""}next=/login/reset`;
