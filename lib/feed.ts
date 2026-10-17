"use client";

import { supabase } from "./supabase/client";

// Broadcast channel that tells drivers a request is no longer open.
// Needed because once an order is accepted or cancelled, RLS hides it from
// other drivers, so they never receive its Postgres Changes UPDATE.
export const FEED_CHANNEL = "open-requests";
export const GONE_EVENT = "gone";

export async function announceGone(orderId: string) {
  const db = supabase();
  const ch = db.channel(FEED_CHANNEL);
  try {
    await ch.httpSend(GONE_EVENT, { id: orderId });
  } finally {
    db.removeChannel(ch);
  }
}
