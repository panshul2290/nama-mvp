"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { NamaLogo } from "@/components/icons";
import { APP_INFO, AuthFrame } from "@/components/portal/AuthChrome";
import { AUTH } from "@/components/portal/authI18n";
import { appFor, asApp, isDesktopApp } from "@/components/portal/session";
import { Loading } from "@/components/Shell";
import { LangToggle, useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import type { Role } from "@/lib/types";

export default function SwitchPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Switch />
    </Suspense>
  );
}

// Opening an app while signed in with another kind of account (e.g. /nws in a
// browser still signed in as a customer): say so, and offer to sign out or go
// to the signed-in account's own app.
function Switch() {
  const app = asApp(useSearchParams().get("app")) ?? "customer";
  const router = useRouter();
  const t = useT(AUTH);
  const [who, setWho] = useState<{ name: string; role: string } | null>(null);

  useEffect(() => {
    (async () => {
      const db = supabase();
      const { data: auth } = await db.auth.getUser();
      if (!auth.user) return router.replace(`/login?app=${app}`);
      const { data } = await db.from("profiles").select("role, full_name").eq("id", auth.user.id).single();
      if (data && appFor(data.role as Role) === app) return router.replace("/");
      setWho({ name: data?.full_name || auth.user.phone || auth.user.email || "", role: data?.role ?? "" });
    })();
  }, [app, router]);

  async function signOut() {
    await supabase().auth.signOut();
    router.replace(`/login?app=${app}`);
  }

  if (!who) return <Loading />;
  const name = APP_INFO[app].name;
  const body = t("switchBody", { name: who.name, role: t(`role_${who.role}`), app: name });

  if (isDesktopApp(app)) {
    return (
      <AuthFrame app={app}>
        <div>
          <h2>{t("switchTitle")}</h2>
          <p>{body}</p>
        </div>
        <button className="si-btn" onClick={signOut}>
          {t("switchSignOut", { app: name })}
        </button>
        <button className="si-btn gh" onClick={() => router.replace("/")}>
          {t("switchStay")}
        </button>
      </AuthFrame>
    );
  }

  return (
    <main className="screen">
      <div className="dlogin">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <NamaLogo className="ph-logo" />
          <LangToggle />
        </div>
        <h2>{t("switchTitle")}</h2>
        <p>{body}</p>
        <button className="cta" onClick={signOut}>
          {t("switchSignOut", { app: name })}
        </button>
        <button className="cta sec" onClick={() => router.replace("/")}>
          {t("switchStay")}
        </button>
      </div>
    </main>
  );
}
