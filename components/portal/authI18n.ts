// English / Arabic for sign-in, sign-up and password reset (all five apps share
// these screens). Pages call useT(AUTH); authError() turns Supabase Auth errors
// into this copy.
import type { Dict } from "@/lib/i18n";

export const AUTH: Dict = {
  // Fields
  idLabel: { en: "Mobile number or email", ar: "رقم الهاتف أو البريد الإلكتروني" },
  idHint: { en: "e.g. 9123 4567", ar: "مثال: 9123 4567" },
  mobile: { en: "Mobile number", ar: "رقم الهاتف" },
  mobileHint: { en: "Omani mobile, 8 digits (other countries: start with + and the country code). We’ll send a code by SMS to check it.", ar: "رقم هاتف عماني من ٨ أرقام (للدول الأخرى: ابدأ بـ + ورمز الدولة). سنرسل رمزاً برسالة نصية للتحقق منه." },
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
  badCode: { en: "Enter the 6-digit code from the SMS.", ar: "أدخل الرمز المكوّن من ٦ أرقام من الرسالة." },

  // Password reset
  resetTitle: { en: "Reset your password", ar: "إعادة تعيين كلمة المرور" },
  resetSub: { en: "Enter your mobile number and we’ll send you a code by SMS. Email accounts get a reset link instead.", ar: "أدخل رقم هاتفك وسنرسل لك رمزاً برسالة نصية. حسابات البريد الإلكتروني يصلها رابط بدلاً من ذلك." },
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
  e_otp_expired: { en: "That code is wrong or has expired. Check the SMS or send a new code.", ar: "الرمز غير صحيح أو منتهي الصلاحية. تحقق من الرسالة أو اطلب رمزاً جديداً." },
  e_user_exists: { en: "This mobile number already has an account. Sign in instead, or reset your password.", ar: "لهذا الرقم حساب مسبقاً. سجّل الدخول أو أعد تعيين كلمة المرور." },
  e_rate_limit: { en: "Too many attempts. Wait a minute, then try again.", ar: "محاولات كثيرة. انتظر دقيقة ثم حاول مجدداً." },
  e_weak_password: { en: "Choose a longer password (at least 6 characters).", ar: "اختر كلمة مرور أطول (٦ أحرف على الأقل)." },
  e_sms_failed: { en: "We couldn’t send the SMS. Check the number and try again.", ar: "تعذّر إرسال الرسالة. تحقق من الرقم وحاول مجدداً." },
  e_phone_disabled: { en: "Sign-in by mobile number isn’t switched on for this project yet.", ar: "الدخول برقم الهاتف غير مفعّل في هذا المشروع بعد." },

  // Signed in with another kind of account (/switch)
  switchTitle: { en: "You’re signed in with another account", ar: "أنت مسجّل الدخول بحساب آخر" },
  switchBody: { en: "{name} is signed in as {role}. {app} needs its own account.", ar: "{name} مسجّل الدخول بصفة {role}. يحتاج {app} إلى حسابه الخاص." },
  switchSignOut: { en: "Sign out and sign in to {app}", ar: "تسجيل الخروج والدخول إلى {app}" },
  switchStay: { en: "Go to my app", ar: "الذهاب إلى تطبيقي" },
  role_customer: { en: "a customer", ar: "عميل" },
  role_driver: { en: "a driver", ar: "سائق" },
  role_owner: { en: "a tanker company owner", ar: "مالك شركة صهاريج" },
  role_business: { en: "a business user", ar: "مستخدم أعمال" },
  role_nws_staff: { en: "NWS staff", ar: "موظف في نماء" },
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
