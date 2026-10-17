"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { Profile, Role } from "@/lib/types";

// Loads the signed-in user's profile and bounces to the right home if the role
// doesn't match this page. RLS still guards every query on its own.
export function useProfile(expected?: Role) {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = supabase();
      const { data: auth } = await db.auth.getUser();
      if (!auth.user) return router.replace("/login");
      const { data } = await db.from("profiles").select("id, role, full_name, phone").eq("id", auth.user.id).single();
      if (cancelled) return;
      if (!data) return router.replace("/login");
      if (expected && data.role !== expected) return router.replace("/");
      setProfile(data as Profile);
    })();
    return () => {
      cancelled = true;
    };
  }, [expected, router]);

  return profile;
}
