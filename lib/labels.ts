// One set of status labels and tones for the web portals (NWS, Company, Business), so the same
// penalty, contract, permit stage or invitation reads the same everywhere. The phone apps have
// their own English/Arabic wording (components/customer/i18n.ts, components/driver/i18n.ts) and
// follow the same tones. Every label has an Arabic counterpart in LABELS; the English records
// stay as they are because exports (CSV/XLS) keep English wording.
import type { Dict, Lang } from "./i18n";
import type { Invitation, OrderStatus, OrgRole, Penalty, StaffRole } from "./types";

export type Tone = "ok" | "warn" | "bad" | "act" | "";

/** English and Arabic for the shared vocabulary, keyed "<group>.<value>". */
export const LABELS: Dict = {
  // Services
  "svc.DW": { en: "Drinking water", ar: "مياه الشرب" },
  "svc.WW": { en: "Wastewater", ar: "مياه الصرف" },
  "svc.TE": { en: "Treated effluent", ar: "المياه المعالجة" },
  "svcShort.DW": { en: "Drinking water", ar: "مياه الشرب" },
  "svcShort.WW": { en: "Wastewater", ar: "مياه الصرف" },
  "svcShort.TE": { en: "Treated water", ar: "مياه معالجة" },
  // Order status (components/OrderBits STATUS_TEXT)
  "order.scheduled": { en: "Scheduled", ar: "مجدول" },
  "order.pending_approval": { en: "Awaiting approval", ar: "بانتظار الموافقة" },
  "order.requested": { en: "Finding a tanker", ar: "جارٍ البحث عن صهريج" },
  "order.accepted": { en: "Driver assigned", ar: "تم تعيين السائق" },
  "order.arriving": { en: "On the way", ar: "في الطريق" },
  "order.arrived": { en: "Arrived", ar: "وصل" },
  "order.collected": { en: "Collected", ar: "تم السحب" },
  "order.delivered": { en: "Delivered", ar: "تم التوصيل" },
  "order.cancelled": { en: "Cancelled", ar: "ملغى" },
  "order.completed": { en: "Completed", ar: "مكتمل" },
  // Order steps (OrderBits Stepper)
  "step.requested": { en: "Requested", ar: "تم الطلب" },
  "step.accepted": { en: "Accepted", ar: "تم القبول" },
  "step.arriving": { en: "On the way", ar: "في الطريق" },
  "step.arrived": { en: "Arrived", ar: "وصل" },
  "step.delivered": { en: "Delivered", ar: "تم التوصيل" },
  "step.now": { en: "now", ar: "الآن" },
  // Penalties
  "penalty.issued": { en: "Issued", ar: "صادرة" },
  "penalty.disputed": { en: "Disputed — NWS reviewing", ar: "معترض عليها — قيد مراجعة نماء" },
  "penalty.upheld": { en: "Upheld", ar: "مؤيدة" },
  "penalty.cancelled": { en: "Cancelled", ar: "ملغاة" },
  // Contracts
  "contract.pending_owner": { en: "Awaiting the tanker company", ar: "بانتظار شركة الصهاريج" },
  "contract.pending_owner.company": { en: "Awaiting your decision", ar: "بانتظار قرارك" },
  "contract.active": { en: "Active", ar: "ساري" },
  "contract.paused": { en: "Paused", ar: "متوقف مؤقتاً" },
  "contract.ended": { en: "Ended", ar: "منتهٍ" },
  "contract.declined": { en: "Declined", ar: "مرفوض" },
  // Permit application stages
  "stage.submitted": { en: "Submitted", ar: "مقدَّم" },
  "stage.documents": { en: "Document check", ar: "فحص المستندات" },
  "stage.inspection": { en: "Inspection", ar: "الفحص الفني" },
  "stage.decision": { en: "Decision", ar: "القرار" },
  // Invitations
  "inv.pending": { en: "Pending", ar: "قيد الانتظار" },
  "inv.expired": { en: "Expired", ar: "منتهية الصلاحية" },
  "inv.accepted": { en: "Accepted", ar: "مقبولة" },
  "inv.declined": { en: "Declined", ar: "مرفوضة" },
  "inv.revoked": { en: "Revoked", ar: "ملغاة" },
  // NWS staff roles (components/nws/StaffContext STAFF_ROLE_LABEL)
  "staff.admin": { en: "Super admin", ar: "مسؤول النظام" },
  "staff.operator": { en: "Control room operator", ar: "مشغّل غرفة التحكم" },
  "staff.permit_officer": { en: "Permit officer", ar: "موظف التصاريح" },
  "staff.inspector": { en: "Inspector", ar: "مفتش" },
  "staff.complaints_agent": { en: "Complaints agent", ar: "موظف الشكاوى" },
  "staff.finance": { en: "Finance", ar: "المالية" },
  "staff.viewer": { en: "Read-only (BI)", ar: "اطلاع فقط (ذكاء الأعمال)" },
  // Business account roles and segments (components/business/BizContext)
  "org.admin": { en: "Account admin", ar: "مسؤول الحساب" },
  "org.site_manager": { en: "Site manager", ar: "مدير الموقع" },
  "org.finance": { en: "Finance", ar: "المالية" },
  "seg.commercial": { en: "Commercial", ar: "تجاري" },
  "seg.government": { en: "Government", ar: "حكومي" },
  "seg.industrial": { en: "Industrial", ar: "صناعي" },
  "seg.farm": { en: "Farm", ar: "مزرعة" },
  // Order channels and alert severities (components/nws/ops)
  "channel.app": { en: "App", ar: "التطبيق" },
  "channel.call_centre": { en: "Call centre", ar: "مركز الاتصال" },
  "channel.business": { en: "Business", ar: "الأعمال" },
  "channel.contract": { en: "Contract", ar: "عقد" },
  "sev.high": { en: "High", ar: "عالية" },
  "sev.med": { en: "Medium", ar: "متوسطة" },
  "sev.low": { en: "Low", ar: "منخفضة" },
  // Order SLA (components/nws/ops orderSla)
  "sla.onTime": { en: "On time", ar: "في الموعد" },
  "sla.late": { en: "Late", ar: "متأخر" },
  "sla.atRisk": { en: "At risk", ar: "معرّض للتأخر" },
  // Contract frequencies
  "freq.weekly": { en: "Weekly", ar: "أسبوعياً" },
  "freq.biweekly": { en: "Every 2 weeks", ar: "كل أسبوعين" },
  "freq.monthly": { en: "Monthly", ar: "شهرياً" },
};

