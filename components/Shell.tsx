"use client";

import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

export function Brand() {
  return (
    <span className="brand">
      <i aria-hidden="true" />
      Nama Tanker
    </span>
  );
}

export function TopBar({ subtitle, right }: { subtitle?: string; right?: React.ReactNode }) {
  const router = useRouter();
  async function signOut() {
    await supabase().auth.signOut();
    router.replace("/login");
  }
  return (
    <header className="topbar">
      <Brand />
      {subtitle && <small>{subtitle}</small>}
      <span className="sp" />
      {right}
      <button className="lk small" onClick={signOut}>
        Sign out
      </button>
    </header>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="spin" role="status">
      {label}
    </div>
  );
}
