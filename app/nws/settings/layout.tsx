"use client";

import "../admin.css";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { canSee } from "@/components/nws/access";
import { CONT } from "@/components/nws/i18n/continuity";
import { SETTINGS } from "@/components/nws/i18n/settings";
import { useStaff } from "@/components/nws/StaffContext";
import { useT } from "@/lib/i18n";

// Settings sub-navigation, grouped as in the prototype. Group and item labels are keys of
// SETTINGS (components/nws/i18n/settings.ts).
export const SETTINGS_NAV: { group: string; items: { href: string; label: string }[] }[] = [
  { group: "gAccess", items: [{ href: "/nws/settings/users", label: "navUsers" }] },
  {
    group: "gCommercial",
    items: [
      { href: "/nws/settings/pricing", label: "navPricing" },
      { href: "/nws/settings/penalties", label: "navPenalties" },
      { href: "/nws/settings/promotions", label: "navPromotions" },
    ],
  },
  {
    group: "gOperations",
    items: [
      { href: "/nws/settings/zones", label: "navZones" },
      { href: "/nws/settings/clusters", label: "navClusters" },
      { href: "/nws/settings/windows", label: "navWindows" },
      { href: "/nws/settings/tiers", label: "navTiers" },
      { href: "/nws/settings/charity", label: "navCharity" },
      { href: "/nws/settings/emergency", label: "navEmergency" },
      { href: "/nws/settings/notices", label: "navNotices" },
      { href: "/nws/settings/notifications", label: "navNotifications" },
    ],
  },
  {
    group: "gFinance",
    items: [
      { href: "/nws/settings/payments", label: "navPayments" },
      { href: "/nws/settings/continuity", label: "navContinuity" },
    ],
  },
  {
    group: "gRisk",
    items: [
      { href: "/nws/settings/fraud", label: "navFraud" },
      { href: "/nws/settings/privacy", label: "navPrivacy" },
      { href: "/nws/settings/audit", label: "navAudit" },
    ],
  },
  {
    group: "gSystem",
    items: [
      { href: "/nws/settings/health", label: "navHealth" },
      { href: "/nws/settings/integrations", label: "navIntegrations" },
    ],
  },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { staff } = useStaff();
  const ts = useT(SETTINGS);
  const tc = useT(CONT);
  // New pages' labels live in CONT (0040–0045).
  const t = (k: string) => (k in CONT ? tc(k) : ts(k));
  const groups = SETTINGS_NAV.map((g) => ({ ...g, items: g.items.filter((i) => canSee(staff.staff_role, i.href)) })).filter((g) => g.items.length > 0);
  return (
    <div className="settings">
      <nav className="subnav" aria-label={t("settings")}>
        {groups.map((g) => (
          <div key={g.group}>
            <small>{t(g.group)}</small>
            {g.items.map((i) => (
              <Link key={i.href} href={i.href} className={path.startsWith(i.href) ? "on" : ""} aria-current={path.startsWith(i.href) ? "page" : undefined}>
                {t(i.label)}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="settings-body">{children}</div>
    </div>
  );
}
