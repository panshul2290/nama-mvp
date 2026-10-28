"use client";

import "./driver.css";
import { DriverProvider, useDriver } from "@/components/DriverContext";
import { DICT } from "@/components/driver/i18n";
import { Loading, TabBar } from "@/components/Shell";
import { useT } from "@/lib/i18n";

function DriverTabs() {
  const { job, openJobs } = useDriver();
  const t = useT(DICT);
  return (
    <TabBar
      tabs={[
        { href: "/driver", label: t("tHome"), icon: "home", match: (p) => p === "/driver" || p.startsWith("/driver/notifications") },
        { href: "/driver/jobs", label: t("tJobs"), icon: "jobs", badge: openJobs.length || undefined },
        { href: "/driver/trip", label: t("tTrip"), icon: "route", badge: job ? 1 : undefined },
        { href: "/driver/earnings", label: t("tEarnings"), icon: "coins" },
        { href: "/driver/profile", label: t("tProfile"), icon: "user" },
      ]}
    />
  );
}

export default function DriverLayout({ children }: { children: React.ReactNode }) {
  return (
    <DriverProvider fallback={<Loading />}>
      {children}
      <DriverTabs />
    </DriverProvider>
  );
}
