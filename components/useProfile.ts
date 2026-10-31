"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { appFor, enforceSessionChoice, signOutApp, useSessionEnd } from "@/components/portal/session";
import { contactPhones } from "@/lib/phones";
import { supabase } from "@/lib/supabase/client";
import type { Profile, Role } from "@/lib/types";

// Loads the signed-in user's profile from this app's own session. Signed out → this app's
// sign-in. Each sign-in admits only its own kind of account, so a mismatch here is an edge
// case (the role changed later): that app is signed out and its sign-in says which app to
// use. RLS still guards every query on its own.
// `stay` keeps the page on screen when the session ends (the NWS wall screen shows its own
// "signed out" panel instead of leaving for the sign-in page).
export function useProfile(expected?: Role, stay = false) {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  useSessionEnd(expected ? `/login?app=${appFor(expected)}` : "/login", !stay);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const app = expected ? appFor(expected) : null;
      const signIn = app ? `/login?app=${app}` : "/login";
      if (await enforceSessionChoice()) return router.replace(signIn);
      const db = supabase();
      const { data: auth } = await db.auth.getUser();
      if (!auth.user) return router.replace(signIn);
      const { data: row } = await db.from("profiles").select("id, role, staff_role, full_name").eq("id", auth.user.id).single();
      if (cancelled) return;
      if (!row) return router.replace(signIn);
      // The raw number isn't a column anyone selects (0049): the person's own comes from contact_phones.
      const data = { ...row, phone: (await contactPhones(db, [row.id])).get(row.id) ?? null };
      if (cancelled) return;
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
