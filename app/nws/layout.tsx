"use client";

import "./nws.css";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon, NamaLogo, type IconName } from "@/components/icons";
import { canSee } from "@/components/nws/access";
import { RoleGate } from "@/components/nws/RoleGate";
import { StaffProvider, type Staff } from "@/components/nws/StaffContext";
import { Loading } from "@/components/Shell";
import { useProfile } from "@/components/useProfile";
import { PORTAL } from "@/components/portal/dict";
import { PortalLangToggle } from "@/components/portal/i18n";
import { signOutApp } from "@/components/portal/session";
import { useLang, useT } from "@/lib/i18n";
import { staffRoleLabel } from "@/lib/labels";

// Sidebar exactly as labelled in the prototype's staff portal; each role sees only its sections.
// Labels are keys of the shared portal dictionary (components/portal/dict.ts).
const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/nws", label: "navLive", icon: "map" },
  { href: "/nws/orders", label: "navOrders", icon: "list" },
  { href: "/nws/fleet", label: "navFleet", icon: "truck" },
  { href: "/nws/permits", label: "navPermits", icon: "shield" },
  { href: "/nws/customers", label: "navCustomers", icon: "users" },
  { href: "/nws/complaints", label: "navComplaints", icon: "headset" },
  { href: "/nws/reports", label: "navReports", icon: "chart" },
  { href: "/nws/settings", label: "navSettings", icon: "settings" },
];

export default function NwsLayout({ children }: { children: React.ReactNode }) {
  const profile = useProfile("nws_staff");
  const path = usePathname();
  const router = useRouter();
  const { lang, dir } = useLang();
  const t = useT(PORTAL);
  if (!profile || !profile.staff_role) return <Loading label={t("loading")} />;

  async function signOut() {
    await signOutApp("nws");
    router.replace("/login?app=nws");
  }

  return (
    <StaffProvider staff={profile as Staff}>
      <div className="nws" dir={dir} lang={lang}>
        <nav className="side" aria-label={t("nwsPortal")}>
          <div className="brand">
            <NamaLogo />
            <span>
              <b>{t("tankerOps")}</b>
              <small>{t("nwsPortal")}</small>
            </span>
          </div>
          {NAV.filter((n) => canSee(profile.staff_role!, n.href)).map((n) => {
            const on = n.href === "/nws" ? path === "/nws" : path.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} className={`navbtn ${on ? "on" : ""}`} aria-current={on ? "page" : undefined}>
                <Icon name={n.icon} />
                {t(n.label)}
              </Link>
            );
          })}
          <div className="navfoot">
            <b>{profile.full_name || t("nwsStaff")}</b>
            {staffRoleLabel(profile.staff_role, lang)}
            <PortalLangToggle className="side-lang" />
            <button onClick={signOut}>{t("signOut")}</button>
          </div>
        </nav>
        <main>
          <RoleGate>{children}</RoleGate>
        </main>
      </div>
    </StaffProvider>
  );
}
