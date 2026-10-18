"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Loading } from "@/components/Shell";
import { supabase } from "@/lib/supabase/client";

// Sends each user to their home: customer, driver, or driver onboarding.
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const db = supabase();
      const { data: auth } = await db.auth.getUser();
      if (!auth.user) return router.replace("/login");
      const { data: profile } = await db.from("profiles").select("role").eq("id", auth.user.id).single();
      if (profile?.role === "nws_staff") return router.replace("/nws");
      if (profile?.role === "driver") {
        // RLS returns only the tanker currently assigned to this driver.
        const { data: tanker } = await db.from("tankers").select("id").maybeSingle();
        return router.replace(tanker ? "/driver" : "/onboarding");
      }
      router.replace(profile ? "/customer" : "/login");
    })();
  }, [router]);

  return <Loading />;
}
