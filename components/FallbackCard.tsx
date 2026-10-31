"use client";

// Fallback when the app can't place an order (0043): "Call Nama 1442" (the number as selectable
// text and a call link) and "Book on WhatsApp" (wa.me, prefilled with the service, volume and a
// location link in the app's language). Numbers come from the NWS setting SUPPORT_CONTACTS.
import { Icon } from "@/components/icons";
import { mapLink } from "@/lib/address";
import { ADDR } from "@/lib/addressI18n";
import { localDigits, useLang, useT } from "@/lib/i18n";
import type { ServiceType } from "@/lib/pricing";
import { telLink, useSupport, waLink } from "@/lib/support";

export function FallbackCard({
  reason = "fbS",
  service,
  gallons,
  point,
  compact = false,
}: {
  reason?: "fbS" | "fbNoTanker" | "helpS";
  service?: ServiceType;
  gallons?: number;
  point?: { lat: number; lng: number } | null;
  compact?: boolean;
}) {
  const t = useT(ADDR);
  const { lang } = useLang();
  const s = useSupport();
  const text = t("fbWaText", {
    service: service ? t(service) : "—",
    gallons: gallons ? gallons.toLocaleString("en-US") : "—",
    link: point ? mapLink(point.lat, point.lng) : "—",
  });
  return (
    <div className={`fallback ${compact ? "compact" : ""}`} role="note">
      <b>{reason === "helpS" ? t("helpT") : t("fbT")}</b>
      <small>{t(reason === "helpS" && !s.whatsapp ? "helpSCall" : reason)}</small>
      <div className="fb-btns">
        <a className="btn sm pri" href={telLink(s.call_centre)}>
          <Icon name="phone" />
          {t("fbCall", { n: localDigits(s.call_centre, lang) })}
        </a>
        {s.whatsapp && (
          <a className="btn sm" href={waLink(s.whatsapp, text)} target="_blank" rel="noopener noreferrer">
            {t("fbWa")}
          </a>
        )}
      </div>
      <small className="fb-num">
        {t("fbNum", { n: "" })}
        <bdi dir="ltr" className="sel">
          {s.call_centre}
        </bdi>
        {s.whatsapp && (
          <>
            {" · WhatsApp "}
            <bdi dir="ltr" className="sel">
              {s.whatsapp}
            </bdi>
          </>
        )}
      </small>
    </div>
  );
}
