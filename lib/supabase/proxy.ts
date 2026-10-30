import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { appForPage, appHome, areaApp, cookieNameFor, isLegacyAuthCookie } from "@/lib/apps";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";

const AUTH_PAGES = ["/login", "/signup"];

// Refreshes the session cookie of the page's app (lib/apps.ts: path prefix, or ?app= on
// the sign-in pages) on every request and does optimistic redirects. Each app has its own
// session, so only that app's cookie counts here. Real authorization is enforced by RLS
// and the RPCs in the database.
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const path = request.nextUrl.pathname;
  const app = appForPage(path, request.nextUrl.search);

  const client = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookieOptions: { name: cookieNameFor(app) },
    cookies: {
      encode: "tokens-only",
      getAll: () => request.cookies.getAll(),
      setAll(cookies) {
        cookies.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data } = await client.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);

  // The one shared session from before per-app sessions: dropped (those users sign in again once).
  const legacy = request.cookies.getAll().filter((c) => isLegacyAuthCookie(c.name));
  const finish = (r: NextResponse) => {
    legacy.forEach((c) => r.cookies.delete(c.name));
    return r;
  };
  const redirectTo = (to: string, withApp?: string | null) => {
    const url = request.nextUrl.clone();
    url.pathname = to;
    url.search = withApp ? `?app=${withApp}` : "";
    const r = NextResponse.redirect(url);
    response.cookies.getAll().forEach((c) => r.cookies.set(c));
    return finish(r);
  };

  const area = areaApp(path);
  if (!signedIn && area) return redirectTo("/login", area);
  // /switch ("signed in with another account") is gone: each app has its own sign-in now.
  if (path === "/switch") return redirectTo("/login", app);
  // Already signed in to this app: its sign-in and sign-up pages open the app.
  if (signedIn && app && AUTH_PAGES.includes(path)) return redirectTo(appHome(app));
  return finish(response);
}
