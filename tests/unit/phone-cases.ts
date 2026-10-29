// Shared phone-normalisation cases: tests/unit/phone.test.ts checks lib/phone.ts,
// and the PHONE database suite checks public.normalize_phone() against the same table.
export const PHONE_CASES: [string, string | null][] = [
  ["91234567", "+96891234567"],
  ["9123 4567", "+96891234567"],
  ["+968 9123 4567", "+96891234567"],
  ["+968-9123-4567", "+96891234567"],
  ["00968 9123 4567", "+96891234567"],
  ["96891234567", "+96891234567"],
  ["(+968) 7712 3456", "+96877123456"],
  ["٩١٢٣٤٥٦٧", "+96891234567"],
  ["+٩٦٨ ٩١٢٣ ٤٥٦٧", "+96891234567"],
  ["۹۱۲۳۴۵۶۷", "+96891234567"],
  ["+91 98765 43210", "+919876543210"],
  ["0044 7700 900123", "+447700900123"],
  ["24567700", null], // Omani landline: no SMS
  ["+968 2456 7700", null],
  ["9123456", null], // 7 digits
  ["912345678", null], // 9 digits
  ["+968 9123 45678", null],
  ["919876543210", null], // foreign number without + / 00
  ["+0123456789", null],
  ["+1234567", null], // too short
  ["+1234567890123456", null], // too long
  ["9123abcd", null],
  ["", null],
  ["   ", null],
];
