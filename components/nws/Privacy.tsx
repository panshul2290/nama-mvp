"use client";

import { useEffect, useState } from "react";
import { maskPhone } from "@/components/nws/ops";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";

// F11: phone numbers are masked on NWS screens for roles outside PRIVACY.privileged_roles;
// ID numbers are always masked (encrypted at rest, 0027). Privileged roles reveal one
// value at a time through an audited RPC.

const T = {
  reveal: "Reveal",
  revealPhone: "Reveal mobile number",
  revealId: "Reveal ID number",
  body: "The full value is shown once and the reveal is written to the audit log with your reason.",
};

/** { privileged, maskPhones }: whether this staff member may reveal, and whether phones are masked for them. */
export function usePrivacy() {
  const [state, setState] = useState<{ privileged: boolean; maskPhones: boolean }>({ privileged: false, maskPhones: true });
  useEffect(() => {
    const db = supabase();
    Promise.all([db.rpc("staff_privileged"), db.from("app_settings").select("value").eq("key", "PRIVACY").maybeSingle<{ value: string }>()]).then(([p, s]) => {
      let mask = true;
      try {
        mask = s.data ? JSON.parse(s.data.value).mask_phone !== false : true;
      } catch {
        mask = true;
      }
      const privileged = p.data === true;
      setState({ privileged, maskPhones: mask && !privileged });
    });
  }, []);
  return state;
}

/** A phone number as this viewer may see it. */
export function Phone({ value, maskPhones }: { value: string | null | undefined; maskPhones: boolean }) {
  if (!value) return <>—</>;
  return <span dir="ltr">{maskPhones ? maskPhone(value) : value}</span>;
}

/** "Reveal" for one person's phone ("contact") or ID number ("identity"). */
export function RevealButton({ profileId, kind, privileged }: { profileId: string; kind: "contact" | "identity"; privileged: boolean }) {
  const { toast } = useStaff();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<string | null>(null);
  if (!privileged) return null;
  if (value) return <code dir="ltr" style={{ marginInlineStart: 6 }}>{value}</code>;
  return (
    <>
      <button type="button" className="btn sm ghost" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>{T.reveal}</button>
      {open && (
        <ReasonDialog
          title={kind === "contact" ? T.revealPhone : T.revealId}
          body={T.body}
          confirm={T.reveal}
          onCancel={() => setOpen(false)}
          onConfirm={async (reason) => {
            const { data, error } = await supabase().rpc(kind === "contact" ? "staff_reveal_contact" : "staff_reveal_identity", { p_profile: profileId, p_reason: reason });
            if (error) return toast(friendlyError(error), true);
            const d = (data ?? {}) as { phone?: string | null; email?: string | null; id_no?: string | null };
            setValue(kind === "contact" ? [d.phone, d.email].filter(Boolean).join(" · ") || "—" : d.id_no ?? "—");
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
