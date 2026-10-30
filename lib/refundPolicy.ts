// The one refund policy (#35), English and Arabic. Every screen that talks about refunds shows
// these lines (components/customer/RefundPolicy.tsx in the apps; the Business portal reads the
// same keys), so the wording can't drift apart. The refund_issued message (0039) says the same.
//
// Card refund time (5–10 working days) and the 30-day window are placeholders until NWS and the
// payment gateway confirm them.
import type { Dict } from "@/lib/i18n";

export const REFUND_POLICY: Dict = {
  rpTitle: { en: "Refunds", ar: "الاسترداد" },
  rpWhere: {
    en: "Refunds go to your Nama wallet straight away and you can use them on your next order.",
    ar: "يُعاد المبلغ إلى محفظتك في نماء فوراً ويمكنك استخدامه في طلبك القادم.",
  },
  rpCard: {
    en: "Prefer your original card? Ask NWS within 30 days (call 1442 or file a complaint in the app). Where the card gateway supports it, card refunds take 5–10 working days.",
    ar: "تفضّل الاسترداد إلى بطاقتك الأصلية؟ اطلب ذلك من نماء خلال ٣٠ يوماً (اتصل على 1442 أو قدّم شكوى في التطبيق). حين تدعم بوابة الدفع ذلك، يستغرق الاسترداد إلى البطاقة من ٥ إلى ١٠ أيام عمل.",
  },
  rpFree: { en: "Cancel before a tanker is assigned: free, the full amount comes back.", ar: "الإلغاء قبل تعيين صهريج: مجاني، ويُعاد المبلغ كاملاً." },
  rpFee: {
    en: "Cancel after a tanker is assigned (before it arrives): the cancellation fee of {fee} goes to the tanker company; the rest comes back.",
    ar: "الإلغاء بعد تعيين صهريج (قبل وصوله): تذهب رسوم الإلغاء البالغة {fee} إلى شركة الصهاريج، ويُعاد الباقي.",
  },
  rpFeeAny: {
    en: "Cancel after a tanker is assigned (before it arrives): the cancellation fee goes to the tanker company; the rest comes back.",
    ar: "الإلغاء بعد تعيين صهريج (قبل وصوله): تذهب رسوم الإلغاء إلى شركة الصهاريج، ويُعاد الباقي.",
  },
  rpArrived: { en: "Once the tanker has arrived the order can’t be cancelled in the app: call NWS on 1442.", ar: "بعد وصول الصهريج لا يمكن إلغاء الطلب من التطبيق: اتصل بنماء على 1442." },
  rpShort: {
    en: "Short delivery: if the meter shows less water than you paid for, the difference is credited to your wallet automatically.",
    ar: "التوصيل الناقص: إذا أظهر العداد كمية أقل مما دفعت ثمنه، يُضاف الفرق إلى محفظتك تلقائياً.",
  },
  rpComplaint: { en: "A complaint NWS upholds is refunded to your wallet too.", ar: "الشكوى التي تقبلها نماء يُسترد مبلغها إلى محفظتك أيضاً." },
  rpWalletDone: { en: "Refunded to your Nama wallet: {amount}. It’s ready to use now.", ar: "تم الاسترداد إلى محفظتك في نماء: {amount}. المبلغ متاح للاستخدام الآن." },
  rpBusiness: {
    en: "Business accounts: orders on account are charged only on delivery, so a cancelled order costs nothing; credits for short delivery or upheld complaints appear on your next invoice.",
    ar: "حسابات الأعمال: لا تُحتسب الطلبات على الحساب إلا عند التوصيل، لذا لا يكلف الطلب الملغى شيئاً؛ وتظهر أرصدة التوصيل الناقص أو الشكاوى المقبولة في فاتورتك القادمة.",
  },
  rpMore: { en: "How refunds work", ar: "كيف يتم الاسترداد" },
};

/** The policy lines in order, for the full view (wallet, terms). */
export const REFUND_LINES = ["rpWhere", "rpCard", "rpFree", "rpFeeAny", "rpArrived", "rpShort", "rpComplaint"] as const;
