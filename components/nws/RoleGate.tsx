"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { canSee, homeFor, READ_ONLY } from "@/components/nws/access";
import { useStaff } from "@/components/nws/StaffContext";
import { PORTAL } from "@/components/portal/dict";
import { useLang, useT } from "@/lib/i18n";
import { staffRoleLabel } from "@/lib/labels";

/**
 * Shows a section only to the roles that may open it (components/nws/access.ts). The landing page
 * sends each role to its own first section; other sections say what the role can open instead.
 */
export function RoleGate({ children }: { children: React.ReactNode }) {
  const { staff } = useStaff();
  const path = usePathname();
  const router = useRouter();
  const role = staff.staff_role;
  const { lang } = useLang();
  const t = useT(PORTAL);
  const allowed = canSee(role, path);
  const landing = path === "/nws" || path === "/nws/settings";

  useEffect(() => {
    if (!allowed && landing) router.replace(homeFor(role));
  }, [allowed, landing, role, router]);

  if (!allowed) {
    if (landing) return null;
    return (
      <div className="panel">
        <h2>{t("notForRole")}</h2>
        <p className="note">
          {t("notForRoleBody", { role: staffRoleLabel(role, lang) })} <Link href={homeFor(role)} className="lnk">{t("goStart")}</Link>
        </p>
      </div>
    );
  }
  return (
    <>
      {READ_ONLY.includes(role) && (
        <div className="banner info" role="note">
          <b>{t("readOnlyB")}</b> {t("readOnlyBody", { role: staffRoleLabel(role, lang) })}
        </div>
      )}
      {children}
    </>
  );
}