/** The label for "<group>.<value>" in a language; `fallback` (usually the English record) when unknown. */
export function label(group: string, value: string, lang: Lang = "en", fallback?: string): string {
  const e = LABELS[`${group}.${value}`];
  return e ? e[lang] || e.en : (fallback ?? value);
}

export const serviceLabel = (s: string, lang: Lang = "en") => label("svc", s, lang);
export const staffRoleLabel = (r: StaffRole, lang: Lang = "en") => label("staff", r, lang);
export const orgRoleLabel = (r: OrgRole, lang: Lang = "en") => label("org", r, lang);
export const segmentLabel = (s: string, lang: Lang = "en") => label("seg", s, lang);
export const orderStatusLabel = (s: OrderStatus | "completed", lang: Lang = "en") => label("order", s, lang);
export const freqLabel = (f: string, lang: Lang = "en") => label("freq", f, lang);

/** Penalty states: issued (deducted, can be disputed), disputed (NWS deciding), upheld, cancelled (refunded). */
export const PENALTY_STATE: Record<Penalty["state"], [string, Tone]> = {
  issued: ["Issued", "warn"],
  disputed: ["Disputed — NWS reviewing", "act"],
  upheld: ["Upheld", "bad"],
  cancelled: ["Cancelled", ""],
};
/** A penalty state's label and tone in a language. */
export function penaltyState(s: Penalty["state"], lang: Lang = "en"): [string, Tone] {
  const [en, tone] = PENALTY_STATE[s] ?? [s, ""];
  return [label("penalty", s, lang, en), tone];
}

/** Contract status; the tanker company sees an offer as waiting for its own decision. */
const CONTRACT: Record<string, [string, Tone]> = {
  pending_owner: ["Awaiting the tanker company", "warn"],
  active: ["Active", "ok"],
  paused: ["Paused", "warn"],
  ended: ["Ended", ""],
  declined: ["Declined", "bad"],
};
export function contractStatus(status: string, viewer: "company" | "other" = "other", lang: Lang = "en"): [string, Tone] {
  if (status === "pending_owner" && viewer === "company") return [label("contract", "pending_owner.company", lang), "warn"];
  const [en, tone] = CONTRACT[status] ?? [status, ""];
  return [label("contract", status, lang, en), tone];
}

/** Permit application stages, in order. */
export const PERMIT_STAGE: Record<string, string> = { submitted: "Submitted", documents: "Document check", inspection: "Inspection", decision: "Decision" };
export const permitStage = (s: string, lang: Lang = "en") => label("stage", s, lang, PERMIT_STAGE[s]);

/** Invitations (company → driver, organisation → member); a pending one past its date is expired. */
export function invitationStatus(i: Pick<Invitation, "status" | "expires_at">, now = Date.now(), lang: Lang = "en"): [string, Tone] {
  const [key, tone]: [string, Tone] =
    i.status === "pending"
      ? Date.parse(i.expires_at) < now
        ? ["expired", "bad"]
        : ["pending", "act"]
      : i.status === "accepted"
        ? ["accepted", "ok"]
        : i.status === "declined"
          ? ["declined", "bad"]
          : ["revoked", ""];
  return [label("inv", key, lang), tone];
}
