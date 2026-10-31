// English / Arabic for staff wallet credits that need a second approver (0051, security review
// SEC-08): the "sent for approval" message on complaints and orders, and the approvals panel in
// Settings → Payments (components/nws/credits.tsx). Pure data (the i18n unit test loads it).
import type { Dict } from "@/lib/i18n";
import { withCommon } from "@/components/portal/dict";

export const CREDITS: Dict = withCommon({
  crRequested: { en: "Above the limit: sent to finance for approval as CR-{no}", ar: "فوق الحد: أُرسل إلى المالية للموافقة برقم CR-{no}" },
  crTitle: { en: "Credits waiting for a second approver", ar: "أرصدة بانتظار موافقة ثانية" },
  crSub: { en: "goodwill and refunds to wallets above the limit; you can't approve your own", ar: "أرصدة حسن النية والاسترداد إلى المحافظ فوق الحد؛ لا يمكنك الموافقة على طلبك" },
  crNone: { en: "Nothing waiting.", ar: "لا شيء بانتظار الموافقة." },
  crNo: { en: "Request", ar: "الطلب" },
  crCustomer: { en: "Customer", ar: "العميل" },
  crKind: { en: "Type", ar: "النوع" },
  crAmount: { en: "Amount", ar: "المبلغ" },
  crBy: { en: "Requested by", ar: "طلبه" },
  crReason: { en: "Reason", ar: "السبب" },
  "crKind.goodwill": { en: "Goodwill", ar: "حسن نية" },
  "crKind.complaint_refund": { en: "Complaint refund", ar: "استرداد شكوى" },
  "crKind.order_refund": { en: "Order refund", ar: "استرداد طلب" },
  crApprove: { en: "Approve", ar: "موافقة" },
  crReject: { en: "Reject", ar: "رفض" },
  crOwn: { en: "Your own request: another finance member or an admin approves it", ar: "طلبك أنت: يوافق عليه موظف مالية آخر أو مسؤول" },
  crRoles: { en: "Finance and admins approve credits", ar: "توافق المالية والمسؤولون على الأرصدة" },
  crApproveT: { en: "Approve CR-{no}: {amount} to {name}?", ar: "الموافقة على CR-{no}: {amount} إلى {name}؟" },
  crRejectT: { en: "Reject CR-{no}?", ar: "رفض CR-{no}؟" },
  crApproveB: { en: "The wallet is credited now (a refund goes back the way the customer paid). Audited under your name.", ar: "تُضاف القيمة الآن (والاسترداد يعود بالطريقة التي دفع بها العميل). يُسجَّل باسمك." },
  crRejectB: { en: "Nothing is credited. The requester sees your reason in the audit log.", ar: "لا يُضاف شيء. يرى مقدّم الطلب سببك في سجل التدقيق." },
  crApproved: { en: "Credit approved", ar: "تمت الموافقة على الرصيد" },
  crRejected: { en: "Credit rejected", ar: "تم رفض الرصيد" },
  crRefundReason: { en: "Refund for complaint C-{no}", ar: "استرداد للشكوى C-{no}" },
});
