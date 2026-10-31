// The one refund policy (#35), English and Arabic. Every screen that talks about refunds shows
// these lines (components/customer/RefundPolicy.tsx in the apps; the Business portal reads the
// same keys), so the wording can't drift apart. The refund_issued message (0039) says the same.
//
// Refunds go back the way the customer paid (0047, security review SEC-02): the wallet part to
// the wallet, the card part to the same card (card_refunds). The card refund time (5–10 working
// days) is a placeholder until NWS and the payment gateway confirm it.
import type { Dict } from "@/lib/i18n";

export const REFUND_POLICY: Dict = {
  rpTitle: { en: "Refunds", ar: "الاسترداد" },
  rpWhere: {
    en: "Refunds go back the way you paid: what you paid from your Nama wallet returns to the wallet straight away; what you paid by card goes back to the same card.",
    ar: "يُعاد المبلغ بالطريقة التي دفعت بها: ما دفعته من محفظتك في نماء يعود إلى المحفظة فوراً، وما دفعته بالبطاقة يعود إلى البطاقة نفسها.",
  },
  rpCard: {
    en: "Card refunds usually show on your card within 5–10 working days, depending on your bank. Questions? Call NWS on 1442 or file a complaint in the app.",
    ar: "يظهر الاسترداد إلى البطاقة عادةً خلال ٥ إلى ١٠ أيام عمل حسب البنك. لديك سؤال؟ اتصل بنماء على 1442 أو قدّم شكوى في التطبيق.",
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
    en: "Short delivery: if the meter shows less water than you paid for, the difference is refunded automatically, the way you paid.",
    ar: "التوصيل الناقص: إذا أظهر العداد كمية أقل مما دفعت ثمنه، يُسترد الفرق تلقائياً بالطريقة التي دفعت بها.",
  },
  rpComplaint: { en: "A complaint NWS upholds is refunded the same way.", ar: "الشكوى التي تقبلها نماء يُسترد مبلغها بالطريقة نفسها." },
  rpWalletDone: { en: "Refunded: {amount}, back the way you paid (wallet at once, card within a few working days).", ar: "تم الاسترداد: {amount}، بالطريقة التي دفعت بها (المحفظة فوراً، والبطاقة خلال أيام عمل قليلة)." },
  rpBusiness: {
    en: "Business accounts: orders on account are charged only on delivery, so a cancelled order costs nothing; credits for short delivery or upheld complaints appear on your next invoice.",
    ar: "حسابات الأعمال: لا تُحتسب الطلبات على الحساب إلا عند التوصيل، لذا لا يكلف الطلب الملغى شيئاً؛ وتظهر أرصدة التوصيل الناقص أو الشكاوى المقبولة في فاتورتك القادمة.",
  },
  rpMore: { en: "How refunds work", ar: "كيف يتم الاسترداد" },
};

/** The policy lines in order, for the full view (wallet, terms). */
export const REFUND_LINES = ["rpWhere", "rpCard", "rpFree", "rpFeeAny", "rpArrived", "rpShort", "rpComplaint"] as const;
