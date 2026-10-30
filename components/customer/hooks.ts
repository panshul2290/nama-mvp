"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase/client";
import type { Property } from "@/lib/types";

/** navigator.onLine, live. */
export function useOnline() {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb);
      window.addEventListener("offline", cb);
      return () => {
        window.removeEventListener("online", cb);
        window.removeEventListener("offline", cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

/** Current time, refreshed every `ms` (keeps Date.now() out of render). */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export type Emergency = { on: boolean; zone: string | null; reason: string | null };

/** app_settings.EMERGENCY (set from the NWS control room). */
export function useEmergency() {
  const [em, setEm] = useState<Emergency | null>(null);
  useEffect(() => {
    supabase()
      .from("app_settings")
      .select("value")
      .eq("key", "EMERGENCY")
      .maybeSingle<{ value: string }>()
      .then(({ data }) => {
        try {
          const v = data ? (JSON.parse(data.value) as Emergency) : null;
          setEm(v?.on ? v : null);
        } catch {
          setEm(null);
        }
      });
  }, []);
  return em;
}

export type Prefs = {
  push?: boolean;
  sms?: boolean;
  whatsapp?: boolean;
  promotions?: boolean;
  share_usage?: boolean;
  autopay?: boolean;
  /** Reminders (refill, documents): on unless switched off (0026). */
  reminders?: boolean;
  /** Notifications by email as well: off unless switched on (0026). */
  email?: boolean;
  /** People living at each property (property id, or "pin"), for the size and frequency suggestion. */
  household?: Record<string, number>;
};
export const PREF_DEFAULTS: Required<Prefs> = { push: true, sms: true, whatsapp: false, promotions: false, share_usage: false, autopay: false, reminders: true, email: false, household: {} };

/** profiles.prefs: merged with defaults; set() writes the whole object back. */
export function usePrefs(userId: string) {
  const [prefs, setPrefs] = useState<Required<Prefs> | null>(null);
  useEffect(() => {
    // prefs is a private column: read through my_private_profile(), not the table.
    supabase()
      .rpc("my_private_profile")
      .then(({ data }) => setPrefs({ ...PREF_DEFAULTS, ...((data as { prefs?: Prefs | null } | null)?.prefs ?? {}) }));
  }, [userId]);

  const set = useCallback(
    async (patch: Prefs) => {
      if (!prefs) return null;
      const next = { ...prefs, ...patch };
      setPrefs(next);
      const { error } = await supabase().from("profiles").update({ prefs: next }).eq("id", userId);
      if (error) setPrefs(prefs); // roll back
      return error;
    },
    [prefs, userId],
  );
  return { prefs, set };
}

/** The customer's saved properties. */
export function useProperties(userId: string) {
  const [props, setProps] = useState<Property[] | null>(null);
  const reload = useCallback(
    () =>
      supabase()
        .from("properties")
        .select("*")
        .eq("customer_id", userId)
        .order("created_at")
        .then(({ data }) => setProps((data ?? []) as Property[])),
    [userId],
  );
  useEffect(() => {
    reload();
  }, [reload]);
  return { props, reload };
}

export type WalletInfo = { balance: number; points: number; loyalty: { points_per_omr?: number; redeem_points?: number; redeem_omr?: number } | null };

export function useWallet() {
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const reload = useCallback(
    () =>
      supabase()
        .rpc("my_wallet")
        .then(({ data }) => {
          if (data) setWallet({ balance: Number(data.balance ?? 0), points: Number(data.points ?? 0), loyalty: data.loyalty ?? null });
        }),
    [],
  );
  useEffect(() => {
    reload();
  }, [reload]);
  return { wallet, setWallet, reload };
}

export type PayMethodRow = { id: string; brand: "Visa" | "Mastercard" | "OmanNet"; last4: string; is_default: boolean; created_at: string };

export function usePaymentMethods(userId: string) {
  const [methods, setMethods] = useState<PayMethodRow[] | null>(null);
  const reload = useCallback(
    () =>
      supabase()
        .from("payment_methods")
        .select("*")
        .eq("customer_id", userId)
        .order("created_at")
        .then(({ data }) => setMethods((data ?? []) as PayMethodRow[])),
    [userId],
  );
  useEffect(() => {
    reload();
  }, [reload]);
  return { methods, reload };
}

/** The delivery windows NWS offers (0044); null while loading, [] if the call fails (the app then uses the built-in windows). */
export function useDeliveryWindows(days = 7) {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  useEffect(() => {
    let live = true;
    supabase()
      .rpc("delivery_windows", { p_days: days })
      .then(({ data, error }) => live && setRows(error ? [] : ((data ?? []) as Record<string, unknown>[])));
    return () => {
      live = false;
    };
  }, [days]);
  return rows;
}
