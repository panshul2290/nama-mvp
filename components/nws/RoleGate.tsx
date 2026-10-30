"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { canSee, homeFor, READ_ONLY } from "@/components/nws/access";
import { STAFF_ROLE_LABEL, useStaff } from "@/components/nws/StaffContext";

/**
 * Shows a section only to the roles that may open it (components/nws/access.ts). The landing page
 * sends each role to its own first section; other sections say what the role can open instead.
 */
export function RoleGate({ children }: { children: React.ReactNode }) {
  const { staff } = useStaff();
  const path = usePathname();
  const router = useRouter();
  const role = staff.staff_role;
  const allowed = canSee(role, path);
  const landing = path === "/nws" || path === "/nws/settings";

  useEffect(() => {
    if (!allowed && landing) router.replace(homeFor(role));
  }, [allowed, landing, role, router]);

  if (!allowed) {
    if (landing) return null;
    return (
      <div className="panel">
        <h2>Not available for your role</h2>
        <p className="note">
          {STAFF_ROLE_LABEL[role]} accounts don’t use this section. <Link href={homeFor(role)} className="lnk">Go to your start page</Link>
        </p>
      </div>
    );
  }
  return (
    <>
      {READ_ONLY.includes(role) && (
        <div className="banner info" role="note">
          <b>Read-only access.</b> You can view and export everything here; actions are greyed out for the {STAFF_ROLE_LABEL[role]} role.
        </div>
      )}
      {children}
    </>
  );
}
