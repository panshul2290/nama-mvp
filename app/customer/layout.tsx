"use client";

import "./customer.css";
import { useRouter } from "next/navigation";
import { ChatHub } from "@/components/chat/OrderChat";
import { CustomerCtx } from "@/components/CustomerContext";
import { useCx } from "@/components/customer/i18n";
import { UnreadProvider, useUnread } from "@/components/customer/ui";
import { Loading, TabBar, type Tab } from "@/components/Shell";
import { useProfile } from "@/components/useProfile";
import { usePushBridge } from "@/lib/usePush";

const HOME = ["/customer/request", "/customer/inbox", "/customer/complaint"];
const ORDERS = ["/customer/orders", "/customer/order", "/customer/contract", "/customer/certificate"];
const ACCOUNT = ["/customer/account", "/customer/complaints"];
const under = (p: string, list: string[]) => list.some((x) => p === x || p.startsWith(`${x}/`));

function Tabs() {
  const { t } = useCx();
  const { unread } = useUnread();
  const tabs: Tab[] = [
    { href: "/customer", label: t("tHome"), icon: "home", badge: unread, match: (p) => p === "/customer" || under(p, HOME) },
    { href: "/customer/orders", label: t("tOrders"), icon: "list", match: (p) => under(p, ORDERS) },
    { href: "/customer/wallet", label: t("tWallet"), icon: "wallet", match: (p) => under(p, ["/customer/wallet"]) },
    { href: "/customer/account", label: t("tAccount"), icon: "user", match: (p) => under(p, ACCOUNT) },
  ];
  return <TabBar tabs={tabs} />;
}

/** Message banners anywhere in the app; a tap opens that order's chat. */
function Chats({ userId, children }: { userId: string; children: React.ReactNode }) {
  const router = useRouter();
  const { refresh } = useUnread();
  return (
    <ChatHub userId={userId} onOpen={(id) => router.push(`/customer/order?id=${id}`)} onSeen={refresh}>
      {children}
    </ChatHub>
  );
}

export default function CustomerLayout({ children }: { children: React.ReactNode }) {
  const profile = useProfile("customer");
  usePushBridge("customer", Boolean(profile));
  if (!profile) return <Loading />;
  return (
    <CustomerCtx value={profile}>
      <UnreadProvider userId={profile.id}>
        <Chats userId={profile.id}>
          {children}
          <Tabs />
        </Chats>
      </UnreadProvider>
    </CustomerCtx>
  );
}
