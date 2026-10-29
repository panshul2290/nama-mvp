"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { Invitation } from "@/lib/types";

/** A pending invitation addressed to the signed-in user, with the inviter's name when it can be read. */
export type MyInvitation = Invitation & { from: string | null };

/**
 * Pending, unexpired invitations sent to the signed-in user's verified mobile number or
 * confirmed email (company → driver, organisation → business user). RLS returns the same
 * set (invitation_is_mine); the filter here also drops the organisation's own outgoing
 * invitations that a business admin can read. respond() accepts or declines through respond_invitation.
 */
export function useMyInvitations(kind: Invitation["kind"], enabled = true) {
  const [items, setItems] = useState<MyInvitation[]>([]);

  const load = useCallback(async () => {
    const db = supabase();
    const { data: auth } = await db.auth.getUser();
    const u = auth.user;
    // Supabase stores the phone without "+"; invitations store E.164 and lower-cased emails.
    const phone = u?.phone && u.phone_confirmed_at ? `+${u.phone.replace(/^\+/, "")}` : null;
    const email = u?.email && u.email_confirmed_at ? u.email.toLowerCase() : null;
    if (!phone && !email) return setItems([]);
    const { data } = await db
      .from("invitations")
      .select("*")
      .eq("kind", kind)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });
    const rows = ((data ?? []) as Invitation[]).filter((r) => (phone && r.phone === phone) || (email && r.email === email));
    const ids = [...new Set(rows.map((r) => (kind === "driver" ? r.company_id : r.org_id)).filter(Boolean))] as string[];
    const names = new Map<string, string>();
    if (ids.length) {
      // Companies are readable once active; an organisation's name may not be readable before joining.
      const { data: n } = await db.from(kind === "driver" ? "companies" : "organizations").select("id, name").in("id", ids);
      for (const x of (n ?? []) as { id: string; name: string }[]) names.set(x.id, x.name);
    }
    setItems(rows.map((r) => ({ ...r, from: names.get((kind === "driver" ? r.company_id : r.org_id) ?? "") ?? null })));
  }, [kind]);

  useEffect(() => {
    if (!enabled) return;
    const first = setTimeout(load, 0);
    const timer = setInterval(load, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [enabled, load]);

  const respond = useCallback(
    async (id: string, accept: boolean) => {
      const { error } = await supabase().rpc("respond_invitation", { p_id: id, p_accept: accept });
      await load();
      return error;
    },
    [load],
  );

  return { invitations: items, respond, reload: load };
}

/** The inviter's pending invitations (company drivers or organisation members), with revoke. */
export function useSentInvitations(kind: Invitation["kind"], ownerId: string | null | undefined) {
  const [items, setItems] = useState<(Invitation & { expired: boolean })[]>([]);
  const load = useCallback(async () => {
    if (!ownerId) return;
    const { data } = await supabase()
      .from("invitations")
      .select("*")
      .eq("kind", kind)
      .eq(kind === "driver" ? "company_id" : "org_id", ownerId)
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    // An expired invitation still blocks a new one to the same number or email until it is revoked.
    const now = Date.now();
    setItems(((data ?? []) as Invitation[]).map((i) => ({ ...i, expired: Date.parse(i.expires_at) < now })));
  }, [kind, ownerId]);
  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);
  return { invitations: items, reload: load };
}
