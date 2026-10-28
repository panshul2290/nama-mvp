"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useCustomer } from "@/components/CustomerContext";
import { useCx } from "@/components/customer/i18n";
import { dshort, gal } from "@/components/customer/fmt";
import { usePrefs, useProperties, type Prefs } from "@/components/customer/hooks";
import { PropertySheet } from "@/components/customer/PropertySheet";
import { Sheet, Toggle } from "@/components/customer/ui";
import { Icon } from "@/components/icons";
import { Loading } from "@/components/Shell";
import { useToast } from "@/components/useToast";
import { friendlyError } from "@/lib/errors";
import { initials } from "@/lib/format";
import { LangToggle } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { ref, type Complaint, type DataRequest, type Profile, type Property } from "@/lib/types";

type Me = Pick<Profile, "full_name" | "phone" | "id_type" | "id_no" | "id_verified">;
const ID_TYPES = ["civil_id", "resident_card", "passport"] as const;
const ID_KEY: Record<(typeof ID_TYPES)[number], string> = { civil_id: "civil", resident_card: "resident", passport: "passport" };
const CHANNELS: [keyof Prefs, string][] = [
  ["push", "push"],
  ["sms", "sms"],
  ["whatsapp", "wa"],
  ["promotions", "mkt"],
];

export default function AccountPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Account />
    </Suspense>
  );
}

