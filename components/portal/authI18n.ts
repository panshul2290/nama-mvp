// English / Arabic for sign-in, sign-up and password reset (all five apps share
// these screens). Pages call useT(AUTH); authError() turns Supabase Auth errors
// into this copy.
import type { Dict } from "@/lib/i18n";

export const AUTH: Dict = {
  // Fields
  idLabel: { en: "Mobile number or email", ar: "رقم الهاتف أو البريد الإلكتروني" },
  idHint: { en: "e.g. 9123 4567", ar: "مثال: 9123 4567" },
  mobile: { en: "Mobile number", ar: "رقم الهاتف" },
  mobileHint: { en: "Omani mobile, 8 digits (other countries: start with + and the country code). We’ll send a code by SMS or WhatsApp to check it.", ar: "رقم هاتف عماني من ٨ أرقام (للدول الأخرى: ابدأ بـ + ورمز الدولة). سنرسل رمزاً برسالة نصية أو عبر واتساب للتحقق منه." },
  emailOpt: { en: "Email (optional)", ar: "البريد الإلكتروني (اختياري)" },
  workEmailOpt: { en: "Work email (optional)", ar: "البريد الإلكتروني للعمل (اختياري)" },
  password: { en: "Password", ar: "كلمة المرور" },
  fullName: { en: "Full name", ar: "الاسم الكامل" },
  yourFullName: { en: "Your full name", ar: "اسمك الكامل" },
  show: { en: "Show", ar: "إظهار" },
  hide: { en: "Hide", ar: "إخفاء" },
  keep: { en: "Keep me signed in", ar: "إبقائي مسجلاً" },
  forgot: { en: "Forgot password?", ar: "نسيت كلمة المرور؟" },
  signIn: { en: "Sign in", ar: "تسجيل الدخول" },
  signingIn: { en: "Signing in…", ar: "جارٍ تسجيل الدخول…" },
  backToSignIn: { en: "Back to sign in", ar: "العودة لتسجيل الدخول" },
  or: { en: "or", ar: "أو" },
  sso: { en: "Continue with NWS single sign-on", ar: "المتابعة بالدخول الموحد لنماء" },
  ssoNote: {
    en: "SSO simulated — NWS single sign-on isn’t connected in this demo. Sign in with your NWS email or mobile number and password.",
    ar: "الدخول الموحد محاكى — غير متصل في هذا العرض. سجّل الدخول ببريدك في نماء أو رقم هاتفك وكلمة المرور.",
  },
  badId: { en: "Enter your mobile number (e.g. 9123 4567) or your email.", ar: "أدخل رقم هاتفك (مثال: 9123 4567) أو بريدك الإلكتروني." },
  badMobile: { en: "Enter an Omani mobile number (8 digits starting with 7 or 9), or a number starting with + and the country code.", ar: "أدخل رقم هاتف عماني (٨ أرقام تبدأ بـ ٧ أو ٩)، أو رقماً يبدأ بـ + ورمز الدولة." },
  badEmail: { en: "That email doesn’t look right. Leave it empty if you don’t have one.", ar: "البريد الإلكتروني غير صحيح. اتركه فارغاً إن لم يكن لديك بريد." },
  resetEmailSent: { en: "If {email} has an account, a reset link is on its way. Open it on this device.", ar: "إذا كان للبريد {email} حساب، فسيصلك رابط لإعادة التعيين. افتحه على هذا الجهاز." },

  // Sign-up
  createAccount: { en: "Create account", ar: "إنشاء حساب" },
  creating: { en: "Creating account…", ar: "جارٍ إنشاء الحساب…" },
  subCustomer: { en: "Order water to your door", ar: "اطلب المياه إلى باب منزلك" },
  subDriver: { en: "You’ll add your tanker next", ar: "ستضيف صهريجك في الخطوة التالية" },
  accountType: { en: "Account type", ar: "نوع الحساب" },
  customer: { en: "Customer", ar: "عميل" },
  driver: { en: "Driver", ar: "سائق" },
  driverBanner: {
    en: "Driving for a tanker company? Sign up here with your mobile number, then give that number to your company owner. They’ll send you an invitation to accept in this app.",
    ar: "تعمل لدى شركة صهاريج؟ سجّل هنا برقم هاتفك ثم أعطِ الرقم لمالك الشركة، وسيرسل لك دعوة تقبلها في هذا التطبيق.",
  },
  ownerTitle: { en: "Register your fleet", ar: "سجّل أسطولك" },
  ownerSub: {
    en: "Create the owner login for your tanker company. Next you’ll add your commercial registration and bank details, then your tankers and drivers.",
    ar: "أنشئ حساب المالك لشركة الصهاريج. بعدها تضيف السجل التجاري والبيانات البنكية، ثم الصهاريج والسائقين.",
  },
  ownerNext: { en: "NWS reviews every new company before its tankers can take jobs.", ar: "تراجع نماء كل شركة جديدة قبل أن تستلم صهاريجها المهام." },
  ownerBtn: { en: "Create owner account", ar: "إنشاء حساب المالك" },
  bizTitle: { en: "Open an account", ar: "افتح حساباً" },
  bizSub: {
    en: "Create your login for the Business portal. Next you’ll add your organisation and sites; NWS sets your credit limit when it activates the account.",
    ar: "أنشئ حسابك في بوابة الأعمال. بعدها تضيف مؤسستك ومواقعك، وتحدد نماء حد الائتمان عند تفعيل الحساب.",
  },
  bizNext: {
    en: "Your colleagues create their own logins, then you invite them from Team by mobile number or email.",
    ar: "ينشئ زملاؤك حساباتهم، ثم تدعوهم من صفحة الفريق برقم الهاتف أو البريد الإلكتروني.",
  },
  bizBtn: { en: "Create business login", ar: "إنشاء حساب الأعمال" },
  already: { en: "Already registered?", ar: "لديك حساب؟" },

  // SMS code
  codeTitle: { en: "Enter the code", ar: "أدخل الرمز" },
  codeSent: { en: "We sent a 6-digit code by SMS to {phone}.", ar: "أرسلنا رمزاً من ٦ أرقام برسالة نصية إلى {phone}." },
  code: { en: "SMS code", ar: "رمز الرسالة" },
  verify: { en: "Verify", ar: "تحقق" },
  verifying: { en: "Checking…", ar: "جارٍ التحقق…" },
  resend: { en: "Send a new code", ar: "إرسال رمز جديد" },
  resendIn: { en: "Send a new code in {s} s", ar: "إرسال رمز جديد بعد {s} ث" },
  resent: { en: "A new code is on its way.", ar: "تم إرسال رمز جديد." },
  changeNumber: { en: "Change number", ar: "تغيير الرقم" },
  demoCode: { en: "Demo: your code is {code}", ar: "عرض تجريبي: رمزك هو {code}" },
  badCode: { en: "Enter the 6-digit code from the message.", ar: "أدخل الرمز المكوّن من ٦ أرقام من الرسالة." },

  // Code channel (SMS or WhatsApp) and code-only sign-in
  channel: { en: "Send the code by", ar: "إرسال الرمز عبر" },
  chSms: { en: "SMS", ar: "رسالة نصية" },
  chWhatsapp: { en: "WhatsApp", ar: "واتساب" },
  codeSentWa: { en: "We sent a 6-digit code by WhatsApp to {phone}.", ar: "أرسلنا رمزاً من ٦ أرقام عبر واتساب إلى {phone}." },
  codeWa: { en: "WhatsApp code", ar: "رمز واتساب" },
  useSms: { en: "Send it by SMS instead", ar: "أرسله برسالة نصية بدلاً من ذلك" },
  useWhatsapp: { en: "Send it by WhatsApp instead", ar: "أرسله عبر واتساب بدلاً من ذلك" },
  withCode: { en: "Sign in with a code", ar: "الدخول برمز" },
  withPassword: { en: "Sign in with a password", ar: "الدخول بكلمة المرور" },
  codeLoginSub: { en: "Enter your mobile number. We’ll send you a code by SMS or WhatsApp; no password needed.", ar: "أدخل رقم هاتفك وسنرسل لك رمزاً برسالة نصية أو عبر واتساب، دون الحاجة إلى كلمة مرور." },
  codeNeedsMobile: { en: "Codes go to mobile numbers only. Enter your mobile number, or sign in with your email and password.", ar: "تُرسل الرموز إلى أرقام الهواتف فقط. أدخل رقم هاتفك، أو سجّل الدخول ببريدك وكلمة المرور." },

  // Password reset
  resetTitle: { en: "Reset your password", ar: "إعادة تعيين كلمة المرور" },
  resetSub: { en: "Enter your mobile number and we’ll send you a code by SMS or WhatsApp. Email accounts get a reset link instead.", ar: "أدخل رقم هاتفك وسنرسل لك رمزاً برسالة نصية أو عبر واتساب. حسابات البريد الإلكتروني يصلها رابط بدلاً من ذلك." },
  sendCode: { en: "Send code", ar: "إرسال الرمز" },
  sending: { en: "Sending…", ar: "جارٍ الإرسال…" },
  newPwTitle: { en: "Choose a new password", ar: "اختر كلمة مرور جديدة" },
  newPwSub: { en: "Use at least 6 characters. You’ll stay signed in on this device.", ar: "استخدم ٦ أحرف على الأقل. ستبقى مسجلاً على هذا الجهاز." },
  newPw: { en: "New password", ar: "كلمة المرور الجديدة" },
  newPw2: { en: "Repeat new password", ar: "أعد كتابة كلمة المرور" },
  savePw: { en: "Save password", ar: "حفظ كلمة المرور" },
  saving: { en: "Saving…", ar: "جارٍ الحفظ…" },
  pwMismatch: { en: "The two passwords don’t match.", ar: "كلمتا المرور غير متطابقتين." },
  linkExpired: { en: "This reset link has expired. Request a new one from the sign-in screen.", ar: "انتهت صلاحية الرابط. اطلب رابطاً جديداً من شاشة الدخول." },

  // Supabase Auth errors
  e_invalid_credentials: { en: "Wrong mobile number, email or password.", ar: "رقم الهاتف أو البريد أو كلمة المرور غير صحيحة." },
  e_phone_not_confirmed: { en: "This mobile number isn’t verified yet. Choose “Forgot password?” to get a code by SMS.", ar: "لم يتم التحقق من رقم الهاتف بعد. اختر «نسيت كلمة المرور؟» لتصلك رسالة برمز." },
  e_email_not_confirmed: { en: "Confirm your email first: open the link we sent you.", ar: "أكّد بريدك الإلكتروني أولاً بفتح الرابط الذي أرسلناه." },
  e_otp_expired: { en: "That code is wrong or has expired. Check the message or send a new code.", ar: "الرمز غير صحيح أو منتهي الصلاحية. تحقق من الرسالة أو اطلب رمزاً جديداً." },
  e_user_exists: { en: "This mobile number already has an account. Sign in instead, or reset your password.", ar: "لهذا الرقم حساب مسبقاً. سجّل الدخول أو أعد تعيين كلمة المرور." },
  e_rate_limit: { en: "Too many attempts. Wait a minute, then try again.", ar: "محاولات كثيرة. انتظر دقيقة ثم حاول مجدداً." },
  e_weak_password: { en: "Choose a longer password (at least 6 characters).", ar: "اختر كلمة مرور أطول (٦ أحرف على الأقل)." },
  e_sms_failed: { en: "We couldn’t send the SMS. Check the number and try again.", ar: "تعذّر إرسال الرسالة. تحقق من الرقم وحاول مجدداً." },
  e_phone_disabled: { en: "Sign-in by mobile number isn’t switched on for this project yet.", ar: "الدخول برقم الهاتف غير مفعّل في هذا المشروع بعد." },

  // An account of another kind on this app's sign-in (each app accepts only its own accounts)
  sessionEnded: { en: "Your session ended — please sign in again.", ar: "انتهت جلستك — يرجى تسجيل الدخول مجدداً." },
  wrong_customer: { en: "This is a customer account.", ar: "هذا حساب عميل." },
  wrong_driver: { en: "This is a driver account.", ar: "هذا حساب سائق." },
  wrong_owner: { en: "This is a tanker company account.", ar: "هذا حساب شركة صهاريج." },
  wrong_business: { en: "This is a business account.", ar: "هذا حساب أعمال." },
  wrong_nws_staff: { en: "This is an NWS staff account.", ar: "هذا حساب موظف في نماء." },
  useApp: { en: "Use the {app} to sign in.", ar: "استخدم {app} لتسجيل الدخول." },
  openApp: { en: "Go to the {app} sign-in", ar: "الانتقال إلى تسجيل الدخول في {app}" },
  e_no_profile: { en: "This account isn’t set up yet. Contact NWS support.", ar: "هذا الحساب غير مُعَدّ بعد. تواصل مع دعم نماء." },
  app_nws: { en: "NWS staff portal", ar: "بوابة موظفي نماء" },
  app_customer: { en: "Customer app", ar: "تطبيق العملاء" },
  app_business: { en: "Business portal", ar: "بوابة الأعمال" },
  app_driver: { en: "Driver app", ar: "تطبيق السائقين" },
  app_company: { en: "Company portal", ar: "بوابة الشركات" },

  // Desktop sign-in frame (components/portal/AuthChrome AuthFrame) and the web sign-in headings
  title_nws: { en: "Sign in", ar: "تسجيل الدخول" },
  title_business: { en: "Sign in to your business account", ar: "تسجيل الدخول إلى حساب أعمالك" },
  title_company: { en: "Sign in to your company", ar: "تسجيل الدخول إلى شركتك" },
  sub_nws: { en: "For Nama staff — control room, permits, customer care and finance.", ar: "لموظفي نماء — غرفة التحكم والتصاريح وخدمة العملاء والمالية." },
  sub_business: { en: "Hotels, compounds, farms and government sites ordering on account.", ar: "الفنادق والمجمعات السكنية والمزارع والمواقع الحكومية التي تطلب على الحساب." },
  sub_company: { en: "Tanker owners — fleet, drivers, permits, contracts and earnings.", ar: "مالكو الصهاريج — الأسطول والسائقون والتصاريح والعقود والأرباح." },
  signupQ_business: { en: "New business customer?", ar: "عميل أعمال جديد؟" },
  signupA_business: { en: "Open an account", ar: "افتح حساباً" },
  signupQ_company: { en: "New tanker company?", ar: "شركة صهاريج جديدة؟" },
  signupA_company: { en: "Register your fleet", ar: "سجّل أسطولك" },
  heroEyebrow: { en: "Permits, dispatch and tracking", ar: "التصاريح والإسناد والتتبع" },
  heroTitle: { en: "Every tanker permitted.", ar: "كل صهريج مرخّص." },
  heroTitle2: { en: "Every delivery verified.", ar: "كل توصيلة موثّقة." },
  heroLead: {
    en: "One platform for drinking-water, wastewater and treated-effluent tankers across Oman — from the customer’s request to discharge at an approved plant.",
    ar: "منصة واحدة لصهاريج مياه الشرب ومياه الصرف والمياه المعالجة في جميع أنحاء عُمان — من طلب العميل حتى التفريغ في محطة معتمدة.",
  },
  step1: { en: "Request", ar: "الطلب" },
  step1s: { en: "Customers order in the app, the web portal or through the call centre", ar: "يطلب العملاء عبر التطبيق أو البوابة الإلكترونية أو مركز الاتصال" },
  step2: { en: "Dispatch", ar: "الإسناد" },
  step2s: { en: "The nearest permitted tanker gets the job, with earnings shown upfront", ar: "يُسند الطلب إلى أقرب صهريج مرخّص مع عرض الأرباح مسبقاً" },
  step3: { en: "Verify", ar: "التحقق" },
  step3s: { en: "GPS geofences, flow meters and proof of delivery close every trip", ar: "النطاقات الجغرافية وعدادات التدفق وإثبات التسليم تُغلق كل رحلة" },
  allApps: { en: "All apps", ar: "جميع التطبيقات" },
  tankerOps: { en: "Tanker Operations", ar: "عمليات الصهاريج" },
  devBy: { en: "Developed by", ar: "تطوير" },
  copy: { en: "© 2026 Nama Water Services. All data in this system belongs to NWS.", ar: "© 2026 شركة نماء لخدمات المياه. جميع البيانات في هذا النظام مملوكة لنماء." },
};

