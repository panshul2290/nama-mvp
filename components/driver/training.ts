// Driver training (D13): five short lessons, each with text, an illustration
// (components/driver/TrainingArt.tsx) and a three-question quiz. The quiz is graded by
// complete_training_lesson() against training_lessons.answer_key (0030); `answer` here must
// match it (tests/unit/training.test.ts checks), so the app can explain each answer.
type T = { en: string; ar: string };
export type Question = { q: T; options: [T, T, T]; answer: 0 | 1 | 2; why: T };
export type Lesson = { key: LessonKey; title: T; minutes: number; body: T[]; quiz: [Question, Question, Question] };
export type LessonKey = "safety" | "filling" | "discharge" | "pod" | "etiquette";

export const LESSONS: Lesson[] = [
  {
    key: "safety",
    minutes: 3,
    title: { en: "Safety on every shift", ar: "السلامة في كل مناوبة" },
    body: [
      { en: "Do the five-point pre-check before you go online each day: tyres, brakes and lights; valves sealed; hatch locked; protective equipment on; hose sanitised.", ar: "أجرِ فحص السلامة بنقاطه الخمس قبل الاتصال كل يوم: الإطارات والفرامل والأضواء، إحكام الصمامات، قفل الفتحة، ارتداء معدات الحماية، تعقيم الخرطوم." },
      { en: "Heavy vehicles are limited to 100 km/h in Oman. With a full tank, stay well below it: the load moves when you brake. Speeding is flagged to NWS automatically.", ar: "الحد الأقصى لسرعة المركبات الثقيلة في عُمان ١٠٠ كم/س. ومع خزان ممتلئ ابقَ أقل من ذلك بكثير، فالحمولة تتحرك عند الفرملة. وتُبلَّغ نماء بالسرعة الزائدة تلقائياً." },
      { en: "Never use the phone while driving. The app keeps sharing your location on its own; read messages when you are parked.", ar: "لا تستخدم الهاتف أثناء القيادة. يواصل التطبيق مشاركة موقعك تلقائياً؛ اقرأ الرسائل عند التوقف." },
    ],
    quiz: [
      {
        q: { en: "When do you do the safety pre-check?", ar: "متى تجري فحص السلامة؟" },
        options: [
          { en: "Once a week", ar: "مرة في الأسبوع" },
          { en: "Each day, before going online", ar: "كل يوم قبل الاتصال" },
          { en: "Only after a breakdown", ar: "بعد الأعطال فقط" },
        ],
        answer: 1,
        why: { en: "The app asks for it every day before you can go online.", ar: "يطلبه التطبيق كل يوم قبل أن تتمكن من الاتصال." },
      },
      {
        q: { en: "What is the speed limit for a heavy tanker?", ar: "ما الحد الأقصى لسرعة الصهريج الثقيل؟" },
        options: [
          { en: "120 km/h", ar: "١٢٠ كم/س" },
          { en: "No limit on highways", ar: "لا حد على الطرق السريعة" },
          { en: "100 km/h", ar: "١٠٠ كم/س" },
        ],
        answer: 2,
        why: { en: "100 km/h for heavy vehicles — and slower with a full tank.", ar: "١٠٠ كم/س للمركبات الثقيلة — وأبطأ مع خزان ممتلئ." },
      },
      {
        q: { en: "A customer message arrives while you are driving. What do you do?", ar: "وصلت رسالة من العميل أثناء القيادة. ماذا تفعل؟" },
        options: [
          { en: "Read it once you are parked", ar: "أقرؤها بعد التوقف" },
          { en: "Reply at the next traffic light", ar: "أرد عند الإشارة التالية" },
          { en: "Call the customer while driving", ar: "أتصل بالعميل أثناء القيادة" },
        ],
        answer: 0,
        why: { en: "Messages wait; your location keeps updating without you touching the phone.", ar: "الرسائل يمكنها الانتظار، وموقعك يتحدّث دون أن تلمس الهاتف." },
      },
    ],
  },
  {
    key: "filling",
    minutes: 3,
    title: { en: "Filling at an NWS station", ar: "التعبئة في محطة نماء" },
    body: [
      { en: "Fill only at an active NWS filling station for your service. The app confirms the fill only while the tanker is inside the station’s geofence.", ar: "عبّئ فقط من محطة تعبئة نشطة تابعة لنماء لخدمتك. لا يؤكد التطبيق التعبئة إلا والصهريج داخل النطاق الجغرافي للمحطة." },
      { en: "Sanitise the hose end before connecting, keep the hatch closed except while filling, and seal the valves afterwards.", ar: "عقّم طرف الخرطوم قبل التوصيل، وأبقِ الفتحة مغلقة إلا أثناء التعبئة، وأحكم الصمامات بعدها." },
      { en: "If the station is closed, report “Station closed” from the trip screen. Never fill anywhere else.", ar: "إذا كانت المحطة مغلقة، أبلغ عن «المحطة مغلقة» من شاشة الرحلة. لا تعبّئ من أي مكان آخر." },
    ],
    quiz: [
      {
        q: { en: "Where may you fill drinking water?", ar: "من أين يمكنك تعبئة مياه الشرب؟" },
        options: [
          { en: "Any private well near the customer", ar: "أي بئر خاص قرب العميل" },
          { en: "Another company’s depot", ar: "مستودع شركة أخرى" },
          { en: "An active NWS filling station for your service", ar: "محطة تعبئة نشطة تابعة لنماء لخدمتك" },
        ],
        answer: 2,
        why: { en: "Only NWS stations are tested and recorded for each fill.", ar: "محطات نماء وحدها مفحوصة وتُسجَّل كل تعبئة فيها." },
      },
      {
        q: { en: "Why might “Confirm fill” be refused?", ar: "لماذا قد يُرفض «تأكيد التعبئة»؟" },
        options: [
          { en: "The tanker is outside the station’s geofence", ar: "الصهريج خارج النطاق الجغرافي للمحطة" },
          { en: "The customer cancelled", ar: "ألغى العميل الطلب" },
          { en: "The app is in Arabic", ar: "التطبيق باللغة العربية" },
        ],
        answer: 0,
        why: { en: "The fill is checked against your GPS position at the station.", ar: "يُتحقق من التعبئة بموقعك عبر GPS عند المحطة." },
      },
      {
        q: { en: "The station is closed. What do you do?", ar: "المحطة مغلقة. ماذا تفعل؟" },
        options: [
          { en: "Fill from a neighbour’s tank", ar: "أعبّئ من خزان أحد الجيران" },
          { en: "Report “Station closed” on the trip screen", ar: "أبلغ عن «المحطة مغلقة» من شاشة الرحلة" },
          { en: "Deliver without filling", ar: "أوصل الطلب دون تعبئة" },
        ],
        answer: 1,
        why: { en: "NWS control sees the report and can redirect you.", ar: "ترى غرفة تحكم نماء البلاغ ويمكنها توجيهك." },
      },
    ],
  },
  {
    key: "discharge",
    minutes: 3,
    title: { en: "Discharge and geofences", ar: "التفريغ والنطاقات الجغرافية" },
    body: [
      { en: "Wastewater is discharged only at an approved treatment plant. The app checks you are inside the plant’s geofence before it records the discharge.", ar: "تُفرَّغ مياه الصرف في محطة معالجة معتمدة فقط. يتحقق التطبيق من وجودك داخل النطاق الجغرافي للمحطة قبل تسجيل التفريغ." },
      { en: "Discharging anywhere else is a serious violation: NWS sees the GPS track and issues penalties.", ar: "التفريغ في أي مكان آخر مخالفة جسيمة: ترى نماء مسار GPS وتفرض الغرامات." },
      { en: "Keep location sharing on for the whole trip, from collection to the plant — the app keeps it running with the screen off.", ar: "أبقِ مشاركة الموقع مفعّلة طوال الرحلة، من الجمع حتى المحطة — ويواصل التطبيق ذلك والشاشة مطفأة." },
    ],
    quiz: [
      {
        q: { en: "Where can wastewater be discharged?", ar: "أين يمكن تفريغ مياه الصرف؟" },
        options: [
          { en: "Only at an approved treatment plant", ar: "في محطة معالجة معتمدة فقط" },
          { en: "In a wadi outside the city", ar: "في وادٍ خارج المدينة" },
          { en: "Into a storm drain", ar: "في مصرف مياه الأمطار" },
        ],
        answer: 0,
        why: { en: "Anywhere else is illegal dumping.", ar: "أي مكان آخر يُعد تفريغاً غير قانوني." },
      },
      {
        q: { en: "How does the app know you are at the plant?", ar: "كيف يعرف التطبيق أنك في المحطة؟" },
        options: [
          { en: "You type the plant’s name", ar: "تكتب اسم المحطة" },
          { en: "The plant phones NWS", ar: "تتصل المحطة بنماء" },
          { en: "Your GPS position is inside the plant’s geofence", ar: "موقعك عبر GPS داخل النطاق الجغرافي للمحطة" },
        ],
        answer: 2,
        why: { en: "Geofences are drawn around every approved site.", ar: "تُرسم النطاقات الجغرافية حول كل موقع معتمد." },
      },
      {
        q: { en: "When must location sharing be on?", ar: "متى يجب أن تكون مشاركة الموقع مفعّلة؟" },
        options: [
          { en: "Only near the customer", ar: "قرب العميل فقط" },
          { en: "For the whole trip, collection to discharge", ar: "طوال الرحلة، من الجمع حتى التفريغ" },
          { en: "Only at the plant", ar: "في المحطة فقط" },
        ],
        answer: 1,
        why: { en: "The whole track is the evidence that the load reached the plant.", ar: "المسار الكامل هو الدليل على وصول الحمولة إلى المحطة." },
      },
    ],
  },
  {
    key: "pod",
    minutes: 2,
    title: { en: "Proof of delivery", ar: "إثبات التسليم" },
    body: [
      { en: "At the customer, take a photo of the delivery (the tanker and the tank or meter), enter the meter reading and ask the customer to sign on the screen.", ar: "عند العميل، التقط صورة للتسليم (الصهريج والخزان أو العداد)، وأدخل قراءة العداد، واطلب من العميل التوقيع على الشاشة." },
      { en: "The app records where and when the photo was taken. NWS reviews proofs recorded far from the delivery pin.", ar: "يسجل التطبيق مكان التقاط الصورة ووقته. تراجع نماء الإثباتات المسجلة بعيداً عن موقع التسليم." },
      { en: "If the customer isn’t there, deliver, take a clear photo and mark “Left at tank”.", ar: "إذا لم يكن العميل موجوداً، أكمل التسليم والتقط صورة واضحة واختر «تُرك عند الخزان»." },
    ],
    quiz: [
      {
        q: { en: "What does a proof of delivery include?", ar: "ماذا يتضمن إثبات التسليم؟" },
        options: [
          { en: "Only the customer’s name", ar: "اسم العميل فقط" },
          { en: "A photo, the meter reading and the customer’s signature", ar: "صورة وقراءة العداد وتوقيع العميل" },
          { en: "A voice note", ar: "رسالة صوتية" },
        ],
        answer: 1,
        why: { en: "Together they show what was delivered, how much, and that the customer received it.", ar: "معاً تُثبت ما سُلّم وكميته واستلام العميل له." },
      },
      {
        q: { en: "Why does the app record the photo’s location?", ar: "لماذا يسجل التطبيق موقع الصورة؟" },
        options: [
          { en: "To show it was taken at the delivery point", ar: "لإثبات أنها التُقطت عند نقطة التسليم" },
          { en: "To post it online", ar: "لنشرها على الإنترنت" },
          { en: "To choose your next job", ar: "لاختيار مهمتك التالية" },
        ],
        answer: 0,
        why: { en: "The distance from the pin is shown to the customer and NWS.", ar: "تظهر المسافة من الموقع للعميل ولنماء." },
      },
      {
        q: { en: "The customer is not at home. What do you do?", ar: "العميل ليس في المنزل. ماذا تفعل؟" },
        options: [
          { en: "Leave without a proof", ar: "أغادر دون إثبات" },
          { en: "Ask a neighbour to sign as the customer", ar: "أطلب من جار التوقيع بدلاً من العميل" },
          { en: "Deliver, take a clear photo and mark “Left at tank”", ar: "أكمل التسليم وألتقط صورة واضحة وأختار «تُرك عند الخزان»" },
        ],
        answer: 2,
        why: { en: "The photo and its location stand in for the signature.", ar: "تقوم الصورة وموقعها مقام التوقيع." },
      },
    ],
  },
  {
    key: "etiquette",
    minutes: 2,
    title: { en: "Customer etiquette", ar: "آداب التعامل مع العملاء" },
    body: [
      { en: "Greet the customer, introduce yourself and your company, and confirm the order number before you start.", ar: "حيِّ العميل وعرّف بنفسك وبشركتك وتأكد من رقم الطلب قبل البدء." },
      { en: "Use the in-app chat or the masked call. Don’t share personal numbers, and don’t take cash or extra orders outside the app.", ar: "استخدم المحادثة داخل التطبيق أو الاتصال المُقنّع. لا تشارك أرقاماً شخصية، ولا تقبل نقداً أو طلبات إضافية خارج التطبيق." },
      { en: "Respect privacy: stay outside unless invited, keep the area clean, and close valves and gates when you leave.", ar: "احترم الخصوصية: ابقَ في الخارج ما لم تُدعَ، وحافظ على نظافة المكان، وأغلق الصمامات والبوابات عند المغادرة." },
    ],
    quiz: [
      {
        q: { en: "How should you contact the customer?", ar: "كيف تتواصل مع العميل؟" },
        options: [
          { en: "From your personal WhatsApp", ar: "من حسابي الشخصي على واتساب" },
          { en: "By asking for their number at the door", ar: "بطلب رقمه عند الباب" },
          { en: "Through the in-app chat or masked call", ar: "عبر المحادثة داخل التطبيق أو الاتصال المُقنّع" },
        ],
        answer: 2,
        why: { en: "Masked calls and chat protect both of you and are kept with the order.", ar: "يحمي الاتصال المُقنّع والمحادثة كليكما وتُحفظ مع الطلب." },
      },
      {
        q: { en: "The customer offers cash for extra water. What do you do?", ar: "عرض العميل نقداً مقابل مياه إضافية. ماذا تفعل؟" },
        options: [
          { en: "Accept and pour more", ar: "أقبل وأضيف المياه" },
          { en: "Politely decline — extra orders go through the app", ar: "أعتذر بلطف — الطلبات الإضافية عبر التطبيق" },
          { en: "Ask for a tip instead", ar: "أطلب إكرامية بدلاً من ذلك" },
        ],
        answer: 1,
        why: { en: "Every gallon is priced, metered and recorded in the app.", ar: "كل جالون مسعّر ومقيس ومسجل في التطبيق." },
      },
      {
        q: { en: "When you have finished, you should…", ar: "عند الانتهاء، عليك أن…" },
        options: [
          { en: "Close valves and gates and leave the area clean", ar: "أغلق الصمامات والبوابات وأترك المكان نظيفاً" },
          { en: "Leave the hose for next time", ar: "أترك الخرطوم للمرة القادمة" },
          { en: "Leave without telling the customer", ar: "أغادر دون إبلاغ العميل" },
        ],
        answer: 0,
        why: { en: "Leave the property as you found it.", ar: "اترك المكان كما وجدته." },
      },
    ],
  },
];

export const lessonByKey = (k: string | null | undefined) => LESSONS.find((l) => l.key === k) ?? null;
