"use client";

import { useState } from "react";
import { useToastn } from "@/components/portal/kit";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";

// First step for a new owner account: the company itself (public.owner_register_company).
export function RegisterCompany({ onDone }: { onDone: () => void }) {
  const toast = useToastn();
  const [f, setF] = useState({ name: "", cr: "", phone: "", bank: "", iban: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((v) => ({ ...v, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase().rpc("owner_register_company", {
      p_name: f.name.trim(),
      p_cr_no: f.cr.trim(),
      p_phone: f.phone.trim() || null,
      p_bank_name: f.bank.trim() || null,
      p_iban: f.iban.trim() || null,
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    toast("Company registered — waiting for NWS approval");
    onDone();
  }

  return (
    <div className="reg">
      <div className="steps3">
        <div>
          <b>1 · Company</b>Commercial registration and the bank account for weekly payouts.
        </div>
        <div>
          <b>2 · Tankers and drivers</b>Register each tanker (an IVMS device is provisioned) and add your drivers.
        </div>
        <div>
          <b>3 · Permits</b>Upload documents and apply for an NWS permit for every tanker.
        </div>
      </div>
      <form className="panel" onSubmit={submit}>
        <h2>Company details</h2>
        <div className="pad">
          {error && <div className="banner badb">{error}</div>}
          <div className="form">
            <div className="fld full">
              <label htmlFor="rcN">Company name</label>
              <input id="rcN" className="in" required minLength={2} maxLength={120} value={f.name} onChange={set("name")} placeholder="Al Harthy Water Transport LLC" />
            </div>
            <div className="fld">
              <label htmlFor="rcC">Commercial registration (CR) number</label>
              <input id="rcC" className="in" required minLength={3} maxLength={30} value={f.cr} onChange={set("cr")} placeholder="1234567" />
            </div>
            <div className="fld">
              <label htmlFor="rcP">Company phone</label>
              <input id="rcP" className="in" type="tel" maxLength={32} value={f.phone} onChange={set("phone")} placeholder="+968 2400 0000" dir="ltr" />
            </div>
            <div className="fld">
              <label htmlFor="rcB">Bank</label>
              <input id="rcB" className="in" maxLength={80} value={f.bank} onChange={set("bank")} placeholder="Bank Muscat" />
            </div>
            <div className="fld">
              <label htmlFor="rcI">IBAN</label>
              <input id="rcI" className="in" maxLength={40} value={f.iban} onChange={set("iban")} placeholder="OM81 0270 0000 0000 0000 000" dir="ltr" />
            </div>
          </div>
          <div className="btns">
            <button className="btn pri" disabled={busy}>
              {busy ? "Registering…" : "Register company"}
            </button>
          </div>
          <p className="mut" style={{ fontSize: 12.5, margin: "12px 0 0" }}>
            NWS checks your CR with the Ministry of Commerce (simulated) before approving. Bank details are only visible to you and NWS finance.
          </p>
        </div>
      </form>
    </div>
  );
}
