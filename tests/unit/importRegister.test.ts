// Unit tests for the register importer (lib/importRegister.ts).  npm run test:unit
// Invented rows only: the real NWS register never enters the repo.
import { chunks, clientOnlyIssues, clusterCode, governorateCode, guessMapping, isoDate, isRegisterLayout, issuesTable, normalizePlate, parseCsv, permitStatus, serviceType, validateCsv } from "../../lib/importRegister";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${JSON.stringify(detail)}`}`);
};

console.log("## UNIT register CSV");
const rows = parseCsv('﻿"a","b, c","d ""q"""\r\n1,2,3\n\n"x\ny",,z');
check("parses quotes, commas, doubled quotes, CRLF/LF, a BOM and quoted newlines; drops blank lines",
  JSON.stringify(rows) === JSON.stringify([["a", "b, c", 'd "q"'], ["1", "2", "3"], ["x\ny", "", "z"]]), rows);
const header = ["Plate No.", "Owner", "Tanker Type", "Governorate", "Cluster", "Contact", "Permit Status", "Permit No.", "Permit Issued", "Permit Expiry"];
check("the NWS register's header needs no mapping", isRegisterLayout(header) && Object.values(guessMapping(header)).every((v, i) => v === i));
const m = guessMapping(["Mobile", "Vehicle Plate", "Type", "Gov", "Status", "Permit Number", "Expiry Date"]);
check("other headers map by alias", m.contact === 0 && m.plate === 1 && m.tanker_type === 2 && m.governorate === 3 && m.permit_status === 4 && m.permit_no === 5 && m.permit_expiry === 6 && m.owner === null, m);

console.log("## UNIT register values");
const plates: [string, string | null][] = [["1798 ml", "1798 ML"], ["12345A", "12345 A"], ["9999/A A", "9999 AA"], ["9999/AA", "9999 AA"], ["  77  k ", "77 K"], ["123456", "123456"], ["999A AA", null], ["/ A A9999", null], ["ABC", null], ["1234567 A", null]];
for (const [i, want] of plates) check(`normalizePlate(${JSON.stringify(i)}) → ${want}`, normalizePlate(i) === want, normalizePlate(i));
check("tanker types → DW / WW / TE", serviceType("Drinking Water") === "DW" && serviceType("sewage water") === "WW" && serviceType("Treated Effluent") === "TE" && serviceType("Milk") === null);
check("permit statuses → valid / in_progress / none", permitStatus("Valid") === "valid" && permitStatus("In Progress") === "in_progress" && permitStatus("No Permit") === "none" && permitStatus("Maybe") === null);
check("governorates in register and zone spellings", governorateCode("Al Dakhiliyah") === "DAK" && governorateCode("Ad Dakhiliyah") === "DAK" && governorateCode("North Al Sharqiyah") === "NSH" && governorateCode("Muscat Governorate") === "MUS" && governorateCode("Nowhere") === null);
check("clusters", clusterCode("Cluster 1") === "C1" && clusterCode("c3") === "C3" && clusterCode("Cluster 7") === null);
check("dates: real YYYY-MM-DD only", isoDate("2026-10-03") === "2026-10-03" && isoDate("2026-2-3") === "2026-02-03" && isoDate("2026-02-30") === null && isoDate("03/10/2026") === null && isoDate("null") === null);

console.log("## UNIT register validation");
const csv = [
  header.map((h) => `"${h}"`).join(","),
  '"7001 QX","Invented Owner A","Drinking Water","Muscat","Cluster 1","91110001","Valid","INV-1","2026-01-01","2026-06-01"',
  '"7002QX","Invented Owner A","Drinking Water","Muscat","Cluster 2","+968 9111 0001","In Progress","","",""',
  '"7002 QX","Invented Owner B","Drinking Water","Muscat","Cluster 1","null","No Permit","","",""',
  '"7003 QX","Invented Owner C","Sewage Water","Al Wusta","Cluster 3","2456 7700","No Permit","","",""',
  '"7004 QX","","Water","Mars","","","","","",""',
].join("\n");
const existing = new Map([["7003 QX", { service_type: "DW" as const, on_platform: true, in_register: false }]]);
const v = validateCsv(csv, { today: "2026-10-30", existing });
const at = (row: number, level: "error" | "warning") => v.issues.filter((x) => x.row === row && x.level === level).map((x) => x.field);
check("expired Valid permit is a warning", at(2, "warning").includes("permit_expiry"), at(2, "warning"));
check("cluster mismatch is a warning", at(3, "warning").includes("cluster"), at(3, "warning"));
check("duplicate plate after normalising is an error", at(4, "error").includes("plate"), at(4, "error"));
check("landline is an invalid mobile (warning) and a type clash with the platform is flagged", at(5, "warning").includes("contact") && at(5, "warning").includes("tanker_type"), at(5, "warning"));
check("unknown type and governorate are errors; missing owner is a warning", at(6, "error").includes("tanker_type") && at(6, "error").includes("governorate") && at(6, "warning").includes("owner"));
check("summary: 5 rows, 3 sent, 1 existing, 2 errors", v.summary.total === 5 && v.summary.send === 3 && v.summary.existing === 1 && v.summary.errors === 2 && v.summary.duplicates === 1, v.summary);
check("phones normalised to E.164", v.rows[0].phone === "+96891110001" && v.rows[1].phone === "+96891110001" && v.rows[2].phone === null);
check("chunks of 500", chunks(Array.from({ length: 1201 }, (_, i) => i)).map((c) => c.length).join(",") === "500,500,201");
check("only error rows go in the browser part of the report", clientOnlyIssues(v.issues).every((x) => x.row === 4 || x.row === 6));
check("issues table has a header row", issuesTable(v.issues)[0][0] === "Row" && issuesTable(v.issues).length === v.issues.length + 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
