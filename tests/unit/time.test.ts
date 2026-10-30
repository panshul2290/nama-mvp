// Unit tests for Oman-time display (lib/time.ts), the customer's order stage
// (components/customer/status.ts) and PO labels (lib/types ref.po).  npm run test:unit
// The process runs in India time on purpose: Muscat time must come out whatever the viewer's zone.
process.env.TZ = "Asia/Kolkata";

import { fillPending, statusKey } from "../../components/customer/status";
import {
  addDaysKey, fmtOman, omanDate, omanDateKey, omanDateTime, omanDay, omanDayEndIso, omanDayStartIso, omanHour, omanTime, omanToday, omanWeekday,
} from "../../lib/time";
import { ref } from "../../lib/types";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${JSON.stringify(detail)}`}`);
};
const eq = (name: string, got: unknown, want: unknown) => check(`${name} → ${JSON.stringify(want)}`, got === want, got);

console.log("## UNIT Oman time (viewer in Asia/Kolkata)");
check("the test really runs outside Muscat time", new Date("2026-10-29T10:00:00Z").getHours() === 15, new Date("2026-10-29T10:00:00Z").getHours());
const T = "2026-10-29T10:05:00Z"; // 14:05 in Muscat, 15:35 in India
eq("omanTime shows Muscat, not the browser's zone", omanTime(T), "14:05");
eq("omanDateTime", omanDateTime(T), "29 Oct, 14:05");
eq("omanDate", omanDate(T), "29 Oct 2026");
eq("omanDay", omanDay(T), "29 Oct");
eq("Arabic locale keeps Muscat time", omanTime(T, "ar-OM-u-nu-latn"), "14:05");
eq("an instant late in the UTC day is already the next Muscat day", omanDate("2026-10-29T21:30:00Z"), "30 Oct 2026");
eq("a plain calendar date is never shifted", omanDate("2026-10-29"), "29 Oct 2026");
eq("fmtOman takes epoch ms and options", fmtOman(Date.parse(T), { weekday: "long" }), "Thursday");
eq("empty input gives an empty string", omanTime(null), "");
eq("invalid input gives an empty string", omanDate("not a date"), "");

console.log("## UNIT Muscat calendar days");
const late = Date.parse("2026-10-29T20:30:00Z"); // 00:30 on 30 Oct in Muscat
eq("omanToday after Muscat midnight", omanToday(late), "2026-10-30");
eq("omanDateKey adds days", omanDateKey(late, 1), "2026-10-31");
eq("omanHour", omanHour(late), 0);
eq("omanWeekday (30 Oct 2026 is a Friday)", omanWeekday(late), 5);
eq("addDaysKey crosses a month", addDaysKey("2026-10-31", 1), "2026-11-01");
eq("omanDayStartIso is 00:00 Muscat", omanDayStartIso("2026-10-30"), "2026-10-29T20:00:00.000Z");
eq("omanDayEndIso is the last ms of the Muscat day", omanDayEndIso("2026-10-30"), "2026-10-30T19:59:59.999Z");

console.log("## UNIT customer order stage");
const o = (status: string, extra: Record<string, unknown> = {}) => ({ status, service_type: "DW", payment_status: "authorized", filled_at: null, ...extra }) as Parameters<typeof statusKey>[0];
check("accepted, not filled → filling pending", fillPending(o("accepted")));
check("arriving (first GPS fix) but not filled → still filling, not on the way", fillPending(o("arriving")) && statusKey(o("arriving")) === "st_accepted", statusKey(o("arriving")));
eq("arriving after the fill → on the way", statusKey(o("arriving", { filled_at: "2026-10-29T10:00:00Z" })), "st_arriving");
check("wastewater has no fill step", !fillPending(o("arriving", { service_type: "WW" })));
eq("arrived is unaffected", statusKey(o("arrived")), "st_arrived");

console.log("## UNIT PO labels");
eq("a bare number gets the prefix", ref.po("4471"), "PO 4471");
eq("PO-… is not doubled", ref.po("PO-E2E-BIZ-1"), "PO-E2E-BIZ-1");
eq("lower case and dotted forms count", ref.po("p.o. 77"), "p.o. 77");
eq("POxxx counts", ref.po("PO123"), "PO123");
eq("a word starting with PO is not a prefix", ref.po("Pool refill"), "PO Pool refill");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
