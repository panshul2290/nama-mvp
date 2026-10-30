"use client";

// E1 identity: the ID / resident card number (through verify_identity, a simulated check) and
// photos of the card (front, optional back) and an optional selfie. The photos go to the
// private "identity" bucket under <uid>/ (owner-only, NWS staff can read: 0030) and are
// recorded by add_identity_document() so NWS can review them. Used at sign-up and in Account.
import "./identity.css";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { errorCode } from "@/lib/errors";
import { useT, type Dict } from "@/lib/i18n";
import { nativeCamera, nativePhoto, PhotoError, shrinkPhoto, type PhotoSource } from "@/lib/photo";
import { isMissing } from "@/lib/rpcCompat";

export const ID_TYPES = ["civil_id", "resident_card", "passport"] as const;
export type IdType = (typeof ID_TYPES)[number];
export const DOC_KINDS = ["id_front", "id_back", "selfie"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export type IdPhotos = Partial<Record<DocKind, File | null>>;
export type IdentityDoc = { id: string; kind: DocKind; file_path: string; uploaded_at: string; review_status: "received" | "accepted" | "rejected"; review_note: string | null };
export const BUCKET = "identity";

export const ID_DICT: Dict = {
  idSec: { en: "Your identity", ar: "هويتك" },
  idSecS: { en: "NWS asks every account for a national ID or resident card. The check in this demo is simulated; your photos are kept privately for NWS to review.", ar: "تطلب نماء من كل حساب البطاقة المدنية أو بطاقة الإقامة. التحقق في هذا العرض محاكاة؛ وتُحفظ صورك بشكل خاص لتراجعها نماء." },
  civil_id: { en: "Civil ID", ar: "البطاقة المدنية" },
  resident_card: { en: "Resident card", ar: "بطاقة الإقامة" },
  passport: { en: "Passport", ar: "جواز السفر" },
  idType: { en: "Document", ar: "الوثيقة" },
  idNo: { en: "ID number", ar: "رقم الهوية" },
  idNoHint: { en: "8 digits, as printed on the card", ar: "٨ أرقام كما هي مطبوعة على البطاقة" },
  idNoBad: { en: "Enter the 8-digit number on the card.", ar: "أدخل الرقم المكوّن من ٨ أرقام الموجود على البطاقة." },
  passNoBad: { en: "Enter the passport number (at least 5 characters).", ar: "أدخل رقم جواز السفر (٥ أحرف على الأقل)." },
  id_front: { en: "Card — front", ar: "البطاقة — الوجه الأمامي" },
  id_back: { en: "Card — back (optional)", ar: "البطاقة — الوجه الخلفي (اختياري)" },
  selfie: { en: "Profile photo (optional)", ar: "صورة شخصية (اختياري)" },
  frontNeeded: { en: "Add a photo of the front of the card.", ar: "أضف صورة للوجه الأمامي من البطاقة." },
  takePhoto: { en: "Take photo", ar: "التقاط صورة" },
  choose: { en: "Choose", ar: "اختيار" },
  retake: { en: "Change", ar: "تغيير" },
  removePhoto: { en: "Remove", ar: "إزالة" },
  photoDenied: { en: "The app isn’t allowed to use the camera. Allow it in Settings, or choose a photo.", ar: "لا يُسمح للتطبيق باستخدام الكاميرا. اسمح بذلك من الإعدادات أو اختر صورة." },
  photoFailed: { en: "The photo couldn’t be read. Try again.", ar: "تعذّرت قراءة الصورة. حاول مجدداً." },
  simulated: { en: "Verified · simulated check", ar: "موثق · تحقق تجريبي" },
  notVerified: { en: "Not verified yet", ar: "لم يتم التحقق بعد" },
  docsReceived: { en: "Documents received — NWS reviews them", ar: "تم استلام الوثائق — تراجعها نماء" },
  docsAccepted: { en: "Documents accepted by NWS", ar: "قبلت نماء الوثائق" },
  docsRejected: { en: "NWS asked for new photos", ar: "طلبت نماء صوراً جديدة" },
  docsNone: { en: "No card photo on file", ar: "لا توجد صورة للبطاقة" },
  docsLater: { en: "Photo upload isn’t available yet — you can add the photos later in Account.", ar: "رفع الصور غير متاح بعد — يمكنك إضافتها لاحقاً من الحساب." },
  docsFailed: { en: "The photos couldn’t be uploaded. Add them again in Account.", ar: "تعذّر رفع الصور. أضفها مجدداً من الحساب." },
  st_received: { en: "Received", ar: "تم الاستلام" },
  st_accepted: { en: "Accepted", ar: "مقبول" },
  st_rejected: { en: "Re-upload", ar: "أعد الرفع" },
  idDocs: { en: "Identity documents", ar: "وثائق الهوية" },
  updateDocs: { en: "Add or replace photos", ar: "إضافة الصور أو استبدالها" },
  saveDocs: { en: "Upload", ar: "رفع" },
  uploading: { en: "Uploading…", ar: "جارٍ الرفع…" },
  docsSaved: { en: "Photos uploaded — NWS will review them.", ar: "تم رفع الصور — ستراجعها نماء." },
};

/** Why the number can't be checked, as a dictionary key; null when it looks right. */
export function idNoProblem(type: IdType, no: string): string | null {
  const v = no.trim();
  if (type === "passport") return /^[A-Za-z0-9]{5,20}$/.test(v) ? null : "passNoBad";
  return /^[0-9]{8}$/.test(v) ? null : "idNoBad";
}

/** Upload the chosen photos and record them. Resolves to how many were saved, or why none could be. */
export async function saveIdentityPhotos(db: SupabaseClient, userId: string, photos: IdPhotos): Promise<{ saved: number; problem: "unavailable" | "failed" | null }> {
  let saved = 0;
  for (const kind of DOC_KINDS) {
    const file = photos[kind];
    if (!file) continue;
    const small = await shrinkPhoto(file);
    const path = `${userId}/${crypto.randomUUID()}.jpg`;
    const up = await db.storage.from(BUCKET).upload(path, small, { contentType: small.type || "image/jpeg", upsert: false });
    if (up.error) return { saved, problem: isMissing(up.error) || /not found/i.test(up.error.message) ? "unavailable" : "failed" };
    const { error } = await db.rpc("add_identity_document", { p_kind: kind, p_path: path });
    if (error) {
      await db.storage.from(BUCKET).remove([path]);
      return { saved, problem: isMissing(error) ? "unavailable" : "failed" };
    }
    saved++;
  }
  return { saved, problem: null };
}

/** The number goes through verify_identity (simulated national check) exactly as before. */
export async function verifyIdNumber(db: SupabaseClient, type: IdType, no: string) {
  const { error } = await db.rpc("verify_identity", { p_id_type: type, p_id_no: no.trim() });
  return error ? (errorCode(error) ?? "failed") : null;
}

/** The person's identity documents (0030) with short-lived links to the photos; [] before the migration. */
export function useIdentityDocs(db: () => SupabaseClient, userId: string) {
  const [docs, setDocs] = useState<IdentityDoc[] | null>(null);
  const [urls, setUrls] = useState<Partial<Record<DocKind, string>>>({});
  const load = useCallback(async () => {
    const c = db();
    const { data, error } = await c.from("identity_documents").select("*").eq("user_id", userId);
    const rows = error ? [] : ((data ?? []) as IdentityDoc[]);
    setDocs(rows);
    const next: Partial<Record<DocKind, string>> = {};
    await Promise.all(
      rows.map(async (d) => {
        const { data: s } = await c.storage.from(BUCKET).createSignedUrl(d.file_path, 600);
        if (s?.signedUrl) next[d.kind] = s.signedUrl;
      }),
    );
    setUrls(next);
  }, [db, userId]);
  useEffect(() => {
    const t0 = setTimeout(load, 0);
    return () => clearTimeout(t0);
  }, [load]);
  return { docs, urls, reload: load };
}

/** One photo: take it with the camera or choose one, with a preview. */
export function PhotoSlot({ kind, file, existing, onChange }: { kind: DocKind; file: File | null | undefined; existing?: string; onChange: (f: File | null) => void }) {
  const t = useT(ID_DICT);
  const [preview, setPreview] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return;
    const u = URL.createObjectURL(file);
    const t0 = setTimeout(() => setPreview(u), 0);
    return () => {
      clearTimeout(t0);
      URL.revokeObjectURL(u);
    };
  }, [file]);
  const shown = file ? preview : (existing ?? null);
  const native = nativeCamera();
  async function pick(source: PhotoSource) {
    setMsg(null);
    try {
      onChange(await nativePhoto(source));
    } catch (e) {
      if (e instanceof PhotoError && e.reason !== "cancelled") setMsg(t(e.reason === "denied" ? "photoDenied" : "photoFailed"));
    }
  }
  const input = (capture: boolean) => (
    <input
      type="file"
      accept="image/*"
      {...(capture ? { capture: kind === "selfie" ? "user" : "environment" } : {})}
      className="idp-file"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) onChange(f);
        e.target.value = "";
      }}
    />
  );
  return (
    <div className="idp">
      <span className="idp-l">{t(kind)}</span>
      <div className={`idp-box${shown ? " has" : ""}${kind === "selfie" ? " round" : ""}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {shown ? <img src={shown} alt={t(kind)} /> : <Icon name={kind === "selfie" ? "user" : "file"} size={26} />}
      </div>
      <div className="idp-btns">
        {native ? (
          <>
            <button type="button" className="btn sm" onClick={() => pick("camera")}>
              <Icon name="camera" size={14} /> {t("takePhoto")}
            </button>
            <button type="button" className="btn sm" onClick={() => pick("gallery")}>
              {t("choose")}
            </button>
          </>
        ) : (
          <>
            <label className="btn sm">
              <Icon name="camera" size={14} /> {shown ? t("retake") : t("takePhoto")}
              {input(true)}
            </label>
            <label className="btn sm">
              {t("choose")}
              {input(false)}
            </label>
          </>
        )}
        {file && (
          <button type="button" className="lk" onClick={() => onChange(null)}>
            {t("removePhoto")}
          </button>
        )}
      </div>
      {msg && <small className="badt">{msg}</small>}
    </div>
  );
}

/** ID type, number and the three photo slots. */
export function IdentityFields({
  type,
  no,
  photos,
  onType,
  onNo,
  onPhoto,
  existing,
  numberLocked,
}: {
  type: IdType;
  no: string;
  photos: IdPhotos;
  onType: (t: IdType) => void;
  onNo: (v: string) => void;
  onPhoto: (k: DocKind, f: File | null) => void;
  existing?: Partial<Record<DocKind, string>>;
  /** Already verified: only the photos can change. */
  numberLocked?: boolean;
}) {
  const t = useT(ID_DICT);
  return (
    <div className="idf">
      {!numberLocked && (
        <>
          <div className="seg" role="radiogroup" aria-label={t("idType")}>
            {ID_TYPES.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={type === k} className={type === k ? "on" : ""} onClick={() => onType(k)}>
                {t(k)}
              </button>
            ))}
          </div>
          <div className="fld">
            <label htmlFor="idno">{t("idNo")}</label>
            <input
              id="idno"
              dir="ltr"
              maxLength={20}
              autoComplete="off"
              inputMode={type === "passport" ? "text" : "numeric"}
              value={no}
              onChange={(e) => onNo(e.target.value)}
            />
            {type !== "passport" && <small className="idf-hint">{t("idNoHint")}</small>}
          </div>
        </>
      )}
      <div className="idp-row">
        {DOC_KINDS.map((k) => (
          <PhotoSlot key={k} kind={k} file={photos[k]} existing={existing?.[k]} onChange={(f) => onPhoto(k, f)} />
        ))}
      </div>
    </div>
  );
}
