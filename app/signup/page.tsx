"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Brand } from "@/components/Shell";
import { supabase } from "@/lib/supabase/client";
import type { Role } from "@/lib/types";

export default function SignupPage() {
  const router = useRouter();
  const [role, setRole] = useState<Role>("customer");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error } = await supabase().auth.signUp({
      email,
      password,
      options: {
        data: { role, full_name: fullName.trim(), phone: phone.trim() || null },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    setBusy(false);
    if (error) return setError(error.message);
    if (!data.session) return setSentTo(email);
    router.replace(role === "driver" ? "/onboarding" : "/customer");
  }

  if (sentTo) {
    return (
      <main className="screen">
        <Brand />
        <div className="hero">
          <h2>Check your email</h2>
          <p>
            We sent a confirmation link to <b>{sentTo}</b>. Open it on this device to finish signing up.
          </p>
        </div>
        <Link href="/login" className="cta sec">
          Back to sign in
        </Link>
      </main>
    );
  }

  return (
    <main className="screen">
      <div className="ptop">
        <h3>Create account</h3>
        <Link href="/login" className="small">
          Sign in
        </Link>
      </div>
      <form onSubmit={submit}>
        <div className="fld">
          <span className="lbl">I am a</span>
          <div className="seg" role="radiogroup" aria-label="Account type">
            {(["customer", "driver"] as Role[]).map((r) => (
              <button key={r} type="button" role="radio" aria-checked={role === r} className={role === r ? "on" : ""} onClick={() => setRole(r)}>
                {r === "customer" ? "Customer" : "Driver"}
              </button>
            ))}
          </div>
          <p className="mut small" style={{ marginTop: -6 }}>
            {role === "customer" ? "Order drinking water, wastewater pickup or treated effluent." : "You’ll add your tanker details next."}
          </p>
        </div>
        {error && <div className="note bad">{error}</div>}
        <div className="fld">
          <label htmlFor="name">Full name</label>
          <input id="name" required maxLength={120} autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="fld">
          <label htmlFor="phone">Mobile (optional)</label>
          <input id="phone" type="tel" maxLength={32} autoComplete="tel" dir="ltr" placeholder="+968" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="fld">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="fld">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" required minLength={6} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="cta" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>
    </main>
  );
}