const CODES: Record<string, string> = {
  invalid_credentials: "e_invalid_credentials",
  phone_not_confirmed: "e_phone_not_confirmed",
  email_not_confirmed: "e_email_not_confirmed",
  otp_expired: "e_otp_expired",
  user_already_exists: "e_user_exists",
  phone_exists: "e_user_exists",
  over_sms_send_rate_limit: "e_rate_limit",
  over_request_rate_limit: "e_rate_limit",
  weak_password: "e_weak_password",
  sms_send_failed: "e_sms_failed",
  phone_provider_disabled: "e_phone_disabled",
};

/** Supabase Auth error → our copy (by error code, then by the older message texts). */
export function authError(t: (k: string) => string, error: { message?: string; code?: string } | null | undefined): string {
  if (!error) return "";
  const key = (error.code && CODES[error.code]) || matchMessage(error.message ?? "");
  return key ? t(key) : (error.message ?? "Something went wrong.");
}

function matchMessage(m: string): string | null {
  const s = m.toLowerCase();
  if (s.includes("invalid login credentials")) return "e_invalid_credentials";
  if (s.includes("phone not confirmed")) return "e_phone_not_confirmed";
  if (s.includes("email not confirmed")) return "e_email_not_confirmed";
  if (s.includes("token has expired") || s.includes("invalid otp")) return "e_otp_expired";
  if (s.includes("already registered") || s.includes("already exists")) return "e_user_exists";
  if (s.includes("rate limit") || s.includes("security purposes")) return "e_rate_limit";
  if (s.includes("unsupported phone provider") || s.includes("phone signups are disabled")) return "e_phone_disabled";
  return null;
}
