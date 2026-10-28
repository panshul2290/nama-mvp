"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Launcher } from "@/components/portal/Launcher";
import { enforceSessionChoice, homeFor } from "@/components/portal/session";
import { Loading } from "@/components/Shell";
import { supabase } from "@/lib/supabase/client";
import type { Role } from "@/lib/types";

// Signed out: the app launcher. Signed in: straight to the user's home by role.
export default function Home() {
  const router = useRouter();
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    (async () => {
      await enforceSessionChoice();
      const db = supabase();
      const { data: auth } = await db.auth.getUser();
      if (!auth.user) return setSignedOut(true);
      const { data: profile } = await db.from("profiles").select("role").eq("id", auth.user.id).single();
      if (!profile) return setSignedOut(true);
      const role = profile.role as Role;
      if (role === "driver") {
        // RLS returns only the tanker currently assigned to this driver.
        const { data: tanker } = await db.from("tankers").select("id").maybeSingle();
        return router.replace(homeFor(role, Boolean(tanker)));
      }
      router.replace(homeFor(role));
    })();
  }, [router]);

  return signedOut ? <Launcher /> : <Loading />;
}
