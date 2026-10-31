import type { Lang } from "@/lib/i18n";

// Alert messages are written in English by the database (raise_alert in the migrations). In
// Arabic the screens rebuild them from the known message shapes; anything unrecognised (an
// older or hand-written message) is shown as stored.
type Rule = [RegExp, (m: RegExpMatchArray) => string];

const plate = (p: string) => `⁦${p}⁩`; // keep plates and order numbers left-to-right
const RULES: Rule[] = [
  [/^SOS from (.+?) \((.+?)\)(?:: (.*?))?( · updated .*)?$/, (m) => `استغاثة من ${plate(m[1])} (${m[2] === "driver" ? "السائق" : m[2]})${m[3] ? `: ${m[3]}` : ""}${m[4] ? " · محدَّثة" : ""}`],
  [/^(.+?) at ([\d.]+) km\/h \(limit (\d+) for heavy vehicles\)$/, (m) => `${plate(m[1])} بسرعة ${m[2]} كم/س (الحد ${m[3]} للمركبات الثقيلة)`],
  [/^(.+?) at ([\d.]+) km\/h on (.+?) \(limit (\d+)\)$/, (m) => `${plate(m[1])} بسرعة ${m[2]} كم/س على ${m[3]} (الحد ${m[4]})`],
  [/^(.+?) is outside every NWS service area$/, (m) => `${plate(m[1])} خارج جميع مناطق خدمة نما`],
  [/^(.+?) online with no GPS for over 5 minutes$/, (m) => `${plate(m[1])} متصل دون إشارة موقع لأكثر من 5 دقائق`],
  [/^(.+?): no GPS for (\d+) minutes near (.+)$/, (m) => `${plate(m[1])}: دون إشارة موقع لمدة ${m[2]} دقيقة قرب ${m[3]}`],
  [/^TO-(\d+): (\d+) of (\d+) gal delivered$/, (m) => `${plate(`TO-${m[1]}`)}: سُلِّم ${m[2]} من ${m[3]} جالون`],
  [/^TO-(\d+) missed its (.+?) window$/, (m) => `${plate(`TO-${m[1]}`)} تجاوز موعد التوصيل (${m[2] === "delivery" ? "التوصيل" : m[2]})`],
  [/^(.+?) loaded for TO-(\d+) and idle for 20 minutes$/, (m) => `${plate(m[1])} محمّل للطلب ${plate(`TO-${m[2]}`)} ومتوقف منذ 20 دقيقة`],
  [/^(.+?) on TO-(\d+) without a valid permit$/, (m) => `${plate(m[1])} في الطلب ${plate(`TO-${m[2]}`)} دون تصريح ساري`],
  [/^(.+?) reported moving with an expired permit$/, (m) => `${plate(m[1])} يتحرك بتصريح منتهي`],
  [/^(.+?) confirmed filling for TO-(\d+) outside (.+?) geofence$/, (m) => `${plate(m[1])} أكّد التعبئة للطلب ${plate(`TO-${m[2]}`)} خارج نطاق ${m[3]}`],
  [/^(.+?) discharged TO-(\d+) outside (.+?) geofence$/, (m) => `${plate(m[1])} فرّغ الطلب ${plate(`TO-${m[2]}`)} خارج نطاق ${m[3]}`],
  [/^(.+?) opened its valve ([\d.]+) km from (.+)$/, (m) => `${plate(m[1])} فتح الصمام على بعد ${m[2]} كم من ${m[3]}`],
  [/^(.+?) collected outside its contracted zone$/, (m) => `${plate(m[1])} سحب من خارج منطقته المتعاقد عليها`],
  [
    /^(.+?): customer on TO-(\d+) reports the driver asked for (.+)$/,
    (m) => `${plate(m[1])}: عميل الطلب ${plate(`TO-${m[2]}`)} يبلغ أن السائق طلب ${m[3] === "more money" ? "مبلغاً إضافياً" : m[3].replace(" OMR", " ر.ع.")}`,
  ],
];

export function alertMessage(message: string, lang: Lang): string {
  if (lang !== "ar") return message;
  for (const [re, ar] of RULES) {
    const m = message.match(re);
    if (m) return ar(m);
  }
  return message;
}
