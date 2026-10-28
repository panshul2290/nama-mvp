"use client";

// Customer ↔ driver conversation on an order (NWS can join). One chat sheet and one set of
// bubbles shared by the Customer app, the Driver app and the NWS order page; each app passes
// its own EN/AR strings. Backend: order_messages + send_message / mark_order_messages_read
// (0012, 0018); a trigger notifies the other party with event 'new_message'.
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icons";
import { friendlyError } from "@/lib/errors";
import { localDigits, type Lang } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import type { Notification, OrderMessage } from "@/lib/types";
import { useFocusTrap } from "@/lib/useFocusTrap";

export type ChatRole = OrderMessage["sender_role"];

// ---------------------------------------------------------------- data
/** Messages on an order, live (INSERT + UPDATE for read receipts), with send and mark-read. */
export function useOrderChat(orderId: string | null | undefined, me: ChatRole) {
  const [state, setState] = useState<{ id: string | null; msgs: OrderMessage[] }>({ id: null, msgs: [] });
  const msgs = useMemo(() => (state.id === orderId ? state.msgs : []), [state, orderId]);

  const load = useCallback(() => {
    if (!orderId) return;
    supabase()
      .from("order_messages")
      .select("*")
      .eq("order_id", orderId)
      .order("created_at")
      .then(({ data }) => setState({ id: orderId, msgs: (data ?? []) as OrderMessage[] }));
  }, [orderId]);

  useEffect(() => {
    if (!orderId) return;
    const db = supabase();
    const upsert = (m: OrderMessage) =>
      setState((s) => {
        const list = s.id === orderId ? s.msgs : [];
        const i = list.findIndex((x) => x.id === m.id);
        const next = i < 0 ? [...list, m] : list.map((x) => (x.id === m.id ? { ...x, ...m } : x));
        return { id: orderId, msgs: next };
      });
    const ch = db
      .channel(`chat-${me}-${orderId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "order_messages", filter: `order_id=eq.${orderId}` }, (p) => upsert(p.new as OrderMessage))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "order_messages", filter: `order_id=eq.${orderId}` }, (p) => upsert(p.new as OrderMessage))
      .subscribe((s) => {
        if (s === "SUBSCRIBED") load(); // close the gap between the first fetch and the subscription
      });
    const onFocus = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onFocus);
      db.removeChannel(ch);
    };
  }, [orderId, me, load]);

  const unread = msgs.filter((m) => m.sender_role !== me && !m.read_at).length;

  const send = useCallback(
    async (body: string): Promise<string | null> => {
      const text = body.trim();
      if (!orderId || !text) return null;
      const { data, error } = await supabase().rpc("send_message", { p_order_id: orderId, p_body: text }).single<OrderMessage>();
      if (error || !data) return friendlyError(error);
      setState((s) => {
        const list = s.id === orderId ? s.msgs : [];
        return { id: orderId, msgs: list.some((x) => x.id === data.id) ? list : [...list, data] };
      });
      return null;
    },
    [orderId],
  );

  const markRead = useCallback(async () => {
    if (!orderId) return;
    const now = new Date().toISOString();
    setState((s) => (s.id === orderId ? { id: orderId, msgs: s.msgs.map((m) => (m.sender_role !== me && !m.read_at ? { ...m, read_at: now } : m)) } : s));
    await supabase().rpc("mark_order_messages_read", { p_order_id: orderId });
  }, [orderId, me]);

  return { msgs, unread, send, markRead, reload: load };
}

// ---------------------------------------------------------------- strings
export type ChatLabels = {
  /** Header name and a line under it (e.g. the driver and the tanker plate). */
  title: string;
  subtitle?: string;
  /** Initials for the header avatar (a chat icon without them). */
  initials?: string;
  placeholder: string;
  send: string;
  close: string;
  call?: string;
  masked: string;
  empty: string;
  /** Shown instead of the input when the conversation is read-only. */
  closedNote: string;
  sent: string;
  read: string;
  nws: string;
  quickTitle: string;
};

// ---------------------------------------------------------------- bubbles
const timeFmt = (lang: Lang) => new Intl.DateTimeFormat(lang === "ar" ? "ar-OM-u-nu-arab" : "en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Muscat" });
const dayFmt = (lang: Lang) => new Intl.DateTimeFormat(lang === "ar" ? "ar-OM-u-nu-arab" : "en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Muscat" });
const dayKey = (iso: string) => new Date(new Date(iso).getTime() + 4 * 3_600_000).toISOString().slice(0, 10);

function Ticks({ read, label }: { read: boolean; label: string }) {
  return (
    <svg className={`oc-ticks ${read ? "read" : ""}`} viewBox="0 0 18 11" width="17" height="11" role="img" aria-label={label}>
      <path d="M1 6l3.2 3.2L11 2.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      {read && <path d="M7.4 8.6l.6.6L14.8 2.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

/** Message bubbles: mine at the end side (right in English, left in Arabic), others at the start, NWS labelled. */
export function ChatBubbles({
  msgs,
  me,
  lang,
  labels,
  who,
  allTicks = false,
}: {
  msgs: OrderMessage[];
  me: ChatRole;
  lang: Lang;
  labels: Pick<ChatLabels, "sent" | "read" | "nws">;
  /** Optional name line over each bubble (the NWS page shows who wrote it). */
  who?: (m: OrderMessage) => string | null;
  /** Read state on every message, not just mine (NWS oversight). */
  allTicks?: boolean;
}) {
  const tf = timeFmt(lang);
  const df = dayFmt(lang);
  return (
    <div className="oc-list" role="log" aria-live="polite">
      {msgs.map((m, i) => {
        const mine = m.sender_role === me;
        const newDay = i === 0 || dayKey(m.created_at) !== dayKey(msgs[i - 1].created_at);
        const sep = newDay ? <div className="oc-day">{df.format(new Date(m.created_at))}</div> : null;
        const name = who ? who(m) : m.sender_role === "staff" && !mine ? labels.nws : null;
        return (
          <div key={m.id} className="oc-row-wrap">
            {sep}
            <div className={`oc-b ${mine ? "mine" : "theirs"} ${m.sender_role}`}>
              {name && (
                <b className="oc-who">
                  {m.sender_role === "staff" && <Icon name="shield" size={12} />}
                  {name}
                </b>
              )}
              <span className="oc-text" dir="auto">
                {m.body}
              </span>
              <span className="oc-meta">
                <time dateTime={m.created_at}>{tf.format(new Date(m.created_at))}</time>
                {(mine || allTicks) && <Ticks read={Boolean(m.read_at)} label={m.read_at ? labels.read : labels.sent} />}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- sheet
const noop = () => () => {};
const phone = () => document.querySelector<HTMLElement>(".phone");

export type QuickReply = { text: string; /** Put the text in the box to finish (e.g. "Gate code is…") instead of sending it. */ prefill?: boolean };

/** Full-height chat over the phone frame: header, bubbles, quick replies, input. */
export function ChatSheet({
  chat,
  me,
  lang,
  dir,
  labels,
  quick,
  canSend,
  onClose,
  onCall,
  onError,
}: {
  chat: ReturnType<typeof useOrderChat>;
  me: ChatRole;
  lang: Lang;
  dir: "ltr" | "rtl";
  labels: ChatLabels;
  quick: QuickReply[];
  canSend: boolean;
  onClose: () => void;
  onCall?: () => void;
  onError: (message: string) => void;
}) {
  const host = useSyncExternalStore(noop, phone, () => null);
  const trap = useFocusTrap(onClose);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const { msgs, unread, markRead, send } = chat;

  // Read on open, and whenever something new comes in while it's open.
  useEffect(() => {
    if (unread > 0) markRead();
  }, [unread, markRead]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, host]);

  async function submit(t: string) {
    if (!t.trim() || busy) return;
    setBusy(true);
    const err = await send(t);
    setBusy(false);
    if (err) return onError(err);
    setText("");
  }

  function pickQuick(q: QuickReply) {
    if (q.prefill) {
      setText(q.text.replace(/…$/, "").trimEnd() + " ");
      input.current?.focus();
    } else submit(q.text);
  }

  if (!host) return null;
  return createPortal(
    <div className="oc-modal" dir={dir} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={trap} className="oc-sheet" role="dialog" aria-modal="true" aria-label={labels.title}>
        <header className="oc-head">
          <span className={`oc-av ${labels.initials ? "ini" : ""}`} aria-hidden="true">
            {labels.initials || <Icon name="chat" />}
          </span>
          <div className="oc-hd">
            <b>{labels.title}</b>
            {labels.subtitle && <small>{labels.subtitle}</small>}
          </div>
          {onCall && labels.call && (
            <button type="button" className="oc-ib" onClick={onCall} aria-label={labels.call} title={labels.call}>
              <Icon name="phone" />
            </button>
          )}
          <button type="button" className="oc-ib" onClick={onClose} aria-label={labels.close} title={labels.close}>
            <Icon name="x" />
          </button>
        </header>

        <div ref={body} className="oc-body">
          {msgs.length === 0 ? <p className="oc-empty">{labels.empty}</p> : <ChatBubbles msgs={msgs} me={me} lang={lang} labels={labels} />}
        </div>

        {canSend ? (
          <footer className="oc-foot">
            <div className="oc-quick" role="group" aria-label={labels.quickTitle}>
              {quick.map((q) => (
                <button key={q.text} type="button" disabled={busy} onClick={() => pickQuick(q)}>
                  {q.text}
                </button>
              ))}
            </div>
            <form
              className="oc-input"
              onSubmit={(e) => {
                e.preventDefault();
                submit(text);
              }}
            >
              <input ref={input} value={text} maxLength={500} placeholder={labels.placeholder} aria-label={labels.placeholder} onChange={(e) => setText(e.target.value)} enterKeyHint="send" />
              <button type="submit" className="oc-send" disabled={busy || !text.trim()} aria-label={labels.send} title={labels.send}>
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                  <path d="M3.4 20.4 21 12 3.4 3.6 3.3 10l12.4 2-12.4 2z" fill="currentColor" />
                </svg>
              </button>
            </form>
            <p className="oc-note">{labels.masked}</p>
          </footer>
        ) : (
          <footer className="oc-foot closed">
            <p className="oc-closed">
              <Icon name="lock" size={16} />
              {labels.closedNote}
            </p>
          </footer>
        )}
      </div>
    </div>,
    host,
  );
}

/** "Message driver / customer" button with an unread badge. */
export function ChatButton({ label, unread, onClick, lang, className = "" }: { label: string; unread: number; onClick: () => void; lang: Lang; className?: string }) {
  return (
    <button type="button" className={`oc-btn ${className}`} onClick={onClick}>
      <Icon name="chat" />
      <span>{label}</span>
      {unread > 0 && (
        <span className="oc-badge" aria-label={`${unread}`}>
          {localDigits(unread, lang)}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------- app-wide: banners and "open this chat"
type Hub = {
  /** The order whose chat sheet is open right now (no banner for it). */
  active: string | null;
  setActive: (id: string | null) => void;
  /** A chat to open as soon as its screen is showing (set by a banner or inbox tap). */
  pending: string | null;
  requestOpen: (orderId: string) => void;
  clearPending: () => void;
};
const HubCtx = createContext<Hub>({ active: null, setActive: () => {}, pending: null, requestOpen: () => {}, clearPending: () => {} });
export const useChatHub = () => use(HubCtx);

/**
 * Wraps an app: listens for 'new_message' notifications and shows a banner over the phone
 * (unless that chat is already open); tapping it opens the chat via `onOpen`.
 */
export function ChatHub({
  userId,
  onOpen,
  onSeen,
  children,
}: {
  userId: string;
  /** Navigate to the screen that holds the chat for this order. */
  onOpen: (orderId: string) => void;
  /** A message notification was marked read here (refresh unread counts). */
  onSeen?: () => void;
  children: React.ReactNode;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [banner, setBanner] = useState<Notification | null>(null);
  const activeRef = useRef(active);
  const seenRef = useRef(onSeen);
  useEffect(() => {
    activeRef.current = active;
    seenRef.current = onSeen;
  });

  useEffect(() => {
    const db = supabase();
    const ch = db
      .channel(`chat-alerts-${userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` }, (p) => {
        const n = p.new as Notification;
        if (n.event !== "new_message" || !n.order_id) return;
        if (n.order_id === activeRef.current) {
          // Already reading this conversation.
          db.rpc("mark_notifications_read", { p_ids: [n.id] }).then(() => seenRef.current?.());
          return;
        }
        setBanner(n);
      })
      .subscribe();
    return () => {
      db.removeChannel(ch);
    };
  }, [userId]);

  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 7000);
    return () => clearTimeout(t);
  }, [banner]);

  const requestOpen = useCallback((id: string) => setPending(id), []);
  const clearPending = useCallback(() => setPending(null), []);
  const value = useMemo(() => ({ active, setActive, pending, requestOpen, clearPending }), [active, pending, requestOpen, clearPending]);

  const host = useSyncExternalStore(noop, phone, () => null);
  const shown = banner && banner.order_id !== active ? banner : null;
  return (
    <HubCtx value={value}>
      {children}
      {shown &&
        host &&
        createPortal(
          <button
            type="button"
            className="oc-banner"
            role="status"
            onClick={() => {
              setBanner(null);
              setPending(shown.order_id);
              onOpen(shown.order_id as string);
            }}
          >
            <span className="oc-av" aria-hidden="true">
              <Icon name="chat" />
            </span>
            <span className="oc-bt">
              <b dir="auto">{shown.title}</b>
              <small dir="auto">{shown.body}</small>
            </span>
          </button>,
          host,
        )}
    </HubCtx>
  );
}
