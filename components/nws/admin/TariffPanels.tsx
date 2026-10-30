"use client";

// NWS → Settings → Pricing panels for 0034–0035: the water tariff by tanker capacity class,
// the delivery charge per zone and class, and the tender's platform fees. Every edit goes
// through an audited staff RPC (admin and finance only; the database checks the role).
import { useCallback, useEffect, useMemo, useState } from "react";
import { MONEY } from "@/components/nws/i18n/money";
import { SETTINGS_OPS } from "@/components/nws/i18n/settingsOps";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { friendlyError } from "@/lib/errors";
import { useLang, useT, type Dict } from "@/lib/i18n";
import { serviceLabel } from "@/lib/labels";
import type { DeliveryCharge, RuleStatus, ServiceType, TariffClass } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";

const D: Dict = { ...SETTINGS_OPS, ...MONEY };
const SERVICES: ServiceType[] = ["DW", "WW", "TE"];
const BADGE: Record<RuleStatus, [string, string]> = {
  confirmed: ["stConfirmed", "ok"],
  pending_clarification: ["stPending", "warn"],
  assumption: ["stAssumption", "warn"],
};
type Zone = { id: string; name: string; is_test: boolean; active: boolean };
export type PlatformFee = { fee_key: string; kind: string; service_type: ServiceType | null; amount_omr: string; status: "to_be_quoted" | "pending_clarification" | "confirmed"; notes: string; updated_at: string };
const PF_ORDER = ["owner_subscription", "tanker_registration", "trip_dw", "trip_ww", "trip_te", "cancellation"];

