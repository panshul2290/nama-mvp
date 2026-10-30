"use client";

import "./nws.css";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon, NamaLogo, type IconName } from "@/components/icons";
import { STAFF_ROLE_LABEL, StaffProvider, type Staff } from "@/components/nws/StaffContext";
import { Loading } from "@/components/Shell";
import { useProfile } from "@/components/useProfile";
import { signOutApp } from "@/components/portal/session";

// Sidebar exactly as labelled in the prototype's staff portal.
const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/nws", label: "Live operations", icon: "map" },
  { href: "/nws/orders", label: "Orders", icon: "list" },
  { href: "/nws/fleet", label: "Fleet", icon: "truck" },
  { href: "/nws/permits", label: "Permits", icon: "shield" },
  { href: "/nws/customers", label: "Customers", icon: "users" },
  { href: "/nws/complaints", label: "Complaints", icon: "headset" },
  { href: "/nws/reports", label: "Reports", icon: "chart" },
  { href: "/nws/settings", label: "Settings", icon: "settings" },
];

export default function NwsLayout({ children }: { children: React.ReactNode }) {
  const profile = useProfile("nws_staff");
  const path = usePathname();
  const router = useRouter();
  if (!profile || !profile.staff_role) return <Loading />;

  async function signOut() {
    await signOutApp("nws");
    router.replace("/login?app=nws");
  }

  return (
    <StaffProvider staff={profile as Staff}>
      <div className="nws">
        <nav className="side" aria-label="NWS staff portal">
          <div className="brand">
            <NamaLogo />
            <span>
              <b>Tanker Operations</b>
              <small>NWS staff portal</small>
            </span>
          </div>
          {NAV.map((n) => {
            const on = n.href === "/nws" ? path === "/nws" : path.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} className={`navbtn ${on ? "on" : ""}`} aria-current={on ? "page" : undefined}>
                <Icon name={n.icon} />
                {n.label}
              </Link>
            );
          })}
          <div className="navfoot">
            <b>{profile.full_name || "NWS staff"}</b>
            {STAFF_ROLE_LABEL[profile.staff_role]}
            <button onClick={signOut}>Sign out</button>
          </div>
        </nav>
        <main>{children}</main>
      </div>
    </StaffProvider>
  );
}
