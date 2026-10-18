"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SERVICE_SHORT } from "@/components/OrderBits";
import { Loading } from "@/components/Shell";
import { useProfile } from "@/components/useProfile";
import { SERVICE_LABEL, type ServiceType } from "@/lib/pricing";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";

const CAPACITIES = [3000, 5000, 7000, 10000];
const TYPE_NOTE: Record<ServiceType, string> = {
  DW: "Potable water from NWS filling stations",
  WW: "Septic tank pickup, discharged at an approved STP",
  TE: "For irrigation and construction — not for drinking",
};
const COLOR: Record<ServiceType, string> = { DW: "var(--dw)", WW: "var(--ww)", TE: "var(--te)" };

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
      .select("id")
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
    // Interim: drivers register their own tanker. Assignment will move to the tanker
    // company portal, with NWS operator assignment kept as an override.
    const { error } = await supabase().rpc("driver_register_tanker", { p_plate: plate, p_service_type: type, p_capacity_gal: capacity });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    router.replace("/driver");
  }

  if (!profile) return <Loading />;

  return (
    <main className="screen">
      <div className="rq-h">
        <div>
          <h3>Your tanker</h3>
          <small>You’ll only see requests your tanker can serve</small>
        </div>
      </div>
      <form onSubmit={submit}>
        {error && <div className="banner badb">{error}</div>}
        <div className="fld">
          <label htmlFor="plate">Plate number</label>
          <input id="plate" required minLength={2} maxLength={20} placeholder="e.g. OM 4821 AR" value={plate} onChange={(e) => setPlate(e.target.value)} />
        </div>

        <h4 className="ch-sec">Service</h4>
        <div className="svc" role="radiogroup" aria-label="Service type">
          {(Object.keys(SERVICE_LABEL) as ServiceType[]).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={type === t} className={type === t ? "on" : ""} onClick={() => setType(t)}>
              <i style={{ background: COLOR[t] }} />
              <div>
                <b>{SERVICE_SHORT[t]}</b>
                <span>{TYPE_NOTE[t]}</span>
              </div>
            </button>
          ))}
        </div>

        <h4 className="ch-sec">Capacity (gallons)</h4>
        <div className="opts" style={{ marginBottom: 10 }}>
          {CAPACITIES.map((c) => (
            <button key={c} type="button" className={`opt ${capacity === c ? "on" : ""}`} onClick={() => setCapacity(c)}>
              {c.toLocaleString()}
            </button>
          ))}
        </div>
        <div className="fld">
          <label htmlFor="cap">Or enter capacity</label>
          <input id="cap" type="number" min={100} max={20000} step={50} required value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} />
        </div>
        <button className="cta" disabled={busy}>
          {busy ? "Saving…" : "Save and continue"}
        </button>
      </form>
    </main>
  );
}