export function useTariff() {
  const [classes, setClasses] = useState<TariffClass[] | null>(null);
  const [charges, setCharges] = useState<DeliveryCharge[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const load = useCallback(() => {
    const db = supabase();
    Promise.all([
      db.from("tariff_classes").select("*").order("service_type").order("min_gal"),
      db.from("delivery_charges").select("*"),
      db.from("zones").select("id, name, is_test, active").order("name"),
    ]).then(([c, d, z]) => {
      setClasses((c.data ?? []) as TariffClass[]);
      setCharges((d.data ?? []) as DeliveryCharge[]);
      setZones((z.data ?? []) as Zone[]);
    });
  }, []);
  useEffect(load, [load]);
  return { classes, charges, zones, reload: load };
}

function StatusBadge({ s }: { s: RuleStatus }) {
  const t = useT(D);
  return <span className={`st ${BADGE[s][1]}`}>{t(BADGE[s][0])}</span>;
}

/** Volumes of a service that no active class covers (1–20,000 gal). */
function gaps(classes: TariffClass[], svc: ServiceType): [number, number | null][] {
  const act = classes.filter((c) => c.service_type === svc && c.active).sort((a, b) => a.min_gal - b.min_gal);
  const out: [number, number | null][] = [];
  let next = 1;
  for (const c of act) {
    if (c.min_gal > next) out.push([next, c.min_gal - 1]);
    if (c.max_gal == null) return out;
    next = Math.max(next, c.max_gal + 1);
  }
  if (next <= 20000) out.push([next, null]);
  return out;
}

export function TariffClassesPanel({ classes, editor, onChanged, basisRow }: { classes: TariffClass[] | null; editor: boolean; onChanged: () => void; basisRow: React.ReactNode }) {
  const t = useT(D);
  const f = useFmt();
  const { lang } = useLang();
  const [edit, setEdit] = useState<TariffClass | "new" | null>(null);
  const range = (c: Pick<TariffClass, "min_gal" | "max_gal">) =>
    c.max_gal == null ? t("tcRangeOpen", { min: f.n(c.min_gal) }) : t("tcRangeV", { min: f.n(c.min_gal), max: f.n(c.max_gal) });
  const holes = classes ? SERVICES.flatMap((s) => gaps(classes, s).map(([a, b]) => ({ s, a, b }))) : [];
  return (
    <div className="panel">
      <h2>
        {t("tcTitle")} <small>{t("tcSub")}</small>
      </h2>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>{t("tcClass")}</th>
              <th>{t("tcRange")}</th>
              <th>{t("status")}</th>
              <th className="num">{t("tcRate")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {!classes && (
              <tr>
                <td className="empty" colSpan={5}>
                  {t("loading")}
                </td>
              </tr>
            )}
            {classes?.map((c) => (
              <tr key={c.id} className={c.active ? "" : "mut"}>
                <td>
                  <span className={`tag ${c.service_type}`}>{c.service_type}</span> <b dir="ltr">{c.code}</b>
                  {!c.active && <small> · {t("tcInactive")}</small>}
                  <small style={{ display: "block" }}>{t("prSourceUpdated", { source: c.source, at: f.dateTime(c.updated_at) })}</small>
                </td>
                <td>{range(c)}</td>
                <td>
                  <StatusBadge s={c.status} />
                </td>
                <td className="num">
                  <b>{t("tcRateV", { r: f.n(Number(c.rate_baisa), Number(c.rate_baisa) % 1 ? 2 : 0) })}</b>
                </td>
                <td className="num">
                  {editor && (
                    <button className="btn sm" onClick={() => setEdit(c)}>
                      {t("edit")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {basisRow}
          </tbody>
        </table>
      </div>
      {holes.map((h) => (
        <div key={`${h.s}${h.a}`} className="banner badb" style={{ margin: "8px 12px" }}>
          {h.b == null ? t("tcGapOpen", { svc: serviceLabel(h.s, lang), min: f.n(h.a) }) : t("tcGap", { svc: serviceLabel(h.s, lang), min: f.n(h.a), max: f.n(h.b) })}
        </div>
      ))}
      <p className="note">{t("tcNote")}</p>
      {editor && (
        <div className="pad" style={{ paddingTop: 0 }}>
          <button className="btn" onClick={() => setEdit("new")}>
            {t("tcAdd")}
          </button>
        </div>
      )}
      {edit && (
        <EditClass
          cls={edit === "new" ? null : edit}
          onClose={() => setEdit(null)}
          onDone={() => {
            setEdit(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function EditClass({ cls, onClose, onDone }: { cls: TariffClass | null; onClose: () => void; onDone: () => void }) {
  const { toast } = useStaff();
  const { lang } = useLang();
  const t = useT(D);
  const [svc, setSvc] = useState<ServiceType>(cls?.service_type ?? "DW");
  const [code, setCode] = useState(cls?.code ?? "");
  const [min, setMin] = useState(String(cls?.min_gal ?? ""));
  const [max, setMax] = useState(cls?.max_gal == null ? "" : String(cls.max_gal));
  const [rate, setRate] = useState(String(cls ? Number(cls.rate_baisa) : ""));
  const [status, setStatus] = useState<RuleStatus>(cls?.status ?? "pending_clarification");
  const [source, setSource] = useState(cls?.source ?? "");
  const [active, setActive] = useState(cls?.active ?? true);
  return (
    <ReasonDialog
      title={cls ? t("tcEditT", { code: cls.code }) : t("tcAddT")}
      body={t("tcBody")}
      confirm={t("prSaveRule")}
      extra={
        <>
          <div className="row2">
            <div className="fld">
              <label htmlFor="tc-s">{t("service")}</label>
              <select id="tc-s" className="in" value={svc} disabled={!!cls} onChange={(e) => setSvc(e.target.value as ServiceType)}>
                {SERVICES.map((s) => (
                  <option key={s} value={s}>
                    {serviceLabel(s, lang)}
                  </option>
                ))}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="tc-c">{t("tcCode")}</label>
              <input id="tc-c" className="in" dir="ltr" maxLength={20} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="DW-3" />
            </div>
          </div>
          <div className="row2">
            <div className="fld">
              <label htmlFor="tc-min">{t("tcMin")}</label>
              <input id="tc-min" className="in" type="number" dir="ltr" min={1} max={20000} value={min} onChange={(e) => setMin(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="tc-max">{t("tcMax")}</label>
              <input id="tc-max" className="in" type="number" dir="ltr" min={1} max={20000} value={max} onChange={(e) => setMax(e.target.value)} />
            </div>
          </div>
          <div className="row2">
            <div className="fld">
              <label htmlFor="tc-r">{t("tcRate")}</label>
              <input id="tc-r" className="in" inputMode="decimal" dir="ltr" value={rate} onChange={(e) => setRate(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="tc-st">{t("status")}</label>
              <select id="tc-st" className="in" value={status} onChange={(e) => setStatus(e.target.value as RuleStatus)}>
                {(Object.keys(BADGE) as RuleStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {t(BADGE[s][0])}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="fld">
            <label htmlFor="tc-src">{t("prSource")}</label>
            <input id="tc-src" className="in" value={source} onChange={(e) => setSource(e.target.value)} placeholder={t("prSourceHint")} />
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5, marginBottom: 10 }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {t("tcActive")}
          </label>
        </>
      }
      onCancel={onClose}
      onConfirm={async (reason) => {
        const { error } = await supabase().rpc("staff_save_tariff_class", {
          p_id: cls?.id ?? null, p_service_type: svc, p_code: code.trim(), p_min_gal: Number(min), p_max_gal: max.trim() ? Number(max) : null,
          p_rate_baisa: Number(rate), p_status: status, p_source: source, p_active: active, p_reason: reason,
        });
        if (error) return toast(friendlyError(error, lang), true);
        toast(t("tcSaved"));
        onDone();
      }}
    />
  );
}

export function DeliveryChargesPanel({ classes, charges, zones, editor, onChanged }: { classes: TariffClass[] | null; charges: DeliveryCharge[]; zones: Zone[]; editor: boolean; onChanged: () => void }) {
  const t = useT(D);
  const f = useFmt();
  const { lang } = useLang();
  const { toast } = useStaff();
  const [edit, setEdit] = useState<DeliveryCharge | "new" | null>(null);
  const [remove, setRemove] = useState<DeliveryCharge | null>(null);
  const byId = useMemo(() => new Map((classes ?? []).map((c) => [c.id, c])), [classes]);
  const zoneName = (id: string | null) => (id ? (zones.find((z) => z.id === id)?.name ?? "—") : t("dcDefault"));
  const sorted = [...charges].sort(
    (a, b) =>
      Number(a.zone_id != null) - Number(b.zone_id != null) ||
      zoneName(a.zone_id).localeCompare(zoneName(b.zone_id)) ||
      a.service_type.localeCompare(b.service_type) ||
      (byId.get(a.class_id)?.min_gal ?? 0) - (byId.get(b.class_id)?.min_gal ?? 0),
  );
  const own = sorted.filter((d) => d.zone_id != null);
  const rowOf = (d: DeliveryCharge) => {
    const c = byId.get(d.class_id);
    return (
      <tr key={d.id}>
        <td>
          {zoneName(d.zone_id)}
          <small style={{ display: "block" }}>{t("prSourceUpdated", { source: d.source, at: f.dateTime(d.updated_at) })}</small>
        </td>
        <td>
          <span className={`tag ${d.service_type}`}>{d.service_type}</span> <span dir="ltr">{c?.code ?? "—"}</span>
        </td>
        <td>
          <StatusBadge s={d.status} />
        </td>
        <td className="num">
          <b>{f.n3(d.amount_omr)}</b>
        </td>
        <td className="num">
          {editor && (
            <span className="btns" style={{ justifyContent: "flex-end" }}>
              <button className="btn sm" onClick={() => setEdit(d)}>
                {t("edit")}
              </button>
              {d.zone_id && (
                <button className="btn sm" onClick={() => setRemove(d)}>
                  {t("dcRemove")}
                </button>
              )}
            </span>
          )}
        </td>
      </tr>
    );
  };
  return (
    <div className="panel">
      <h2>
        {t("dcTitle")} <small>{t("dcSub")}</small>
      </h2>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>{t("dcZone")}</th>
              <th>{t("tcClass")}</th>
              <th>{t("status")}</th>
              <th className="num">{t("dcAmount")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.filter((d) => d.zone_id == null).map(rowOf)}
            {own.map(rowOf)}
            {classes && own.length === 0 && (
              <tr>
                <td colSpan={5} className="mut">
                  {t("dcNone")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {editor && (
        <div className="pad">
          <button className="btn" onClick={() => setEdit("new")} disabled={!classes?.length}>
            {t("dcAdd")}
          </button>
        </div>
      )}
      {edit && (
        <EditCharge
          charge={edit === "new" ? null : edit}
          classes={classes ?? []}
          zones={zones}
          title={edit === "new" ? t("dcAddT") : t("dcEditT", { zone: zoneName(edit.zone_id), code: byId.get(edit.class_id)?.code ?? "" })}
          onClose={() => setEdit(null)}
          onDone={() => {
            setEdit(null);
            onChanged();
          }}
        />
      )}
      {remove && (
        <ReasonDialog
          title={t("dcRemoveT", { zone: zoneName(remove.zone_id), code: byId.get(remove.class_id)?.code ?? "" })}
          body={t("dcRemoveB")}
          confirm={t("dcRemove")}
          danger
          onCancel={() => setRemove(null)}
          onConfirm={async (reason) => {
            const { error } = await supabase().rpc("staff_delete_delivery_charge", { p_id: remove.id, p_reason: reason });
            if (error) return toast(friendlyError(error, lang), true);
            toast(t("dcRemoved"));
            setRemove(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function EditCharge({ charge, classes, zones, title, onClose, onDone }: { charge: DeliveryCharge | null; classes: TariffClass[]; zones: Zone[]; title: string; onClose: () => void; onDone: () => void }) {
  const { toast } = useStaff();
  const { lang } = useLang();
  const t = useT(D);
  const [zone, setZone] = useState(charge?.zone_id ?? "");
  const [cls, setCls] = useState(charge?.class_id ?? "");
  const [amount, setAmount] = useState(charge ? String(Number(charge.amount_omr)) : "");
  const [status, setStatus] = useState<RuleStatus>(charge?.status ?? "assumption");
  const [source, setSource] = useState(charge?.source ?? "");
  return (
    <ReasonDialog
      title={title}
      body={t("dcBody")}
      confirm={t("prSaveRule")}
      extra={
        <>
          {!charge && (
            <div className="row2">
              <div className="fld">
                <label htmlFor="dc-z">{t("dcZone")}</label>
                <select id="dc-z" className="in" value={zone} onChange={(e) => setZone(e.target.value)}>
                  <option value="">{t("dcChoose")}</option>
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                      {z.is_test ? ` (${t("dcTest")})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="fld">
                <label htmlFor="dc-c">{t("tcClass")}</label>
                <select id="dc-c" className="in" value={cls} onChange={(e) => setCls(e.target.value)}>
                  <option value="">{t("dcChoose")}</option>
                  {classes
                    .filter((c) => c.active)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code} · {serviceLabel(c.service_type, lang)}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          )}
          <div className="row2">
            <div className="fld">
              <label htmlFor="dc-a">{t("dcAmount")}</label>
              <input id="dc-a" className="in" inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="dc-s">{t("status")}</label>
              <select id="dc-s" className="in" value={status} onChange={(e) => setStatus(e.target.value as RuleStatus)}>
                {(Object.keys(BADGE) as RuleStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {t(BADGE[s][0])}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="fld">
            <label htmlFor="dc-src">{t("prSource")}</label>
            <input id="dc-src" className="in" value={source} onChange={(e) => setSource(e.target.value)} placeholder={t("prSourceHint")} />
          </div>
        </>
      }
      onCancel={onClose}
      onConfirm={async (reason) => {
        const { error } = await supabase().rpc("staff_save_delivery_charge", {
          p_id: charge?.id ?? null, p_zone_id: charge ? charge.zone_id : zone || null, p_class_id: charge ? charge.class_id : cls || null,
          p_amount_omr: Number(amount), p_status: status, p_source: source, p_reason: reason,
        });
        if (error) return toast(friendlyError(error, lang), true);
        toast(t("dcSaved"));
        onDone();
      }}
    />
  );
}

export function usePlatformFees() {
  const [fees, setFees] = useState<PlatformFee[] | null>(null);
  const load = useCallback(() => {
    supabase()
      .from("platform_fees")
      .select("*")
      .then(({ data }) => setFees(((data ?? []) as PlatformFee[]).sort((a, b) => PF_ORDER.indexOf(a.fee_key) - PF_ORDER.indexOf(b.fee_key))));
  }, []);
  useEffect(load, [load]);
  return { fees, reload: load };
}

const PF_TONE: Record<PlatformFee["status"], string> = { to_be_quoted: "warn", pending_clarification: "warn", confirmed: "ok" };

export function PlatformFeesPanel({ editor }: { editor: boolean }) {
  const t = useT(D);
  const f = useFmt();
  const { fees, reload } = usePlatformFees();
  const [edit, setEdit] = useState<PlatformFee | null>(null);
  return (
    <div className="panel">
      <h2>
        {t("pfTitle")} <small>{t("pfSub")}</small>
      </h2>
      <div className="tblwrap">
        <table>
          <tbody>
            {!fees && (
              <tr>
                <td className="empty">{t("loading")}</td>
              </tr>
            )}
            {fees?.map((p) => (
              <tr key={p.fee_key}>
                <td>
                  {t(`pf_${p.fee_key}`)}
                  {p.notes && (
                    <small style={{ display: "block" }} title={p.notes}>
                      {t("prSourceUpdated", { source: t(`pfs_${p.status}`), at: f.dateTime(p.updated_at) })}
                    </small>
                  )}
                </td>
                <td>
                  <span className={`st ${PF_TONE[p.status]}`}>{t(`pfs_${p.status}`)}</span>
                </td>
                <td className="num">
                  <b>{f.n3(p.amount_omr)}</b>
                </td>
                <td className="num">
                  {editor && (
                    <button className="btn sm" onClick={() => setEdit(p)}>
                      {t("edit")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">{t("pfNote")}</p>
      {edit && (
        <EditFee
          fee={edit}
          onClose={() => setEdit(null)}
          onDone={() => {
            setEdit(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function EditFee({ fee, onClose, onDone }: { fee: PlatformFee; onClose: () => void; onDone: () => void }) {
  const { toast } = useStaff();
  const { lang } = useLang();
  const t = useT(D);
  const [amount, setAmount] = useState(String(Number(fee.amount_omr)));
  const [status, setStatus] = useState<PlatformFee["status"]>(fee.status);
  const [notes, setNotes] = useState(fee.notes);
  return (
    <ReasonDialog
      title={`${t("pfEditT")} — ${t(`pf_${fee.fee_key}`)}`}
      body={t("pfBody")}
      confirm={t("prSaveRule")}
      extra={
        <>
          <div className="row2">
            <div className="fld">
              <label htmlFor="pf-a">{t("amount")}</label>
              <input id="pf-a" className="in" inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="pf-s">{t("status")}</label>
              <select id="pf-s" className="in" value={status} onChange={(e) => setStatus(e.target.value as PlatformFee["status"])}>
                {(["to_be_quoted", "pending_clarification", "confirmed"] as const).map((s) => (
                  <option key={s} value={s}>
                    {t(`pfs_${s}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="fld">
            <label htmlFor="pf-n">{t("pfNotes")}</label>
            <input id="pf-n" className="in" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </>
      }
      onCancel={onClose}
      onConfirm={async (reason) => {
        const { error } = await supabase().rpc("staff_update_platform_fee", { p_key: fee.fee_key, p_amount: Number(amount), p_status: status, p_notes: notes, p_reason: reason });
        if (error) return toast(friendlyError(error, lang), true);
        toast(t("pfSaved"));
        onDone();
      }}
    />
  );
}
