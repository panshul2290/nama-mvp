"use client";

import Link from "next/link";
import { appFor, type AppKey } from "@/lib/apps";
import { useT } from "@/lib/i18n";
import type { Role } from "@/lib/types";
import { AUTH } from "./authI18n";

// One-app builds (the Android APKs) have no other apps' sign-in pages to link to.
const ONE_APP = Boolean(process.env.NEXT_PUBLIC_APP_TARGET);
const ROLES: Role[] = ["customer", "driver", "owner", "business", "nws_staff"];
export const asRole = (v: string | null | undefined): Role | null => (ROLES.includes(v as Role) ? (v as Role) : null);

/**
 * "This is a customer account. Use the Customer app to sign in." Shown when someone signs
 * in to an app with another kind of account (that session was already signed out).
 * `role` null: the account has no profile.
 */
export function WrongAccount({ role, desktop }: { role: Role | null; desktop: boolean }) {
  const t = useT(AUTH);
  const cls = desktop ? "si-msg" : "banner badb";
  if (!role) return <div className={cls}>{t("e_no_profile")}</div>;
  const app: AppKey = appFor(role);
  const name = t(`app_${app}`);
  return (
    <div className={cls} role="alert">
      {t(`wrong_${role}`)} {t("useApp", { app: name })}
      {!ONE_APP && (
        <>
          {" "}
          <Link className="lk" href={`/login?app=${app}`} style={{ fontWeight: 700 }}>
            {t("openApp", { app: name })}
          </Link>
        </>
      )}
    </div>
  );
}
