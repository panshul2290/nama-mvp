"use client";

import { useEffect, useState } from "react";
import { useDriver } from "@/components/DriverContext";
import { DICT, useFmt } from "@/components/driver/i18n";
import { BackButton } from "@/components/Shell";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import type { Notification } from "@/lib/types";

export default function NotificationsPage() {
  const { profile, refreshUnread } = useDriver();
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
          {items.map((n) => (
            <div key={n.id} className={`lrow d-notif ${n.read_at ? "" : "unread"}`}>
              <span>
                <b>{n.title}</b>
                <small>{n.body}</small>
                <small>
                  {f.date(n.created_at)} · {f.time(n.created_at)}
                </small>
              </span>
              {!n.read_at && <i className="d-dot" aria-label={t("unread")} />}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
