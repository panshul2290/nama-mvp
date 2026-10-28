"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { NamaLogo } from "@/components/icons";
import { supabase } from "@/lib/supabase/client";

// Landing page of the "Forgot password?" email: the recovery link signs the user
// in (via /auth/callback), then they choose a new password here.
export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("The two passwords don’t match.");
    setBusy(true);
    setError(null);
    const { error } = await supabase().auth.updateUser({ password });
    setBusy(false);
    if (error) return setError(error.message.includes("session") ? "This reset link has expired. Request a new one from the sign-in screen." : error.message);
    router.replace("/");
  }

  return (
    <main className="screen">
      <div className="dlogin">
        <NamaLogo className="ph-logo" />
        <h2>Choose a new password</h2>
        <p>Use at least 6 characters. You’ll stay signed in on this device.</p>
        <form onSubmit={submit}>
          {error && <div className="banner badb">{error}</div>}
          <div className="fld">
            <label htmlFor="pw">New password</label>
            <input id="pw" type="password" required minLength={6} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="pw2">Repeat new password</label>
            <input id="pw2" type="password" required minLength={6} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          <button className="cta" disabled={busy}>
            {busy ? "Saving…" : "Save password"}
          </button>
        </form>
        <Link href="/login" className="cta sec">
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
