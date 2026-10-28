"use client";

import { useCallback, useEffect, useState } from "react";
import { useCustomer } from "@/components/CustomerContext";
import { useCx } from "@/components/customer/i18n";
import { amt3, dshort, omr3 } from "@/components/customer/fmt";
import { usePaymentMethods, usePrefs, useWallet, type WalletInfo } from "@/components/customer/hooks";
import { Sheet, Toggle } from "@/components/customer/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/useToast";
import { friendlyError } from "@/lib/errors";
import { localDigits } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import type { WalletTx } from "@/lib/types";

const TOPUPS = [5, 10, 20];
const BRANDS = ["Visa", "Mastercard", "OmanNet"] as const;

export default function WalletPage() {
  const profile = useCustomer();
  const { t, lang } = useCx();
  const toast = useToast();
  const { wallet, setWallet } = useWallet();
  const { methods, reload: reloadMethods } = usePaymentMethods(profile.id);
  const { prefs, set: setPref } = usePrefs(profile.id);
  const [tx, setTx] = useState<WalletTx[] | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const loadTx = useCallback(
    () =>
      supabase()
        .from("wallet_tx")
        .select("*")
        .eq("customer_id", profile.id)
        .order("created_at", { ascending: false })
        .limit(40)
        .then(({ data }) => setTx((data ?? []) as WalletTx[])),
    [profile.id],
  );
  useEffect(() => {
    loadTx();
  }, [loadTx]);

  const cards = (methods ?? []).filter((m) => m.brand !== "OmanNet");
  const defCard = cards.find((m) => m.is_default) ?? cards[0];
  const source = src ?? (defCard ? `card:${defCard.id}` : "card");

  function applyWallet(data: unknown) {
    const w = data as { balance: number; points: number; loyalty: WalletInfo["loyalty"] };
    setWallet({ balance: Number(w.balance ?? 0), points: Number(w.points ?? 0), loyalty: w.loyalty ?? null });
    loadTx();
  }

  async function topup(amount: number) {
    setBusy(`t${amount}`);
    const card = cards.find((c) => `card:${c.id}` === source);
    const omannet = (methods ?? []).find((m) => m.brand === "OmanNet");
    const { data, error } = await supabase().rpc("wallet_topup", {
      p_amount: amount,
      p_method: source === "omannet" ? "omannet" : "card",
      p_card_last4: source === "omannet" ? (omannet?.last4 ?? null) : (card?.last4 ?? null),
    });
    setBusy(null);
    if (error) return toast.show(friendlyError(error));
    applyWallet(data);
    toast.show(t("toppedUp", { a: omr3(amount, lang) }));
  }

  async function redeem() {
    setBusy("redeem");
    const { data, error } = await supabase().rpc("redeem_points");
    setBusy(null);
    if (error) return toast.show(friendlyError(error));
    applyWallet(data);
    toast.show(t("redeemed"));
  }

  async function remove(id: string) {
    setBusy(id);
    const { error } = await supabase().rpc("remove_payment_method", { p_id: id });
    setBusy(null);
    if (error) return toast.show(friendlyError(error));
    if (src === `card:${id}`) setSrc(null);
    reloadMethods();
  }

  const need = Number(wallet?.loyalty?.redeem_points ?? 100);
  const per = Number(wallet?.loyalty?.redeem_omr ?? 1);

  return (
    <>
      <main className="screen">
        <div className="ptop">
          <h3>{t("tWallet")}</h3>
        </div>

        <div className="card">
          <p>{t("balance")}</p>
          <div className="money">{wallet ? omr3(wallet.balance, lang) : "…"}</div>
          <div className="fld" style={{ margin: "10px 0 6px" }}>
            <span className="lbl">{t("topupWith")}</span>
            <div className="opts">
              {cards.map((c) => (
                <button key={c.id} type="button" className={`opt ${source === `card:${c.id}` ? "on" : ""}`} onClick={() => setSrc(`card:${c.id}`)}>
                  {c.brand} ••{c.last4}
                </button>
              ))}
              {cards.length === 0 && (
                <button type="button" className={`opt ${source === "card" ? "on" : ""}`} onClick={() => setSrc("card")}>
                  {t("cardGeneric")}
                </button>
              )}
              <button type="button" className={`opt ${source === "omannet" ? "on" : ""}`} onClick={() => setSrc("omannet")}>
                {t("omannetShort")}
              </button>
            </div>
          </div>
          <div className="opts">
            {TOPUPS.map((v) => (
              <button key={v} type="button" className="opt topup" disabled={busy !== null} onClick={() => topup(v)}>
                +{amt3(v, lang)}
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="row">
            <div>
              <h4>{t("points")}</h4>
              <p>
                {localDigits((wallet?.points ?? 0).toLocaleString("en-US"), lang)} {t("pts")}
              </p>
            </div>
            <button className="btn sm" disabled={!wallet || wallet.points < need || busy !== null} onClick={redeem}>
              {t("redeemN", { p: localDigits(need, lang), a: omr3(per, lang) })}
            </button>
          </div>
          <p className="small" style={{ marginTop: 6 }}>
            {t("ptsEarn", { n: localDigits(Number(wallet?.loyalty?.points_per_omr ?? 1), lang) })}
          </p>
        </div>

        <div className="lrow">
          <span>
            {t("autopay")}
            <small>{t("autopayS")}</small>
          </span>
          <Toggle on={Boolean(prefs?.autopay)} disabled={!prefs} label={t("autopay")} onChange={(v) => setPref({ autopay: v })} />
        </div>

        <h4 className="cx-h">{t("methods")}</h4>
        {(methods ?? []).map((m) => (
          <div key={m.id} className="lrow">
            <span>
              {m.brand} ••{m.last4}
              <small>{m.is_default ? t("defaultCard") : t("savedCard")}</small>
            </span>
            <button className="lk bad" disabled={busy === m.id} onClick={() => remove(m.id)}>
              {t("remove")}
            </button>
          </div>
        ))}
        {methods && methods.length === 0 && <p className="mut small">{t("noMethods")}</p>}
        <button className="btn sm" style={{ margin: "10px 0" }} onClick={() => setAdding(true)}>
          + {t("addCard")}
        </button>

        <h4 className="cx-h">{t("txns")}</h4>
        {tx === null ? (
          <div className="empty">{t("loading")}</div>
        ) : tx.length === 0 ? (
          <p className="mut small">{t("noTx")}</p>
        ) : (
          tx.map((x) => (
            <div key={x.id} className="lrow">
              <span>
                {t(`tx_${x.kind}`)}
                <small>
                  {x.memo ? `${x.memo} · ` : ""}
                  {dshort(x.created_at, lang)}
                </small>
              </span>
              <span className={`num ${Number(x.amount) >= 0 ? "okt" : ""}`} dir="ltr">
                {Number(x.amount) >= 0 ? "+" : "−"}
                {amt3(Math.abs(Number(x.amount)), lang)}
              </span>
            </div>
          ))
        )}
        {toast.node}
      </main>
      {adding && (
        <AddCardSheet
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            reloadMethods();
          }}
        />
      )}
    </>
  );
}

function AddCardSheet({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { t } = useCx();
  const [brand, setBrand] = useState<(typeof BRANDS)[number]>("Visa");
  const [last4, setLast4] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function add() {
    setBusy(true);
    setError(null);
    const { error } = await supabase().rpc("add_payment_method", { p_brand: brand, p_last4: last4 });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    onAdded();
  }
  return (
    <Sheet title={t("addCard")} onClose={onClose}>
      <div className="seg">
        {BRANDS.map((b) => (
          <button key={b} type="button" className={brand === b ? "on" : ""} onClick={() => setBrand(b)}>
            {b}
          </button>
        ))}
      </div>
      <div className="fld">
        <label htmlFor="l4">{t("last4")}</label>
        <input id="l4" inputMode="numeric" dir="ltr" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, ""))} placeholder="4417" />
      </div>
      <p className="mut small">
        <Icon name="lock" size={14} /> {t("cardNote")}
      </p>
      {error && <div className="banner badb">{error}</div>}
      <button className="cta" disabled={busy || last4.length !== 4} onClick={add}>
        {busy ? t("saving") : t("save")}
      </button>
    </Sheet>
  );
}
