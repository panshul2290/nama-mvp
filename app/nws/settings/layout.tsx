"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Settings sub-navigation, grouped as in the prototype.
export const SETTINGS_NAV: { group: string; items: { href: string; label: string }[] }[] = [
  { group: "Access", items: [{ href: "/nws/settings/users", label: "Users and roles" }] },
  {
    group: "Commercial",
    items: [
      { href: "/nws/settings/pricing", label: "Pricing" },
      { href: "/nws/settings/penalties", label: "Penalties" },
      { href: "/nws/settings/promotions", label: "Promotions and loyalty" },
    ],
  },
  {
    group: "Operations",
    items: [
      { href: "/nws/settings/zones", label: "Zones and geofences" },
      { href: "/nws/settings/emergency", label: "Emergency mode" },
      { href: "/nws/settings/notifications", label: "Notifications" },
    ],
  },
  { group: "Finance", items: [{ href: "/nws/settings/payments", label: "Payments and settlements" }] },
  {
    group: "Risk and compliance",
    items: [
      { href: "/nws/settings/fraud", label: "Fraud detection" },
      { href: "/nws/settings/privacy", label: "Data privacy" },
      { href: "/nws/settings/audit", label: "Audit log" },
    ],
  },
  { group: "System", items: [{ href: "/nws/settings/health", label: "System health" }] },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div className="settings">
      <nav className="subnav" aria-label="Settings">
        {SETTINGS_NAV.map((g) => (
          <div key={g.group}>
            <small>{g.group}</small>
            {g.items.map((i) => (
              <Link key={i.href} href={i.href} className={path.startsWith(i.href) ? "on" : ""} aria-current={path.startsWith(i.href) ? "page" : undefined}>
                {i.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="settings-body">{children}</div>
    </div>
  );
}
