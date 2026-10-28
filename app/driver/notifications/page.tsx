"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useChatHub } from "@/components/chat/OrderChat";
import { useDriver } from "@/components/DriverContext";
import { DICT, useFmt } from "@/components/driver/i18n";
import { Icon } from "@/components/icons";
import { BackButton } from "@/components/Shell";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import type { Notification } from "@/lib/types";

export default function NotificationsPage() {
  const { profile, refreshUnread, job } = useDriver();
  const { requestOpen } = useChatHub();
  const t = useT(DICT);
  const f = useFmt();
  const [items, setItems] = useState<Notification[] | null>(null);

  // Show what was unread, then mark everything read.
  useEffect(() => {
    const db = supabase();
    db.from("notifications")
      .select("*")
      .eq("user_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(50)
      .then(({ data }) => {
        setItems((data ?? []) as Notification[]);
        if ((data ?? []).some((n) => !n.read_at)) db.rpc("mark_notifications_read", { p_ids: null }).then(() => refreshUnread());
      });
  }, [profile.id, refreshUnread]);

  return (
    <main className="screen">
      <div className="rq-h">
        <BackButton href="/driver" label={t("back")} />
        <div>
          <h3>{t("notifications")}</h3>
          <small>{t("notifS")}</small>
        </div>
      </div>
      {items == null ? (
        <div className="empty">{t("loading")}</div>
      ) : items.length === 0 ? (
        <div className="empty">{t("noNotifs")}</div>
      ) : (
        <div className="ch-list">
          {items.map((n) => {
            const msg = n.event === "new_message";
            const inner = (
              <>
                {msg && (
                  <span className="d-nicon" aria-hidden="true">
                    <Icon name="chat" />
                  </span>
                )}
                <span className="d-nt">
                  <b>{n.title}</b>
                  <small>{n.body}</small>
                  <small>
                    {f.date(n.created_at)} · {f.time(n.created_at)}
                  </small>
                </span>
                {!n.read_at && <i className="d-dot" aria-label={t("unread")} />}
              </>
            );
            // A message on the job in progress opens its chat on the Trip screen.
            return msg && n.order_id && n.order_id === job?.order.id ? (
              <Link key={n.id} href="/driver/trip" className={`lrow d-notif ${n.read_at ? "" : "unread"}`} onClick={() => requestOpen(n.order_id as string)}>
                {inner}
              </Link>
            ) : (
              <div key={n.id} className={`lrow d-notif ${n.read_at ? "" : "unread"}`}>
                {inner}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
