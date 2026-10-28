"use client";

import { useRouter } from "next/navigation";
import { createContext, use, useCallback } from "react";
import { ChatHub, useOrderChat } from "@/components/chat/OrderChat";
import { useDriver } from "@/components/DriverContext";

type Chat = ReturnType<typeof useOrderChat>;
const Ctx = createContext<Chat | null>(null);

/** The conversation for the job in progress (Trip screen, tab badge). */
export const useJobChat = () => use(Ctx);

/** Holds the active job's chat for the whole Driver app and shows message banners on every screen. */
export function DriverChats({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { profile, job, refreshUnread } = useDriver();
  const chat = useOrderChat(job?.order.id ?? null, "driver");
  // Marking messages read also clears their notifications: refresh the bell count.
  const { markRead } = chat;
  const markReadAndRefresh = useCallback(() => markRead().then(refreshUnread), [markRead, refreshUnread]);
  return (
    <Ctx value={{ ...chat, markRead: markReadAndRefresh }}>
      <ChatHub userId={profile.id} onOpen={() => router.push("/driver/trip")} onSeen={refreshUnread}>
        {children}
      </ChatHub>
    </Ctx>
  );
}
