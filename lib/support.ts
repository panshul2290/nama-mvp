"use client";

// NWS settings the apps read for the fallback (0043): the call centre and WhatsApp booking
// numbers, the public web address for shared links, and the payment outage switch.
import { useEffect, useState } from "react";
import { supabase } from "./supabase/client";

export type Support = { call_centre: string; whatsapp: string; public_url: string; no_tanker_min: number; outage: boolean };
export const SUPPORT_DEFAULT: Support = { call_centre: "1442", whatsapp: "", public_url: "", no_tanker_min: 20, outage: false };

export function useSupport(): Support {
  const [s, setS] = useState<Support>(SUPPORT_DEFAULT);
  useEffect(() => {
    let live = true;
    supabase()
      .from("app_settings")
      .select("key, value")
      .in("key", ["SUPPORT_CONTACTS", "PAYMENT_OUTAGE_MODE"])
      .then(({ data }) => {
        if (!live || !data) return;
        const by = Object.fromEntries((data as { key: string; value: string }[]).map((r) => [r.key, r.value]));
        let c: Partial<Support> = {};
        try {
          c = JSON.parse(by.SUPPORT_CONTACTS ?? "{}");
        } catch {
          c = {};
        }
        setS({ ...SUPPORT_DEFAULT, ...c, outage: by.PAYMENT_OUTAGE_MODE === "on" });
      });
    return () => {
      live = false;
    };
  }, []);
  return s;
}

/** wa.me link with a prefilled message (the number without "+"). */
export const waLink = (e164: string, text: string) => `https://wa.me/${e164.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;

/** tel: link for a number as typed (spaces dropped). */
export const telLink = (n: string) => `tel:${n.replace(/[^\d+]/g, "")}`;

/** Base address for links shared outside the app (route share): the NWS setting, else this site. */
export const publicBase = (s: Support) =>
  s.public_url || (typeof window !== "undefined" && window.location.protocol.startsWith("http") ? window.location.origin : "");
