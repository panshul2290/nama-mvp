"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { appFor } from "@/components/portal/session";
import { supabase } from "@/lib/supabase/client";
import type { Profile, Role } from "@/lib/types";

// Loads the signed-in user's profile. Signed out → this app's sign-in; signed in
// with another kind of account → /switch, which offers to sign out or go to that
// account's own app. RLS still guards every query on its own.
export function useProfile(expected?: Role) {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = supabase();
      const { data: auth } = await db.auth.getUser();
      const signIn = expected ? `/login?app=${appFor(expected)}` : "/login";
      if (!auth.user) return router.replace(signIn);
      const { data } = await db.from("profiles").select("id, role, staff_role, full_name, phone").eq("id", auth.user.id).single();
      if (cancelled) return;
      if (!data) return router.replace(signIn);
      if (expected && data.role !== expected) return router.replace(`/switch?app=${appFor(expected)}`);
      setProfile(data as Profile);
    })();
    return () => {
      cancelled = true;
    };
  }, [expected, router]);

  return profile;
}
