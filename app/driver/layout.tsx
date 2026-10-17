"use client";

import { DriverProvider, useDriver } from "@/components/DriverContext";
import { Loading, TabBar } from "@/components/Shell";

function DriverTabs() {
  const { job } = useDriver();
  return (
    <TabBar
      tabs={[
        { href: "/driver", label: "Home", icon: "home" },
        { href: "/driver/jobs", label: "Jobs", icon: "jobs" },
        { href: "/driver/trip", label: "Trip", icon: "route", badge: job ? 1 : undefined },
        { href: "/driver/profile", label: "Profile", icon: "user" },
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
