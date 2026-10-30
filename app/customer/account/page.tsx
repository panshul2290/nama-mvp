"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useCustomer } from "@/components/CustomerContext";
import { useCx } from "@/components/customer/i18n";
import { dshort, gal } from "@/components/customer/fmt";
import { usePrefs, useProperties, type Prefs } from "@/components/customer/hooks";
import { IdentityFields, ID_DICT, idNoProblem, saveIdentityPhotos, useIdentityDocs, useIdentityRule, verifyIdNumber, type DocKind, type IdentityDoc, type IdPhotos, type IdType } from "@/components/customer/identity";
import { SlaHistory } from "@/components/customer/sla";
import { PropertySheet } from "@/components/customer/PropertySheet";
import { Sheet, Toggle } from "@/components/customer/ui";
import { Icon } from "@/components/icons";
import { Loading } from "@/components/Shell";
import { useToast } from "@/components/useToast";
import { friendlyError } from "@/lib/errors";
import { initials } from "@/lib/format";
import { LangToggle, useT } from "@/lib/i18n";
import { signOutApp } from "@/components/portal/session";
import { askPush, unregisterPush } from "@/lib/push";
import { supabase } from "@/lib/supabase/client";
import { ref, type Complaint, type DataRequest, type Profile, type Property } from "@/lib/types";

