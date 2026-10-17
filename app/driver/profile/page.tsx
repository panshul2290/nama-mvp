"use client";

import { useRouter } from "next/navigation";
import { useDriver } from "@/components/DriverContext";
import { SERVICE_SHORT, TypeTag } from "@/components/OrderBits";
import { initials } from "@/lib/format";
import { supabase } from "@/lib/supabase/client";

export default function DriverProfile() {
  const router = useRouter();
  const { profile, tanker } = useDriver();

  async function signOut() {
    await supabase().auth.signOut();
    router.replace("/login");
  }

  return (
    <main className="screen">
      <div className="ptop">
        <h3>Profile</h3>
      </div>
      <div className="dcard">
        <div className="dc-top">
          <span className="av">{initials(profile.full_name)}</span>
          <div>
            <b>{profile.full_name || "Driver"}</b>
            <small>{profile.phone || "No mobile number"}</small>
          </div>
        </div>
      </div>
      <h4 className="ch-sec">Tanker</h4>
      <div className="ch-list">
        <div className="lrow">
          <span>
            Plate
            <small>{tanker.plate}</small>
          </span>
          <span className="plate">{tanker.plate}</span>
        </div>
        <div className="lrow">
          <span>
            Service
            <small>{SERVICE_SHORT[tanker.service_type]}</small>
          </span>
          <TypeTag type={tanker.service_type} />
        </div>
        <div className="lrow">
          <span>
            Capacity
            <small>{tanker.capacity_gal.toLocaleString()} gallons</small>
          </span>
        </div>
      </div>
      <button className="cta danger" onClick={signOut}>
        Sign out
      </button>
    </main>
  );
}
