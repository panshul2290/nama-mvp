import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { appFor, appHome, asApp, cookieNameFor, SHARED_COOKIE, type AppKey } from "@/lib/apps";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase/env";
import type { Role } from "@/lib/types";

// Landing point for the sign-up confirmation and password-reset emails (PKCE code exchange).
// ?app= names the app that sent the link: its cookie holds the PKCE verifier and gets the
// session. An account of another kind is signed out at once (/login?app=…&wrong=<role>).
// Without ?app= (older links) the session moves to the account's own app.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const app = asApp(searchParams.get("app"));
  // Optional same-site return path (e.g. the password-reset page).
  const next = searchParams.get("next");
  const safeNext = next?.startsWith("/") && !next.startsWith("//") ? next : null;
  const signIn = `${origin}/login${app ? `?app=${app}` : ""}`;
  if (!code) return NextResponse.redirect(signIn);

  const store = await cookies();
  const clientFor = (a: AppKey | null) =>
    createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      cookieOptions: { name: cookieNameFor(a) },
      cookies: {
        encode: "tokens-only",
        getAll: () => store.getAll(),
        setAll: (list) => list.forEach(({ name, value, options }) => store.set(name, value, options)),
      },
    });

  const client = clientFor(app);
  const { data, error } = await client.auth.exchangeCodeForSession(code);
  if (error || !data.session) return NextResponse.redirect(signIn);

  const { data: profile } = await client.from("profiles").select("role").eq("id", data.session.user.id).maybeSingle();
  const role = (profile?.role ?? null) as Role | null;
  if (!role || (app && appFor(role) !== app)) {
    await client.auth.signOut({ scope: "local" });
    return NextResponse.redirect(`${signIn}${app ? "&" : "?"}wrong=${role ?? ""}`);
  }

  const target = app ?? appFor(role);
  if (!app) {
    // Move the session from the shared cookie to the account's own app (without revoking it).
    const { error: moveError } = await clientFor(target).auth.setSession(data.session);
    if (moveError) return NextResponse.redirect(signIn);
    for (const name of [SHARED_COOKIE, `${SHARED_COOKIE}.0`, `${SHARED_COOKIE}.1`]) store.delete(name);
  }
  const to = safeNext === "/login/reset" ? `/login/reset?app=${target}` : (safeNext ?? appHome(target));
  return NextResponse.redirect(`${origin}${to}`);
}
