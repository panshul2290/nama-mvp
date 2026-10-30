// English / Arabic for the business portal's e-invoice additions (0036): VAT numbers on the
// invoice and "Export UBL XML". On top of BIZ, so pages use one dictionary. Pure data (the i18n
// unit test loads it).
import type { Dict } from "@/lib/i18n";
import { BIZ } from "@/components/business/i18n";

export const BIZ_MONEY: Dict = {
  ...BIZ,
  sellerVat: { en: "VAT no. {v}", ar: "الرقم الضريبي {v}" },
  sellerVatPending: { en: "VAT no. to be confirmed", ar: "الرقم الضريبي قيد التأكيد" },
  buyerVat: { en: "VAT no. {v}", ar: "الرقم الضريبي {v}" },
  buyerVatNone: { en: "No VAT number on file", ar: "لا يوجد رقم ضريبي مسجّل" },
  invMeta: { en: "Type {code} · currency {cur} · issued {at}", ar: "النوع {code} · العملة {cur} · صدرت {at}" },
  ublExport: { en: "Export UBL XML", ar: "تصدير UBL XML" },
  ublSaved: { en: "UBL XML saved: {file}", ar: "تم حفظ UBL XML: {file}" },
  ublCheck: { en: "Saved, but check: {what}", ar: "تم الحفظ، لكن تحقق من: {what}" },
  ublNoSeller: { en: "the seller VAT number", ar: "الرقم الضريبي للبائع" },
  ublNoBuyer: { en: "your VAT number", ar: "رقمك الضريبي" },
  vatNote: { en: "VAT treatment to be confirmed with the Tax Authority.", ar: "المعاملة الضريبية قيد التأكيد مع جهاز الضرائب." },
  myVatT: { en: "Your VAT number", ar: "رقمك الضريبي" },
  myVatS: { en: "printed on your invoices and their e-invoice (UBL)", ar: "يظهر في فواتيرك وفاتورتها الإلكترونية (UBL)" },
  myVatHint: { en: "OM followed by 10 digits, e.g. OM1100012345", ar: "OM يليه 10 أرقام، مثال: OM1100012345" },
  myVatNone: { en: "Not set", ar: "غير محدد" },
  myVatSaved: { en: "VAT number saved", ar: "تم حفظ الرقم الضريبي" },
};
