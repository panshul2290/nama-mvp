"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useCustomer } from "@/components/CustomerContext";
import { useChatHub } from "@/components/chat/OrderChat";
import { useCx } from "@/components/customer/i18n";
import { dtshort } from "@/components/customer/fmt";
import { useUnread } from "@/components/customer/ui";
import { Icon } from "@/components/icons";
import { BackButton } from "@/components/Shell";
import { supabase } from "@/lib/supabase/client";
import type { Notification } from "@/lib/types";

const CH: Record<string, string> = { push: "chPush", sms: "chSms", whatsapp: "chWa", in_app: "chApp" };

export default function InboxPage() {
  const profile = useCustomer();
  const { t, lang } = useCx();
  const { refresh } = useUnread();
  const { requestOpen } = useChatHub();
  const [list, setList] = useState<Notification[] | null>(null);

  // Load, then mark everything read (the dots stay until the next visit); new ones arrive live.
  useEffect(() => {
    const db = supabase();
    db.from("notifications")
      .select("*")
      .eq("user_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(60)
      .then(({ data }) => {
        setList((data ?? []) as Notification[]);
        if ((data ?? []).some((n) => !n.read_at)) db.rpc("mark_notifications_read", { p_ids: null }).then(() => refresh());
      });
    const ch = db
      .channel(`inbox-${profile.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${profile.id}` }, (p) => {
        const n = p.new as Notification;
        setList((l) => [n, ...(l ?? []).filter((x) => x.id !== n.id)]);
        db.rpc("mark_notifications_read", { p_ids: [n.id] }).then(() => refresh());
      })
      .subscribe();
    return () => {
      db.removeChannel(ch);
    };
  }, [profile.id, refresh]);

  return (
    <main className="screen">
      <div className="rq-h">
        <BackButton href="/customer" label={t("back")} />
        <div>
          <h3>{t("inbox")}</h3>
        </div>
      </div>
      {list === null ? (
        <div className="empty">{t("loading")}</div>
      ) : list.length === 0 ? (
        <div className="empty">{t("noNotifs")}</div>
      ) : (
        <div className="ch-list">
          {list.map((n) => {
            const body = (
              <span>
                <b className={n.read_at ? "" : "unread"}>{n.title}</b>
                {n.body}
                <small>
                  {n.channels.map((c) => t(CH[c] ?? c)).join(" · ")} · {dtshort(n.created_at, lang)}
                </small>
              </span>
            );
            return n.order_id ? (
              <Link
                key={n.id}
                href={`/customer/order?id=${n.order_id}`}
                className={`lrow nrow ${n.event === "new_message" ? "msgrow" : ""}`}
                onClick={() => n.event === "new_message" && n.order_id && requestOpen(n.order_id)}
              >
                {n.event === "new_message" && (
                  <span className="nicon" aria-hidden="true">
                    <Icon name="chat" />
                  </span>
                )}
                {body}
              </Link>
            ) : (
              <div key={n.id} className="lrow nrow">
                {body}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
