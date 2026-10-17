"use client";

import { CustomerCtx } from "@/components/CustomerContext";
import { Loading, TabBar, type Tab } from "@/components/Shell";
import { useProfile } from "@/components/useProfile";

const TABS: Tab[] = [
  { href: "/customer", label: "Home", icon: "home", match: (p) => p === "/customer" || p.startsWith("/customer/request") },
  { href: "/customer/orders", label: "Orders", icon: "list", match: (p) => p.startsWith("/customer/orders") },
  { href: "/customer/account", label: "Account", icon: "user" },
];

export default function CustomerLayout({ children }: { children: React.ReactNode }) {
  const profile = useProfile("customer");
  if (!profile) return <Loading />;
  return (
    <CustomerCtx value={profile}>
      {children}
      <TabBar tabs={TABS} />
    </CustomerCtx>
  );
}
