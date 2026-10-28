"use client";

import { useState } from "react";
import { DICT, useErrText, useFmt } from "@/components/driver/i18n";
import { useMyInvitations } from "@/components/useInvitations";
import { useT } from "@/lib/i18n";

/** Pending company invitations for this driver (Home, Profile and onboarding), with Accept / Decline. */
export function InvitationCards({ onJoined, toast }: { onJoined?: () => void; toast: (m: string) => void }) {
  const t = useT(DICT);
  const f = useFmt();
  const errText = useErrText();
  const { invitations, respond } = useMyInvitations("driver");
  const [busy, setBusy] = useState<string | null>(null);

  async function answer(id: string, accept: boolean, company: string) {
    setBusy(id);
    const error = await respond(id, accept);
    setBusy(null);
    if (error) return toast(errText(error));
    toast(accept ? t("inviteAccepted", { company }) : t("inviteDeclined"));
    if (accept) onJoined?.();
  }

  return invitations.map((i) => {
    const company = i.from ?? t("inviteCompany");
    return (
      <div key={i.id} className="card hl" role="status">
        <h4>{t("inviteT", { company })}</h4>
        <p>{t("inviteS", { date: f.date(i.expires_at) })}</p>
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <button className="btn pri" disabled={busy !== null} onClick={() => answer(i.id, true, company)}>
            {t("accept")}
          </button>
          <button className="btn" disabled={busy !== null} onClick={() => answer(i.id, false, company)}>
            {t("decline")}
          </button>
        </div>
      </div>
    );
  });
}