function Account() {
  const router = useRouter();
  const params = useSearchParams();
  const profile = useCustomer();
  const { t, lang } = useCx();
  const toast = useToast();
  const { prefs, set: setPref } = usePrefs(profile.id);
  const { props, reload: reloadProps } = useProperties(profile.id);
  const [me, setMe] = useState<Me | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [cx, setCx] = useState<Complaint[] | null>(null);
  const [dsr, setDsr] = useState<DataRequest[] | null>(null);
  const [sheet, setSheet] = useState<"edit" | "id" | "help" | null>(null);
  const [propSheet, setPropSheet] = useState<Property | "new" | null>(params.get("add") === "property" ? "new" : null);

  // Identity fields are private columns: they come from my_private_profile(), not the table.
  const loadMe = useCallback(() => {
    const db = supabase();
    return Promise.all([
      db.from("profiles").select("full_name, phone, id_verified").eq("id", profile.id).maybeSingle<Pick<Me, "full_name" | "phone" | "id_verified">>(),
      db.rpc("my_private_profile"),
    ]).then(([{ data: pub }, { data: priv }]) => {
      const p = (priv ?? {}) as Pick<Me, "id_type" | "id_no">;
      setMe(pub ? { ...pub, id_type: p.id_type ?? null, id_no: p.id_no ?? null } : null);
    });
  }, [profile.id]);
  const loadDsr = useCallback(
    () =>
      supabase()
        .from("data_requests")
        .select("*")
        .eq("customer_id", profile.id)
        .order("created_at", { ascending: false })
        .then(({ data }) => setDsr((data ?? []) as DataRequest[])),
    [profile.id],
  );
  useEffect(() => {
    loadMe();
    loadDsr();
    supabase()
      .auth.getUser()
      .then(({ data }) => setEmail(data.user?.email ?? null));
    supabase()
      .from("complaints")
      .select("*")
      .eq("customer_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(5)
      .then(({ data }) => setCx((data ?? []) as Complaint[]));
  }, [profile.id, loadMe, loadDsr]);

  async function delProp(p: Property) {
    if (!window.confirm(t("delPropQ", { p: p.label }))) return;
    const { error } = await supabase().rpc("delete_property", { p_id: p.id });
    if (error) return toast.show(friendlyError(error));
    reloadProps();
  }

  async function dataRequest(kind: "access" | "delete") {
    if (kind === "delete" && !window.confirm(t("dsrDeleteQ"))) return;
    const { error } = await supabase().rpc("file_data_request", { p_kind: kind, p_details: kind === "access" ? "Copy of my data (customer app)" : "Delete my account and data (customer app)" });
    if (error) return toast.show(friendlyError(error));
    toast.show(t("dsrSent"));
    loadDsr();
  }

  async function pref(p: Prefs) {
    const error = await setPref(p);
    if (error) toast.show(friendlyError(error));
  }

  async function signOut() {
    await supabase().auth.signOut();
    router.replace("/login");
  }

  const name = me?.full_name ?? profile.full_name;

  return (
    <>
      <main className="screen">
        <div className="ptop">
          <h3>{t("tAccount")}</h3>
          <LangToggle />
        </div>

        <div className="dcard">
          <div className="dc-top">
            <span className="av">{initials(name)}</span>
            <div>
              <b>{name || t("customer")}</b>
              <small dir="ltr" style={{ display: "block", textAlign: "start" }}>
                {me?.phone || profile.phone || t("noPhone")}
              </small>
              <small>{email}</small>
            </div>
            <button className="btn sm" onClick={() => setSheet("edit")}>
              <Icon name="edit" size={14} /> {t("edit")}
            </button>
          </div>
          {me?.id_verified ? (
            <div className="vf">
              <Icon name="shield" />
              {t(ID_KEY[me.id_type ?? "civil_id"])} · {t("verified")}
            </div>
          ) : (
            <button className="cta sec" style={{ margin: 0 }} onClick={() => setSheet("id")}>
              {t("idT")}
            </button>
          )}
        </div>

        <h4 className="cx-h" id="properties">
          {t("households")}
        </h4>
        {(props ?? []).map((p) => (
          <div key={p.id} className="lrow">
            <span>
              {p.label}
              <small>
                {[p.area, p.address].filter(Boolean).join(" · ")} · {gal(p.tank_gal, lang)}
              </small>
            </span>
            <span className="btns">
              <button className="lk" onClick={() => setPropSheet(p)}>
                {t("edit")}
              </button>
              <button className="lk bad" onClick={() => delProp(p)}>
                {t("remove")}
              </button>
            </span>
          </div>
        ))}
        {props && props.length === 0 && <p className="mut small">{t("noProps")}</p>}
        <button className="btn sm" style={{ margin: "10px 0" }} onClick={() => setPropSheet("new")}>
          + {t("addProp")}
        </button>

        <h4 className="cx-h">{t("notifs")}</h4>
        {CHANNELS.map(([k, l]) => (
          <div key={k} className="lrow">
            <span>{t(l)}</span>
            <Toggle on={Boolean(prefs?.[k])} disabled={!prefs} label={t(l)} onChange={(v) => pref({ [k]: v })} />
          </div>
        ))}

        <h4 className="cx-h">{t("privacy")}</h4>
        <div className="lrow">
          <span>{t("share")}</span>
          <Toggle on={Boolean(prefs?.share_usage)} disabled={!prefs} label={t("share")} onChange={(v) => pref({ share_usage: v })} />
        </div>
        <div className="lrow">
          <span>
            {t("dataReq")}
            <small>{t("dataReqS")}</small>
          </span>
        </div>
        <div className="btns" style={{ margin: "10px 0" }}>
          <button className="btn sm" onClick={() => dataRequest("access")}>
            <Icon name="download" size={14} /> {t("dsrAccess")}
          </button>
          <button className="btn sm bad" onClick={() => dataRequest("delete")}>
            {t("dsrDelete")}
          </button>
        </div>
        {(dsr ?? []).map((d) => (
          <div key={d.id} className="lrow">
            <span>
              {ref.dataRequest(d.ref_no)} · {t(`dsr_${d.kind}`)}
              <small>{dshort(d.created_at, lang)}</small>
            </span>
            <span className={`st ${d.state === "completed" ? "ok" : d.state === "rejected" ? "bad" : "warn"}`}>{t(`dsrSt_${d.state}`)}</span>
          </div>
        ))}

        <div className="lrow">
          <span>{t("language")}</span>
          <LangToggle />
        </div>

        <h4 className="cx-h">{t("myCx")}</h4>
        {cx === null ? null : cx.length === 0 ? (
          <p className="mut small">{t("none")}</p>
        ) : (
          <>
            {cx.map((c) => (
              <Link key={c.id} href={`/customer/complaints?id=${c.id}`} className="lrow">
                <span>
                  {ref.complaint(c.case_no)}
                  <small>
                    {t(`cx_${c.category}`)} · {dshort(c.created_at, lang)}
                  </small>
                </span>
                <span className={`st ${c.state === "resolved" ? "ok" : "warn"}`}>{t(`cxSt_${c.state}`)}</span>
              </Link>
            ))}
            <Link href="/customer/complaints" className="lk" style={{ display: "inline-block", marginTop: 8 }}>
              {t("seeAll")}
            </Link>
          </>
        )}

        <button className="cta sec" style={{ marginTop: 14 }} onClick={() => setSheet("help")}>
          {t("help")}
        </button>
        <button className="cta danger" onClick={signOut}>
          {t("signout")}
        </button>
        {toast.node}
      </main>

      {sheet === "edit" && me && (
        <EditSheet
          me={me}
          userId={profile.id}
          onClose={() => setSheet(null)}
          onSaved={() => {
            setSheet(null);
            loadMe();
          }}
        />
      )}
      {sheet === "id" && (
        <IdSheet
          onClose={() => setSheet(null)}
          onDone={() => {
            setSheet(null);
            loadMe();
            toast.show(t("idOk"));
          }}
        />
      )}
      {sheet === "help" && <HelpSheet onClose={() => setSheet(null)} />}
      {propSheet && (
        <PropertySheet
          initial={propSheet === "new" ? null : propSheet}
          onClose={() => setPropSheet(null)}
          onSaved={() => {
            setPropSheet(null);
            reloadProps();
          }}
        />
      )}
    </>
  );
}

function EditSheet({ me, userId, onClose, onSaved }: { me: Me; userId: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useCx();
  const [name, setName] = useState(me.full_name ?? "");
  const [phone, setPhone] = useState(me.phone ?? "");
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const { error } = await supabase().from("profiles").update({ full_name: name.trim(), phone: phone.trim() || null }).eq("id", userId);
    if (error) return setError(friendlyError(error));
    onSaved();
  }
  return (
    <Sheet title={t("profile")} onClose={onClose}>
      <div className="fld">
        <label htmlFor="fn">{t("fullName")}</label>
        <input id="fn" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="fld">
        <label htmlFor="ph">{t("mobile")}</label>
        <input id="ph" type="tel" dir="ltr" maxLength={32} placeholder="+968 9124 4512" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      {error && <div className="banner badb">{error}</div>}
      <button className="cta" disabled={!name.trim()} onClick={save}>
        {t("save")}
      </button>
    </Sheet>
  );
}

function IdSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useCx();
  const [type, setType] = useState<(typeof ID_TYPES)[number]>("civil_id");
  const [no, setNo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function verify() {
    setBusy(true);
    setError(null);
    const { error } = await supabase().rpc("verify_identity", { p_id_type: type, p_id_no: no.trim() });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    onDone();
  }
  return (
    <Sheet title={t("idT")} onClose={onClose}>
      <p className="mut small" style={{ marginTop: 0 }}>
        {t("idS")}
      </p>
      <div className="seg">
        {ID_TYPES.map((k) => (
          <button key={k} type="button" className={type === k ? "on" : ""} onClick={() => setType(k)}>
            {t(ID_KEY[k])}
          </button>
        ))}
      </div>
      <div className="fld">
        <label htmlFor="idn">{t("idNo")}</label>
        <input id="idn" dir="ltr" maxLength={30} inputMode={type === "passport" ? "text" : "numeric"} value={no} onChange={(e) => setNo(e.target.value)} />
      </div>
      {error && <div className="banner badb">{error}</div>}
      <button className="cta" disabled={busy || no.trim().length < 5} onClick={verify}>
        {busy ? t("verifying") : t("verify")}
      </button>
    </Sheet>
  );
}

const FAQ = ["faq1", "faq2", "faq3", "faq4"];

function HelpSheet({ onClose }: { onClose: () => void }) {
  const { t } = useCx();
  return (
    <Sheet title={t("help")} onClose={onClose}>
      {FAQ.map((k) => (
        <details key={k} className="faq">
          <summary>{t(`${k}q`)}</summary>
          <p>{t(`${k}a`)}</p>
        </details>
      ))}
      <div className="banner info" style={{ marginTop: 12 }}>
        <Icon name="headset" size={16} /> {t("helpCall")}
      </div>
    </Sheet>
  );
}
