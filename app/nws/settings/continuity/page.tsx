"use client";

// NWS → Settings → Payment follow-ups (0043): deliveries never wait for billing. Finance follows up
// pending, pay-later and failed auto-pay orders here, switches PAYMENT_OUTAGE_MODE during a gateway
// outage, and admins set the fallback booking contacts (1442, WhatsApp).
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Chips, Empty, PageHead, ReadOnlyNote, useAudited } from "@/components/nws/admin/ui";
import { CONT } from "@/components/nws/i18n/continuity";
import { useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { orderNo } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

type Row = {
  order_id: string; order_no: number; status: string; is_test: boolean; customer_name: string | null; org_name: string | null; total: string; pay_method: string | null;
  payment_status: string; reason: string; flagged_at: string; delivered_at: string | null; resolved_at: string | null; note: string | null; gateway_ref: string | null;
};
type Contacts = { call_centre: string; whatsapp: string; public_url: string; no_tanker_min: number };
type State = "open" | "resolved" | "all";

export default function ContinuityPage() {
  const { can } = useStaff();
  const t = useT(CONT);
  const f = useFmt();
  const { ask, dialog } = useAudited();
  const [state, setState] = useState<State>("open");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [outage, setOutage] = useState<boolean | null>(null);
  const [c, setC] = useState<Contacts>({ call_centre: "1442", whatsapp: "", public_url: "", no_tanker_min: 20 });
  const finance = can("admin", "finance");
  const admin = can("admin");

  const load = useCallback(() => {
    const db = supabase();
    db.rpc("staff_payment_followups", { p_state: state, p_limit: 300 }).then(({ data }) => setRows((data ?? []) as Row[]));
    db.from("app_settings")
      .select("key, value")
      .in("key", ["PAYMENT_OUTAGE_MODE", "SUPPORT_CONTACTS"])
      .then(({ data }) => {
        for (const r of (data ?? []) as { key: string; value: string }[]) {
          if (r.key === "PAYMENT_OUTAGE_MODE") setOutage(r.value === "on");
          else {
            try {
              setC((x) => ({ ...x, ...(JSON.parse(r.value) as Contacts) }));
            } catch {
              /* keep the defaults */
            }
          }
        }
      });
  }, [state]);
  useEffect(load, [load]);

  const resolve = (r: Row, action: "paid" | "waived") =>
    ask({
      title: t(action === "paid" ? "fuPaidQ" : "fuWaiveQ"),
      body: `${orderNo(r.order_no)} · ${f.omr3(r.total)}`,
      confirm: t(action === "paid" ? "fuPaid" : "fuWaive"),
      danger: action === "waived",
      ok: t("fuDone"),
      run: (reason) => supabase().rpc("staff_resolve_payment_followup", { p_order: r.order_id, p_action: action, p_note: reason }),
      done: load,
    });

  return (
    <>
      <PageHead title={t("cTitle")} sub={t("cSub")} />
      {!finance && <ReadOnlyNote who={t("whoFinance")} />}
      <div className="half">
        <div className="panel">
          <h2>
            <span>
              {t("outT")} {outage == null ? null : outage ? <span className="st bad">{t("outOn")}</span> : <span className="st">{t("outOff")}</span>}
            </span>
          </h2>
          <div className="pad">
            <p className="mut">{t("outS")}</p>
            <button
              className={`btn ${outage ? "" : "pri"}`}
              disabled={!finance || outage == null}
              onClick={() =>
                ask({
                  title: t(outage ? "outOffQ" : "outOnQ"),
                  confirm: t(outage ? "outSwitchOff" : "outSwitchOn"),
                  danger: !outage,
                  ok: t("outDone"),
                  run: (reason) => supabase().rpc("staff_set_payment_outage", { p_on: !outage, p_reason: reason }),
                  done: load,
                })
              }
            >
              {t(outage ? "outSwitchOff" : "outSwitchOn")}
            </button>
          </div>
        </div>
        <div className="panel">
          <h2>{t("fbT")}</h2>
          <div className="pad">
            <p className="mut">{t("fbS")}</p>
            {!admin && <ReadOnlyNote who={t("whoAdmins")} />}
            <div className="form">
              <div className="fld">
                <label htmlFor="fb-call">{t("fbCall")}</label>
                <input id="fb-call" className="in" dir="ltr" disabled={!admin} value={c.call_centre} onChange={(e) => setC({ ...c, call_centre: e.target.value })} />
              </div>
              <div className="fld">
                <label htmlFor="fb-wa">{t("fbWa")}</label>
                <input id="fb-wa" className="in" dir="ltr" disabled={!admin} value={c.whatsapp} placeholder="+968 9123 4567" onChange={(e) => setC({ ...c, whatsapp: e.target.value })} />
                <small className="mut">{t("fbWaEmpty")}</small>
              </div>
              <div className="fld">
                <label htmlFor="fb-url">{t("fbUrl")}</label>
                <input id="fb-url" className="in" dir="ltr" disabled={!admin} value={c.public_url} placeholder="https://" onChange={(e) => setC({ ...c, public_url: e.target.value })} />
              </div>
              <div className="fld">
                <label htmlFor="fb-min">{t("fbMin")}</label>
                <input id="fb-min" className="in" type="number" min={5} max={240} disabled={!admin} value={c.no_tanker_min} onChange={(e) => setC({ ...c, no_tanker_min: Number(e.target.value) })} />
              </div>
            </div>
            <button
              className="btn pri"
              disabled={!admin}
              onClick={() => ask({ title: t("fbSaveQ"), confirm: t("fbSave"), ok: t("fbSaved"), run: (reason) => supabase().rpc("staff_set_support_contacts", { p_value: c, p_reason: reason }), done: load })}
            >
              {t("fbSave")}
            </button>
          </div>
        </div>
      </div>
      <div className="panel">
        <h2>{t("cTitle")}</h2>
        <div className="pad">
          <Chips
            items={[
              ["open", t("fuOpen")],
              ["resolved", t("fuResolved")],
              ["all", t("fuAll")],
            ]}
            value={state}
            onChange={setState}
          />
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("fuOrder")}</th>
                <th>{t("fuCustomer")}</th>
                <th>{t("fuAmount")}</th>
                <th>{t("fuReason")}</th>
                <th>{t("fuFlagged")}</th>
                <th>{t("fuDelivered")}</th>
                <th>{t("fuNote")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows?.length === 0 && <Empty cols={8}>{t("fuNone")}</Empty>}
              {rows?.map((r) => (
                <tr key={r.order_id}>
                  <td>
                    <Link className="lk" href={`/nws/orders/${r.order_id}`}>
                      <bdi dir="ltr">{orderNo(r.order_no)}</bdi>
                    </Link>
                    {r.is_test && <span className="st warn ptag">{t("test")}</span>}
                    {r.gateway_ref && (
                      <small className="d-block mut">
                        <bdi dir="ltr">{r.gateway_ref}</bdi>
                      </small>
                    )}
                  </td>
                  <td>
                    {r.customer_name ?? "—"}
                    {r.org_name && <small className="d-block">{r.org_name}</small>}
                  </td>
                  <td>{f.omr3(r.total)}</td>
                  <td>
                    <span className="st warn">{t(`pf_${r.reason}`)}</span>
                  </td>
                  <td>
                    <small>{f.dateTime(r.flagged_at)}</small>
                  </td>
                  <td>{r.delivered_at ? <small>{f.dateTime(r.delivered_at)}</small> : <small className="mut">{t("fuNotYet")}</small>}</td>
                  <td>{r.resolved_at ? <small>{r.note}</small> : "—"}</td>
                  <td>
                    {!r.resolved_at && (
                      <>
                        <button className="btn sm pri" disabled={!finance} onClick={() => resolve(r, "paid")}>
                          {t("fuPaid")}
                        </button>{" "}
                        <button className="btn sm" disabled={!finance} onClick={() => resolve(r, "waived")}>
                          {t("fuWaive")}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {dialog}
    </>
  );
}
