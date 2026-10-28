import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";

const PROTECTED = ["/customer", "/driver", "/onboarding", "/nws", "/company", "/business"];
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

  const redirectTo = (to: string) => {
    const url = request.nextUrl.clone();
    url.pathname = to;
    url.search = "";
    const r = NextResponse.redirect(url);
    response.cookies.getAll().forEach((c) => r.cookies.set(c));
    return r;
  };

  if (!signedIn && PROTECTED.some((p) => path.startsWith(p))) return redirectTo("/login");
  if (signedIn && AUTH_PAGES.includes(path)) return redirectTo("/");
  return response;
}