type Me = Pick<Profile, "full_name" | "phone" | "id_type" | "id_no" | "id_verified">;
const CHANNELS: [keyof Prefs, string][] = [
  ["push", "push"],
  ["sms", "sms"],
  ["whatsapp", "wa"],
  ["email", "emailCh"],
  ["reminders", "remind"],
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
  const identityParam = params.get("identity");
  const [sheet, setSheet] = useState<"edit" | "id" | "help" | null>(identityParam ? "id" : null);
  const ti = useT(ID_DICT);
  const db = useCallback(() => supabase(), []);
  const { docs, urls, reload: reloadDocs } = useIdentityDocs(db, profile.id);
  const idRule = useIdentityRule(db);
  const [propSheet, setPropSheet] = useState<Property | "new" | null>(params.get("add") === "property" ? "new" : null);

  // Identity fields are private columns: they come from my_private_profile(), not the table.
  const loadMe = useCallback(() => {
    const db = supabase();
    return Promise.all([
      db.from("profiles").select("full_name, phone, id_verified").eq("id", profile.id).maybeSingle<Pick<Me, "full_name" | "phone" | "id_verified">>(),
      db.rpc("my_private_profile"),
    ]).then(([{ data: pub }, { data: priv }]) => {
      const p = (priv ?? {}) as Pick<Me, "id_type" | "id_no"> & { email?: string | null };
      // Optional contact email (phone sign-ups may have none).
      setEmail(p.email ?? null);
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

  // Data export (0027): my_data_export(request) returns the JSON once NWS has prepared it.
  const [exporting, setExporting] = useState<string | null>(null);
  async function downloadExport(d: DataRequest) {
    setExporting(d.id);
    const { data, error } = await supabase().rpc("my_data_export", { p_request_id: d.id });
    setExporting(null);
    if (error) return toast.show(friendlyError(error));
    if (!data) return toast.show(t("dsrExpired"));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nama-my-data-${ref.dataRequest(d.ref_no)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function pref(p: Prefs) {
    // Turning push on in the app asks the phone for permission (again, if refused before).
    if (p.push) askPush(true).catch(() => undefined);
    const error = await setPref(p);
    if (error) toast.show(friendlyError(error));
  }

  async function signOut() {
    await unregisterPush(); // this phone stops getting this account's pushes
    await signOutApp("customer");
    router.replace("/login?app=customer");
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
            {urls.selfie ? (
              <span className="av photo-av">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={urls.selfie} alt={ti("selfie")} />
              </span>
            ) : (
              <span className="av">{initials(name)}</span>
            )}
            <div>
              <b>{name || t("customer")}</b>
              <small dir="ltr" style={{ display: "block", textAlign: "start" }}>
                {me?.phone || profile.phone || t("noPhone")}
              </small>
              {email && <small dir="ltr">{email}</small>}
            </div>
            <button className="btn sm" onClick={() => setSheet("edit")}>
              <Icon name="edit" size={14} /> {t("edit")}
            </button>
          </div>
          {me?.id_verified ? (
            <div className="vf">
              <Icon name="shield" />
              {ti(me.id_type ?? "civil_id")}
              {me.id_no ? (
                <>
                  {" "}
                  <bdi dir="ltr">{me.id_no}</bdi>
                </>
              ) : null}{" "}
              · {ti("simulated")}
            </div>
          ) : (
            <>
              <button className="cta sec" style={{ margin: 0 }} onClick={() => setSheet("id")}>
                {t("idT")}
              </button>
              <small className="mut" style={{ display: "block", marginTop: 6 }}>
                {idRule.length ? ti("idNeeded", { what: idRule.map((s) => ti(`scope_${s}`)).join(", ") }) : ti("idOptional")}
              </small>
            </>
          )}
          <IdDocsStatus docs={docs} urls={urls} onUpdate={() => setSheet("id")} />
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

        <SlaHistory customerId={profile.id} />

        <h4 className="cx-h">{t("notifs")}</h4>
        {CHANNELS.map(([k, l]) => (
          <div key={k} className="lrow">
            <span>{t(l)}</span>
            <Toggle on={Boolean(prefs?.[k])} disabled={!prefs} label={t(l)} onChange={(v) => pref({ [k]: v })} />
          </div>
        ))}

        <h4 className="cx-h" id="data">
          {t("privacy")}
        </h4>
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
            <span className="btns">
              {d.kind === "access" && d.state === "completed" && (
                <button className="btn sm" disabled={exporting === d.id} onClick={() => downloadExport(d)}>
                  <Icon name="download" size={14} /> {exporting === d.id ? t("dsrPreparing") : t("dsrDownload")}
                </button>
              )}
              <span className={`st ${d.state === "completed" ? "ok" : d.state === "rejected" ? "bad" : "warn"}`}>{t(`dsrSt_${d.state}`)}</span>
            </span>
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
      {sheet === "id" && me && (
        <IdSheet
          userId={profile.id}
          verified={Boolean(me.id_verified)}
          hasFront={Boolean(docs?.some((d) => d.kind === "id_front" && d.review_status !== "rejected"))}
          existing={urls}
          problem={identityParam}
          onClose={() => setSheet(null)}
          onDone={(msg) => {
            setSheet(null);
            loadMe();
            reloadDocs();
            toast.show(msg);
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

/** Identity documents on file and their review state (0030); the national ID check itself is simulated. */
function IdDocsStatus({ docs, urls, onUpdate }: { docs: IdentityDoc[] | null; urls: Partial<Record<DocKind, string>>; onUpdate: () => void }) {
  const ti = useT(ID_DICT);
  if (docs === null) return null;
  const card = docs.filter((d) => d.kind !== "selfie");
  const worst = card.some((d) => d.review_status === "rejected") ? "rejected" : card.length && card.every((d) => d.review_status === "accepted") ? "accepted" : card.length ? "received" : null;
  return (
    <div className="id-status">
      <span className={`st ${worst === "accepted" ? "ok" : worst === "rejected" ? "bad" : worst ? "warn" : ""}`}>
        {ti(worst === "accepted" ? "docsAccepted" : worst === "rejected" ? "docsRejected" : worst ? "docsReceived" : "docsNone")}
      </span>
      <button type="button" className="lk" onClick={onUpdate}>
        {ti("updateDocs")}
      </button>
      {card.some((d) => urls[d.kind]) && (
        <div className="id-thumbs">
          {card.map((d) =>
            urls[d.kind] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={d.kind} src={urls[d.kind]} alt={ti(d.kind)} />
            ) : null,
          )}
        </div>
      )}
      {docs.find((d) => d.review_status === "rejected" && d.review_note) && <small className="mut">{docs.find((d) => d.review_status === "rejected")?.review_note}</small>}
    </div>
  );
}

function IdSheet({
  userId,
  verified,
  existing,
  problem,
  onClose,
  onDone,
}: {
  userId: string;
  verified: boolean;
  /** Whether a card photo is on file (photos are optional since 0037). */
  hasFront?: boolean;
  existing: Partial<Record<DocKind, string>>;
  problem: string | null;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const { t } = useCx();
  const ti = useT(ID_DICT);
  const [type, setType] = useState<IdType>("civil_id");
  const [no, setNo] = useState("");
  const [photos, setPhotos] = useState<IdPhotos>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(problem === "unavailable" ? ti("docsLater") : problem === "failed" ? ti("docsFailed") : null);
  const chosen = Object.values(photos).some(Boolean);
  async function save() {
    setError(null);
    if (!verified) {
      const bad = idNoProblem(type, no);
      if (bad) return setError(ti(bad));
    }
    setBusy(true);
    const db = supabase();
    if (!verified) {
      const code = await verifyIdNumber(db, type, no);
      if (code) {
        setBusy(false);
        return setError(friendlyError({ message: code }));
      }
    }
    const up = await saveIdentityPhotos(db, userId, photos);
    setBusy(false);
    if (up.problem) return setError(ti(up.problem === "unavailable" ? "docsLater" : "docsFailed"));
    onDone(verified ? ti("docsSaved") : t("idOk"));
  }
  return (
    <Sheet title={verified ? ti("idDocs") : t("idT")} onClose={onClose}>
      <p className="mut small" style={{ marginTop: 0 }}>
        {ti("idSecS")}
      </p>
      <IdentityFields
        type={type}
        no={no}
        photos={photos}
        onType={setType}
        onNo={setNo}
        onPhoto={(k, f) => setPhotos((p) => ({ ...p, [k]: f }))}
        existing={existing}
        numberLocked={verified}
      />
      {error && <div className="banner badb">{error}</div>}
      <button className="cta" disabled={busy || (verified ? !chosen : no.trim().length < 5)} onClick={save}>
        {busy ? ti("uploading") : verified ? ti("saveDocs") : t("verify")}
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
