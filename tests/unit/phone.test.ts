// Unit tests for mobile-number handling (lib/phone.ts).  npm run test:unit
import { formatPhone, normalizePhone, parseContact } from "../../lib/phone";
import { PHONE_CASES } from "./phone-cases";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${JSON.stringify(detail)}`}`);
};

console.log("## UNIT phone normalisation");
for (const [input, want] of PHONE_CASES) {
  const got = normalizePhone(input);
  check(`normalizePhone(${JSON.stringify(input)}) → ${want ?? "null"}`, got === want, got);
}
check("normalizePhone(null) → null", normalizePhone(null) === null);

console.log("## UNIT sign-in identifier");
const p = (s: string) => JSON.stringify(parseContact(s));
check("a mobile number signs in by phone", p("9123 4567") === JSON.stringify({ phone: "+96891234567" }), p("9123 4567"));
check("an email signs in by email (lower-cased)", p(" Driver@Nama.TEST ") === JSON.stringify({ email: "driver@nama.test" }), p(" Driver@Nama.TEST "));
check("a malformed email is rejected, not treated as a phone", parseContact("driver@nama") === null);
check("an Omani landline is rejected", parseContact("2456 7700") === null);
check("formatPhone groups Omani numbers", formatPhone("+96891234567") === "+968 9123 4567", formatPhone("+96891234567"));
check("formatPhone leaves other countries as they are", formatPhone("+447700900123") === "+447700900123");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
