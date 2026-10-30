"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { appFor, enforceSessionChoice, signOutApp, useSessionEnd } from "@/components/portal/session";
import { supabase } from "@/lib/supabase/client";
import type { Profile, Role } from "@/lib/types";

// Loads the signed-in user's profile from this app's own session. Signed out → this app's
// sign-in. Each sign-in admits only its own kind of account, so a mismatch here is an edge
// case (the role changed later): that app is signed out and its sign-in says which app to
// use. RLS still guards every query on its own.
export function useProfile(expected?: Role) {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  useSessionEnd(expected ? `/login?app=${appFor(expected)}` : "/login");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const app = expected ? appFor(expected) : null;
      const signIn = app ? `/login?app=${app}` : "/login";
      if (await enforceSessionChoice()) return router.replace(signIn);
      const db = supabase();
      const { data: auth } = await db.auth.getUser();
      if (!auth.user) return router.replace(signIn);
      const { data } = await db.from("profiles").select("id, role, staff_role, full_name, phone").eq("id", auth.user.id).single();
      if (cancelled) return;
      if (!data) return router.replace(signIn);
      if (expected && data.role !== expected) {
        await signOutApp();
        return router.replace(`${signIn}&wrong=${data.role}`);
      }
      setProfile(data as Profile);
    })();
    return () => {
      cancelled = true;
    };
  }, [expected, router]);

  return profile;
}
