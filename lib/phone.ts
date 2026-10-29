// Mobile numbers are the main sign-in identity. Everything is stored and sent to
// Supabase Auth in E.164 (+96891234567). public.normalize_phone() in
// 0019_mobile_auth.sql applies the same rules on the server; tests/unit/phone.test.ts
// and the PHONE database suite check that the two agree.

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Arabic-Indic and Persian digits → 0-9. */
export const westernDigits = (s: string) =>
  s.replace(/[٠-٩۰-۹]/g, (c) => String(ARABIC_DIGITS.includes(c) ? ARABIC_DIGITS.indexOf(c) : PERSIAN_DIGITS.indexOf(c)));

/**
 * A mobile number in E.164, or null if it isn't one.
 * - Omani numbers (the default): 8 digits starting with 7 or 9, with or without +968 / 00968 / 968.
 * - Other countries: only with an explicit + or 00 prefix, 8–15 digits.
 * Spaces, dashes, dots and brackets are ignored.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = westernDigits(input.trim()).replace(/[\s().-]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  const intl = s.startsWith("+");
  const d = intl ? s.slice(1) : /^\d{8}$/.test(s) ? `968${s}` : s;
  if (!/^\d+$/.test(d)) return null;
  if (d.startsWith("968")) return /^968[79]\d{7}$/.test(d) ? `+${d}` : null;
  if (!intl) return null; // bare digits must be an Omani number
  return /^[1-9]\d{7,14}$/.test(d) ? `+${d}` : null;
}

export const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());

/** What the user typed into a "Mobile number or email" field. */
export function parseContact(input: string): { email: string } | { phone: string } | null {
  const s = input.trim();
  if (s.includes("@")) return isEmail(s) ? { email: s.toLowerCase() } : null;
  const phone = normalizePhone(s);
  return phone ? { phone } : null;
}

/** +96891234567 → "+968 9123 4567" (other countries: unchanged). */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const m = /^\+968(\d{4})(\d{4})$/.exec(e164);
  return m ? `+968 ${m[1]} ${m[2]}` : e164;
}
