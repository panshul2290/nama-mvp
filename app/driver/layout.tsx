"use client";

import "./driver.css";
import { DriverProvider, useDriver } from "@/components/DriverContext";
import { DriverChats, useJobChat } from "@/components/driver/DriverChat";
import { DICT, useFmt } from "@/components/driver/i18n";
import { Loading, TabBar } from "@/components/Shell";
import { useT } from "@/lib/i18n";
import { usePushBridge } from "@/lib/usePush";

function DriverTabs() {
  const { job, openJobs } = useDriver();
  const chat = useJobChat();
  const t = useT(DICT);
  const f = useFmt();
  const unreadMsgs = job ? (chat?.unread ?? 0) : 0;
  return (
    <TabBar
      tabs={[
        { href: "/driver", label: t("tHome"), icon: "home", match: (p) => p === "/driver" || p.startsWith("/driver/notifications") },
        { href: "/driver/jobs", label: t("tJobs"), icon: "jobs", badge: openJobs.length || undefined },
        unreadMsgs
          ? { href: "/driver/trip", label: t("tTrip"), icon: "route", badge: unreadMsgs, badgeTone: "msg", badgeLabel: t("unreadMsgs", { n: f.d(unreadMsgs) }) }
          : { href: "/driver/trip", label: t("tTrip"), icon: "route", badge: job ? 1 : undefined },
        { href: "/driver/earnings", label: t("tEarnings"), icon: "coins" },
        { href: "/driver/profile", label: t("tProfile"), icon: "user", match: (p) => p.startsWith("/driver/profile") || p.startsWith("/driver/training") },
      ]}
    />
  );
}

function DriverPush() {
  usePushBridge("driver", true);
  return null;
}

export default function DriverLayout({ children }: { children: React.ReactNode }) {
  return (
    <DriverProvider fallback={<Loading />}>
      <DriverChats>
        <DriverPush />
        {children}
        <DriverTabs />
      </DriverChats>
    </DriverProvider>
  );
}
