"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/icons";

export type Tab = { href: string; label: string; icon: IconName; badge?: number; match?: (path: string) => boolean };

// Bottom tab bar from the prototype's phone screens.
export function TabBar({ tabs }: { tabs: Tab[] }) {
  const path = usePathname();
  return (
    <nav className="tabbar" aria-label="Sections">
      {tabs.map((t) => {
        const on = t.match ? t.match(path) : path === t.href;
        return (
          <Link key={t.href} href={t.href} className={on ? "on" : ""} aria-current={on ? "page" : undefined}>
            <Icon name={t.icon} />
            {t.label}
            {t.badge ? <span className="badge">{t.badge}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function BackButton({ href, onClick, label = "Back" }: { href?: string; onClick?: () => void; label?: string }) {
  if (href) {
    return (
      <Link href={href} className="rb" aria-label={label}>
        <Icon name="back" />
      </Link>
    );
  }
  return (
    <button type="button" className="rb" aria-label={label} onClick={onClick}>
      <Icon name="back" />
    </button>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="spin-page" role="status" aria-label={label}>
      <span className="spin" aria-hidden="true" />
    </div>
  );
}
