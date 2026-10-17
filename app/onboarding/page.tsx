"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Loading, TopBar } from "@/components/Shell";
import { useProfile } from "@/components/useProfile";
import { SERVICE_LABEL, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";

const CAPACITIES = [3000, 5000, 7000, 10000];

export default function DriverOnboarding() {
  const router = useRouter();
  const profile = useProfile("driver");
  const [plate, setPlate] = useState("");
  const [type, setType] = useState<ServiceType>("DW");
  const [capacity, setCapacity] = useState(5000);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already registered? Go straight to the driver home.
  useEffect(() => {
    if (!profile) return;
    supabase()
      .from("tankers")
      .select("driver_id")
      .eq("driver_id", profile.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) router.replace("/driver");
      });
  }, [profile, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!profile) return;
    setBusy(true);
    setError(null);
    const { error } = await supabase()
      .from("tankers")
      .insert({ driver_id: profile.id, plate: plate.trim().toUpperCase(), service_type: type, capacity_gal: capacity });
    setBusy(false);
    if (error) return setError(error.code === "23505" ? "That plate is already registered." : error.message);
    router.replace("/driver");
  }

  if (!profile) return <Loading />;

  return (
    <>
      <TopBar subtitle="Driver" />
      <main className="screen">
        <div className="ptop">
          <div>
            <h3>Your tanker</h3>
            <span className="sub">You’ll only see requests your tanker can serve.</span>
          </div>
        </div>
        <form onSubmit={submit}>
          {error && <div className="note bad">{error}</div>}
          <div className="fld">
            <label htmlFor="plate">Plate number</label>
            <input id="plate" required minLength={2} maxLength={20} placeholder="e.g. 1234 AB" value={plate} onChange={(e) => setPlate(e.target.value)} />
          </div>
          <div className="fld">
            <span className="lbl">Service type</span>
            <div className="seg" role="radiogroup" aria-label="Service type">
              {(Object.keys(SERVICE_LABEL) as ServiceType[]).map((t) => (
                <button key={t} type="button" role="radio" aria-checked={type === t} className={type === t ? "on" : ""} onClick={() => setType(t)}>
                  {t}
                </button>
              ))}
            </div>
            <p className="mut small" style={{ marginTop: -6 }}>
              <span className={`tag ${type}`}>{SERVICE_LABEL[type]}</span>
            </p>
          </div>
          <div className="fld">
            <label htmlFor="cap">Capacity (gallons)</label>
            <div className="opts" style={{ marginBottom: 8 }}>
              {CAPACITIES.map((c) => (
                <button key={c} type="button" className={`opt ${capacity === c ? "on" : ""}`} onClick={() => setCapacity(c)}>
                  {c.toLocaleString()}
                </button>
              ))}
            </div>
            <input id="cap" type="number" min={100} max={20000} step={50} required value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} />
          </div>
          <button className="cta" disabled={busy}>
            {busy ? "Saving…" : "Save and continue"}
          </button>
        </form>
      </main>
    </>
  );
}
