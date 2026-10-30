"use client";

// Public, read-only live route shared by a driver (0042): the tanker's position and the
// destination area (rounded to about 1 km), while the link is valid. No sign-in; nothing about
// the customer or the driver beyond the plate.
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Map } from "@/components/Map";
import { Loading } from "@/components/Shell";
import { ADDR } from "@/lib/addressI18n";
import { DEFAULT_CENTER } from "@/lib/geo";
import { LangToggle, localDigits, useLang, useT } from "@/lib/i18n";
import { scratchClient } from "@/lib/supabase/client";
import { omanTime } from "@/lib/time";

type Shared = {
  state: "live" | "expired" | "revoked" | "invalid";
  expires_at?: string;
  plate?: string;
  service?: "DW" | "WW" | "TE";
  position?: { lat: number; lng: number; at: string; age_s: number } | null;
  job?: { stage: "on_the_way" | "at_destination" | "to_plant"; area: string; zone: string | null; lat: number; lng: number } | null;
};

export default function SharedRoutePage() {
  return (
    <Suspense fallback={<Loading />}>
      <SharedRoute />
    </Suspense>
  );
}

function SharedRoute() {
  const token = useSearchParams().get("t") ?? "";
  const t = useT(ADDR);
  const { lang } = useLang();
  const [data, setData] = useState<Shared | null>(null);
  useEffect(() => {
    const db = scratchClient();
    let live = true;
    const load = () =>
      db.rpc("shared_route", { p_token: token }).then(({ data, error }) => {
        if (live) setData(error ? { state: "invalid" } : ((data as Shared) ?? { state: "invalid" }));
      });
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [token]);

  if (!data) return <Loading />;
  if (data.state !== "live")
    return (
      <main className="screen">
        <div className="ptop">
          <h3>{t("shTitle")}</h3>
          <LangToggle />
        </div>
        <div className="banner">{t(data.state === "expired" ? "shExpired" : data.state === "revoked" ? "shRevoked" : "shInvalid")}</div>
      </main>
    );
  const pos = data.position ? { lat: data.position.lat, lng: data.position.lng } : null;
  const dest = data.job ? { lat: data.job.lat, lng: data.job.lng } : null;
  const area = data.job ? [data.job.area, data.job.zone].filter(Boolean).join(" · ") : "";
  return (
    <main className="screen flush">
      <div className="tr-map">
        <Map center={pos ?? dest ?? DEFAULT_CENTER} tanker={pos} destination={dest} service={data.service} follow padBottom={30} />
      </div>
      <div className="sheet2">
        <div className="row">
          <h3 className="tj-t">{t("shTitle")}</h3>
          <LangToggle />
        </div>
        <p>
          <span className="plate" dir="ltr">
            {data.plate}
          </span>{" "}
          {data.job ? t(data.job.stage === "at_destination" ? "shAtDest" : data.job.stage === "to_plant" ? "shToPlant" : "shOnWay", { area }) : t("shNoJob")}
        </p>
        <p className="mut small">{data.position ? t("shUpdated", { n: localDigits(data.position.age_s, lang) }) : t("shNoFix")}</p>
        {dest && <p className="mut small">{t("shArea")}</p>}
        {data.expires_at && <p className="mut small">{t("shUntil", { time: omanTime(data.expires_at, lang === "ar" ? "ar-OM" : "en-GB") })}</p>}
        <p className="mut small">{t("shBy")}</p>
      </div>
    </main>
  );
}
