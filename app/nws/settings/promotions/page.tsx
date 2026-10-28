"use client";

import { useCallback, useEffect, useState } from "react";
import { Empty, int, PageHead, Switch, useAudited } from "@/components/nws/admin/ui";
import { fmtDate, ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import type { Promotion } from "@/lib/types";

type Loyalty = { points_per_omr: number; redeem_points: number; redeem_omr: number };
const AUDIENCE: Record<string, string> = { all: "Everyone", new: "New customers", household: "Households", business: "Business accounts" };
const upsert = (p: Omit<Promotion, "uses" | "pct"> & { pct: number }, reason: string) =>
  supabase().rpc("staff_upsert_promotion", {
    p_code: p.code, p_label: p.label, p_pct: p.pct, p_audience: p.audience, p_max_uses: p.max_uses, p_active: p.active, p_valid_to: p.valid_to || null, p_reason: reason,
  });

export default function PromotionsPage() {
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const [promos, setPromos] = useState<Promotion[] | null>(null);
  const [loyalty, setLoyalty] = useState<Loyalty | null>(null);
  const [form, setForm] = useState<Loyalty | null>(null);
  const [edit, setEdit] = useState<Promotion | "new" | null>(null);
  const promoEditor = can("admin", "finance");
  const admin = can("admin");

  const load = useCallback(() => {
    const db = supabase();
    db.from("promotions").select("*").order("active", { ascending: false }).order("code").then(({ data }) => setPromos((data ?? []) as Promotion[]));
    db.from("app_settings").select("value").eq("key", "LOYALTY").maybeSingle().then(({ data }) => {
      const v = data?.value ? (JSON.parse(data.value as string) as Loyalty) : { points_per_omr: 1, redeem_points: 100, redeem_omr: 1 };
      setLoyalty(v);
      setForm(v);
    });
  }, []);
  useEffect(load, [load]);

  function toggle(p: Promotion) {
    ask({
      title: `${p.active ? "Pause" : "Activate"} ${p.code}`,
      body: p.active ? "Customers can no longer apply this code." : "Customers in the audience can apply this code again.",
      confirm: p.active ? "Pause campaign" : "Activate campaign",
      ok: p.active ? "Campaign paused" : "Campaign active",
      run: (reason) => upsert({ ...p, pct: Number(p.pct), active: !p.active }, reason),
      done: load,
    });
  }

  function saveLoyalty() {
    if (!form) return;
    ask({
      title: "Update loyalty settings",
      body: `Earn ${form.points_per_omr} point(s) per OMR paid; ${form.redeem_points} points redeem for ${form.redeem_omr} OMR wallet credit.`,
      confirm: "Save loyalty",
      ok: "Loyalty settings saved",
      run: (reason) => supabase().rpc("staff_update_setting", { p_key: "LOYALTY", p_value: form, p_reason: reason }),
      done: load,
    });
  }

  const dirty = form && loyalty && JSON.stringify(form) !== JSON.stringify(loyalty);
  const num = (k: keyof Loyalty, step = 1) => (
    <input className="inl" type="number" min={0} step={step} aria-label={k} disabled={!admin} value={form?.[k] ?? ""} onChange={(e) => form && setForm({ ...form, [k]: Number(e.target.value) })} />
  );

  return (
    <>
      <PageHead title="Promotions and loyalty" sub="Discount campaigns on the delivery fee, and how customers earn and redeem loyalty points." />
      <div className="wide">
        <div className="panel">
          <div className="toolbar">
            <b style={{ fontSize: 15 }}>Campaigns</b>
            {promoEditor && <button className="btn pri" onClick={() => setEdit("new")}>New campaign</button>}
          </div>
          <div className="tblwrap">
            <table>
              <thead>
                <tr><th>Code</th><th className="num">Discount</th><th>Audience</th><th className="num">Uses</th><th>Valid to</th><th>Active</th><th></th></tr>
              </thead>
              <tbody>
                {!promos && <Empty cols={7}>Loading…</Empty>}
                {promos?.length === 0 && <Empty cols={7}>No campaigns yet.</Empty>}
                {promos?.map((p) => {
                  const expired = p.valid_to != null && p.valid_to < new Date().toLocaleDateString("en-CA");
                  return (
                    <tr key={p.code}>
                      <td><b>{p.code}</b><small style={{ display: "block" }}>{p.label}</small></td>
                      <td className="num">{Math.round(Number(p.pct) * 100)}%</td>
                      <td>{AUDIENCE[p.audience] ?? p.audience}</td>
                      <td className="num">{int(p.uses)} <small>/ {int(p.max_uses)}</small></td>
                      <td>{p.valid_to ? <>{fmtDate(p.valid_to)}{expired && <span className="st warn ptag">Expired</span>}</> : <span className="mut">No end date</span>}</td>
                      <td><Switch on={p.active} disabled={!promoEditor} label={p.active ? "Active" : "Paused"} onClick={() => toggle(p)} /></td>
                      <td className="num">{promoEditor && <button className="btn sm" onClick={() => setEdit(p)}>Edit</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="note">Discounts apply to the delivery fee only (the regulated water charge is never discounted) and are capped at 50%.</p>
        </div>

        <div className="panel">
          <h2>Loyalty</h2>
          <div className="tblwrap">
            <table>
              <tbody>
                <tr><td>Points earned per 1 OMR spent <span className="st warn ptag">Assumption</span></td><td className="num">{num("points_per_omr", 0.5)}</td></tr>
                <tr><td>Points needed to redeem</td><td className="num">{num("redeem_points", 10)}</td></tr>
                <tr><td>Wallet credit per redemption (OMR)</td><td className="num">{num("redeem_omr", 0.5)}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="pad" style={{ paddingTop: 12 }}>
            {admin ? (
              <button className="btn pri" disabled={!dirty} onClick={saveLoyalty}>Save loyalty</button>
            ) : (
              <small className="mut">Loyalty settings are changed by a Super admin.</small>
            )}
          </div>
          <p className="note">Cashback and points are checked by the fraud rules (Wallet misuse) before they reach the wallet.</p>
        </div>
      </div>
      {edit && <PromoDialog promo={edit === "new" ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); load(); }} />}
      {dialog}
    </>
  );
}

function PromoDialog({ promo, onClose, onDone }: { promo: Promotion | null; onClose: () => void; onDone: () => void }) {
  const { toast } = useStaff();
  const [code, setCode] = useState(promo?.code ?? "");
  const [label, setLabel] = useState(promo?.label ?? "");
  const [pctV, setPct] = useState(promo ? String(Math.round(Number(promo.pct) * 100)) : "10");
  const [audience, setAudience] = useState(promo?.audience ?? "all");
  const [maxUses, setMaxUses] = useState(String(promo?.max_uses ?? 1000));
  const [validTo, setValidTo] = useState(promo?.valid_to ?? "");
  const [active, setActive] = useState(promo?.active ?? true);
  return (
    <ReasonDialog
      title={promo ? `Edit ${promo.code}` : "New campaign"}
      confirm={promo ? "Save campaign" : "Create campaign"}
      extra={
        <>
          <div className="row2">
            <div className="fld">
              <label htmlFor="pm-code">Code</label>
              <input id="pm-code" className="in" value={code} disabled={!!promo} maxLength={20} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="SUMMER10" />
            </div>
            <div className="fld">
              <label htmlFor="pm-pct">Discount on fee (%)</label>
              <input id="pm-pct" className="in" type="number" min={1} max={50} value={pctV} onChange={(e) => setPct(e.target.value)} />
            </div>
          </div>
          <div className="fld">
            <label htmlFor="pm-label">Label shown to customers</label>
            <input id="pm-label" className="in" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
          </div>
          <div className="row2">
            <div className="fld">
              <label htmlFor="pm-aud">Audience</label>
              <select id="pm-aud" className="in" value={audience} onChange={(e) => setAudience(e.target.value)}>
                {Object.entries(AUDIENCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="pm-max">Maximum uses</label>
              <input id="pm-max" className="in" type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
            </div>
          </div>
          <div className="row2">
            <div className="fld">
              <label htmlFor="pm-to">Valid to (optional)</label>
              <input id="pm-to" className="in" type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
            </div>
            <div className="fld">
              <label>Status</label>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5, paddingTop: 6 }}>
                <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
              </label>
            </div>
          </div>
        </>
      }
      onCancel={onClose}
      onConfirm={async (reason) => {
        const pct = Number(pctV) / 100;
        if (!/^[A-Z0-9]{3,20}$/.test(code)) return toast("Codes are 3–20 capital letters or digits.", true);
        if (!label.trim()) return toast("Enter a label.", true);
        if (!(pct > 0 && pct <= 0.5)) return toast("The discount must be between 1% and 50%.", true);
        const { error } = await upsert({ code, label: label.trim(), pct, audience, max_uses: Math.max(1, Number(maxUses) || 1), active, valid_to: validTo || null }, reason);
        if (error) return toast(friendlyError(error), true);
        toast(promo ? "Campaign saved" : `Campaign ${code} created`);
        onDone();
      }}
    />
  );
}
