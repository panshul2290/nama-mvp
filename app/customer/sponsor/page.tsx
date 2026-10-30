"use client";

// Sponsor a tanker (0045): water for a mosque, a family in need or a community site from the list
// NWS approves, or for any approved site in a wilayat. Paid like a normal order; the sponsor gets
// the receipt and a thank-you with the delivery photo, and can stay anonymous to the beneficiary.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useCustomer } from "@/components/CustomerContext";
import { usePaymentMethods, useWallet } from "@/components/customer/hooks";
import { useCx } from "@/components/customer/i18n";
import { gal, omr3 } from "@/components/customer/fmt";
import { Toggle } from "@/components/customer/ui";
import { BackButton } from "@/components/Shell";
import { friendlyError } from "@/lib/errors";
import { VOLUME_PRESETS } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { ref, type Order } from "@/lib/types";

type Site = { id: string; name: string; name_ar: string; kind: "mosque" | "family" | "community"; wilayat_code: string; wilayat: string; wilayat_ar: string; governorate_code: string };
type Mine = { order_id: string; order_no: number; status: string; site: string; site_ar: string; gallons: number; total: string; anonymous: boolean; created_at: string };

export default function SponsorPage() {
  const profile = useCustomer();
  const { t, lang } = useCx();
  const router = useRouter();
  const { wallet } = useWallet();
  const { methods } = usePaymentMethods(profile.id);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [mine, setMine] = useState<Mine[]>([]);
  const [pick, setPick] = useState<string>("");
  const [type, setType] = useState<"DW" | "TE">("DW");
  const [gallons, setGallons] = useState(3000);
  const [anon, setAnon] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    supabase()
      .rpc("charity_sites")
      .then(({ data }) => setSites((data ?? []) as Site[]));
    supabase()
      .rpc("my_sponsorships")
      .then(({ data }) => setMine((data ?? []) as Mine[]));
  }, []);
  const ar = lang === "ar";
  // Pick a site ("s:<id>") or any approved site in a wilayat ("w:<code>").
  const wilayats = useMemo(() => [...new Map((sites ?? []).map((s) => [s.wilayat_code, s])).values()], [sites]);
  const card = (methods ?? []).find((m) => m.is_default && m.brand !== "OmanNet") ?? (methods ?? []).find((m) => m.brand !== "OmanNet");
  const balance = wallet?.balance ?? 0;

  async function sponsor() {
    setBusy(true);
    setError(null);
    const [kind, val] = pick.split(":");
    const { data, error } = await supabase()
      .rpc("sponsor_order", {
        p_site_id: kind === "s" ? val : null,
        p_wilayat: kind === "w" ? val : null,
        p_service_type: type,
        p_gallons: gallons,
        p_pay_method: balance > 0 ? "wallet_card" : "card",
        p_card_last4: card?.last4 ?? null,
        p_anonymous: anon,
        p_message: msg.trim() || null,
      })
      .single<Order>();
    setBusy(false);
    if (error || !data) return setError(friendlyError(error));
    if (data.status === "cancelled") return setError(t("payFailT"));
    router.replace(`/customer/order?id=${data.id}`);
  }

  return (
    <main className="screen">
      <div className="rq-h">
        <BackButton href="/customer" label={t("back")} />
        <div>
          <h3>{t("spT")}</h3>
          <small>{t("spS")}</small>
        </div>
      </div>
      {sites === null ? (
        <div className="empty">{t("loading")}</div>
      ) : sites.length === 0 ? (
        <div className="empty">{t("spNone")}</div>
      ) : (
        <>
          <h4 className="ch-sec">{t("spWhere")}</h4>
          <div className="rq-card" role="radiogroup" aria-label={t("spWhere")}>
            {sites.map((s) => (
              <button key={s.id} type="button" role="radio" aria-checked={pick === `s:${s.id}`} className="pm" onClick={() => setPick(`s:${s.id}`)}>
                <span>
                  <b>{ar ? s.name_ar : s.name}</b>
                  <small>
                    {t(`spK_${s.kind}`)} · {ar ? s.wilayat_ar : s.wilayat}
                  </small>
                </span>
                <i className={`radio ${pick === `s:${s.id}` ? "on" : ""}`} />
              </button>
            ))}
            {wilayats.map((s) => (
              <button key={s.wilayat_code} type="button" role="radio" aria-checked={pick === `w:${s.wilayat_code}`} className="pm" onClick={() => setPick(`w:${s.wilayat_code}`)}>
                <span>
                  <b>{t("spAny", { w: ar ? s.wilayat_ar : s.wilayat })}</b>
                  <small>{t("spAnyS")}</small>
                </span>
                <i className={`radio ${pick === `w:${s.wilayat_code}` ? "on" : ""}`} />
              </button>
            ))}
          </div>
          <h4 className="ch-sec">{t("volume")}</h4>
          <div className="seg" role="tablist" aria-label={t("s1")}>
            {(["DW", "TE"] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={type === k} className={type === k ? "on" : ""} onClick={() => setType(k)}>
                {t(`${k}q`)}
              </button>
            ))}
          </div>
          <div className="opts" style={{ marginTop: 10 }}>
            {VOLUME_PRESETS[type].map((v) => (
              <button key={v} type="button" className={`opt ${gallons === v ? "on" : ""}`} onClick={() => setGallons(v)}>
                {v.toLocaleString("en-US")}
              </button>
            ))}
          </div>
          <div className="rq-card rq-split" style={{ marginTop: 14 }}>
            <div>
              <b>{t("spAnon")}</b>
              <small>{t("spAnonS")}</small>
            </div>
            <Toggle on={anon} onChange={setAnon} label={t("spAnon")} />
          </div>
          <div className="fld">
            <label htmlFor="spM">{t("spMsg")}</label>
            <input id="spM" maxLength={200} value={msg} onChange={(e) => setMsg(e.target.value)} />
          </div>
          <p className="mut small">{t("spPay")}</p>
          {error && <div className="banner badb">{error}</div>}
          <button className="cta" disabled={busy || !pick} onClick={sponsor}>
            {busy ? t("paying") : t("spBtn")}
          </button>
        </>
      )}
      {mine.length > 0 && (
        <>
          <h4 className="ch-sec">{t("spMine")}</h4>
          <div className="ch-list">
            {mine.map((m) => (
              <Link key={m.order_id} href={`/customer/order?id=${m.order_id}`} className="lrow">
                <span>
                  <b>{ar ? m.site_ar : m.site}</b>
                  <small>
                    {ref.order(m.order_no)} · {gal(m.gallons, lang)} · {omr3(m.total, lang)}
                    {m.anonymous ? ` · ${t("spAnonTag")}` : ""}
                  </small>
                </span>
                <span className={`st ${m.status === "delivered" ? "ok" : "act"}`}>{t(`st_${m.status}`)}</span>
              </Link>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
