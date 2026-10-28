"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DICT, useErrText } from "@/components/driver/i18n";
import { Loading } from "@/components/Shell";
import { useProfile } from "@/components/useProfile";
import { LangToggle, useT } from "@/lib/i18n";
import { SERVICE_LABEL, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";

const CAPACITIES = [3000, 5000, 7000, 10000];
const COLOR: Record<ServiceType, string> = { DW: "var(--dw)", WW: "var(--ww)", TE: "var(--te)" };

export default function DriverOnboarding() {
  const router = useRouter();
  const profile = useProfile("driver");
  const t = useT(DICT);
  const errText = useErrText();
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
    if (error) return setError(errText(error));
    router.replace("/driver");
  }

  if (!profile) return <Loading />;

  return (
    <main className="screen">
      <div className="rq-h">
        <div>
          <h3>{t("obTitle")}</h3>
          <small>{t("obSub")}</small>
        </div>
        <span className="sp" style={{ flex: 1 }} />
        <LangToggle />
      </div>
      <form onSubmit={submit}>
        {error && <div className="banner badb">{error}</div>}
        <div className="fld">
          <label htmlFor="plate">{t("obPlate")}</label>
          <input id="plate" required minLength={2} maxLength={20} placeholder={t("obPlateEg")} value={plate} onChange={(e) => setPlate(e.target.value)} />
        </div>

        <h4 className="ch-sec">{t("obService")}</h4>
        <div className="svc" role="radiogroup" aria-label={t("obService")}>
          {(Object.keys(SERVICE_LABEL) as ServiceType[]).map((s) => (
            <button key={s} type="button" role="radio" aria-checked={type === s} className={type === s ? "on" : ""} onClick={() => setType(s)}>
              <i style={{ background: COLOR[s] }} />
              <div>
                <b>{t(`svc_${s}`)}</b>
                <span>{t(`svcNote_${s}`)}</span>
              </div>
            </button>
          ))}
        </div>

        <h4 className="ch-sec">{t("obCapacity")}</h4>
        <div className="opts" style={{ marginBottom: 10 }}>
          {CAPACITIES.map((c) => (
            <button key={c} type="button" className={`opt ${capacity === c ? "on" : ""}`} onClick={() => setCapacity(c)}>
              {c.toLocaleString()}
            </button>
          ))}
        </div>
        <div className="fld">
          <label htmlFor="cap">{t("obOrEnter")}</label>
          <input id="cap" type="number" min={100} max={20000} step={50} required value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} />
        </div>
        <button className="cta" disabled={busy}>
          {busy ? t("saving") : t("obSave")}
        </button>
      </form>
    </main>
  );
}
