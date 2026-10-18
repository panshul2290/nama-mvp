"use client";

import { createContext, use, useCallback, useState } from "react";
import type { Profile, StaffRole } from "@/lib/types";

export type Staff = Profile & { staff_role: StaffRole };

const Ctx = createContext<{ staff: Staff; can: (r: StaffRole) => boolean; toast: (m: string, bad?: boolean) => void } | null>(null);

export const STAFF_ROLE_LABEL: Record<StaffRole, string> = { operator: "Operator", permit_officer: "Permit officer", admin: "Admin" };

export function StaffProvider({ staff, children }: { staff: Staff; children: React.ReactNode }) {
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const toast = useCallback((text: string, bad = false) => {
    setMsg({ text, bad });
    setTimeout(() => setMsg((m) => (m?.text === text ? null : m)), 4000);
  }, []);
  // UI hint only: the database enforces the sub-role in every staff RPC.
  const can = useCallback((r: StaffRole) => staff.staff_role === r, [staff.staff_role]);
  return (
    <Ctx value={{ staff, can, toast }}>
      {children}
      {msg && (
        <div className={`toastn ${msg.bad ? "bad" : ""}`} role="status">
          {msg.text}
        </div>
      )}
    </Ctx>
  );
}

export function useStaff() {
  const v = use(Ctx);
  if (!v) throw new Error("useStaff must be used inside the NWS layout");
  return v;
}

/** A small modal asking for a mandatory reason (blocks, rejections, overrides). */
export function ReasonDialog({
  title,
  body,
  confirm,
  danger,
  extra,
  onCancel,
  onConfirm,
}: {
  title: string;
  body?: string;
  confirm: string;
  danger?: boolean;
  extra?: React.ReactNode;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="dlg" role="dialog" aria-modal="true" aria-label={title} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {body && <p>{body}</p>}
        {extra}
        <div className="fld">
          <label htmlFor="reason">Reason (required, kept in the audit log)</label>
          <textarea id="reason" className="in" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? "bad" : "pri"}`}
            disabled={busy || reason.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              await onConfirm(reason.trim());
              setBusy(false);
            }}
          >
            {busy ? "Saving…" : confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");
