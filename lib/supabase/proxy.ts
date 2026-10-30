import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";

// Each protected area and the app whose sign-in it sends a signed-out visitor to.
const PROTECTED: [string, string][] = [
  ["/customer", "customer"],
  ["/driver", "driver"],
  ["/onboarding", "driver"],
  ["/nws", "nws"],
  ["/company", "company"],
  ["/business", "business"],
];
const AUTH_PAGES = ["/login", "/signup"];

// Refreshes the session cookie on every request and does optimistic redirects.
// Real authorization is enforced by RLS and the RPCs in the database.
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const client = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
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
  const path = request.nextUrl.pathname;

  const redirectTo = (to: string, app?: string) => {
    const url = request.nextUrl.clone();
    url.pathname = to;
    url.search = app ? `?app=${app}` : "";
    const r = NextResponse.redirect(url);
    response.cookies.getAll().forEach((c) => r.cookies.set(c));
    return r;
  };

  const area = PROTECTED.find(([p]) => path.startsWith(p));
  if (!signedIn && area) return redirectTo("/login", area[1]);
  // Signed in on an app's sign-in page: /switch forwards to that app or offers to change account.
  const app = request.nextUrl.searchParams.get("app");
  if (signedIn && AUTH_PAGES.includes(path)) return app ? redirectTo("/switch", app) : redirectTo("/");
  return response;
}
