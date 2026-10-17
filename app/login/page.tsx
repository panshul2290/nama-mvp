"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { NamaLogo } from "@/components/icons";
import { supabase } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase().auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return setError(error.message);
    router.replace("/");
  }

  return (
    <main className="screen">
      <div className="dlogin">
        <NamaLogo className="ph-logo" />
        <h2>Water tankers you can trust, on time</h2>
        <p>Order drinking water, wastewater pickup or treated water from permitted tankers — or sign in as a driver to pick up jobs.</p>
        <form onSubmit={submit}>
          {error && <div className="banner badb">{error}</div>}
          <div className="fld">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button className="cta" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <Link href="/signup" className="cta sec">
          Create account
        </Link>
      </div>
    </main>
  );
}
