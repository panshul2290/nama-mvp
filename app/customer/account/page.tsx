"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useCustomer } from "@/components/CustomerContext";
import { initials } from "@/lib/format";
import { supabase } from "@/lib/supabase/client";

export default function AccountPage() {
  const router = useRouter();
  const profile = useCustomer();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    supabase()
      .auth.getUser()
      .then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);

  async function signOut() {
    await supabase().auth.signOut();
    router.replace("/login");
  }

  return (
    <main className="screen">
      <div className="ptop">
        <h3>Account</h3>
      </div>
      <div className="dcard">
        <div className="dc-top">
          <span className="av">{initials(profile.full_name)}</span>
          <div>
            <b>{profile.full_name || "Customer"}</b>
            <small>{email}</small>
          </div>
        </div>
      </div>
      <div className="ch-list">
        <div className="lrow">
          <span>
            Mobile number
            <small>{profile.phone || "Not set"}</small>
          </span>
        </div>
        <div className="lrow">
          <span>
            Account type
            <small>Customer</small>
          </span>
        </div>
      </div>
      <button className="cta danger" onClick={signOut}>
        Sign out
      </button>
    </main>
  );
}
