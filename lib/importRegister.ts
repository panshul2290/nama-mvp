// NWS tanker register import: parse, map, validate and normalise rows before they go to
// staff_import_register (0032). Used by NWS → Permits → Register → Import register and by
// scripts/import-register.mjs, so both apply the same rules; the database checks every row
// again (normalize_plate, governorate_code, cluster_code, register_* helpers in 0031/0032)
// and the PGlite suite REGIMP compares the two.
//
// The register is a CSV with these headers (NWS export):
//   "Plate No.","Owner","Tanker Type","Governorate","Cluster","Contact","Permit Status",
//   "Permit No.","Permit Issued","Permit Expiry"
// XLSX isn't supported: no spreadsheet parser is installed. Save the sheet as CSV (UTF-8).
//
// Pure functions only (no browser or Node APIs), so the same module runs in both. All
// user-facing text lives in the T table below for later translation.

import { normalizePhone, westernDigits } from "./phone";

export const T = {
  fields: {
    plate: "Plate No.",
    owner: "Owner",
    tanker_type: "Tanker Type",
    governorate: "Governorate",
    cluster: "Cluster",
    contact: "Contact",
    permit_status: "Permit Status",
    permit_no: "Permit No.",
    permit_issued: "Permit Issued",
    permit_expiry: "Permit Expiry",
  },
  plate: "Not a plate number (digits, then up to two letters)",
  plateNoLetters: "Plate has no letter code",
  plateMissing: "Plate number missing",
  typeUnknown: (v: string) => `Unknown tanker type: ${v || "(empty)"}`,
  govUnknown: (v: string) => `Unknown governorate: ${v || "(empty)"}`,
  clusterDiffers: (v: string, gov: string) => `Cluster "${v}" differs from the governorate's cluster (${gov}); the governorate's is used`,
  statusUnknown: (v: string) => `Unknown permit status: ${v}`,
  phoneInvalid: "Not a valid mobile number; treated as missing",
  phoneShared: (row: number) => `Same mobile number as row ${row} with a different owner name; the first name is kept`,
  ownerMissing: "No owner name",
  duplicate: (row: number) => `Plate appears twice in this file (first at row ${row}); this row is skipped`,
  dateInvalid: (v: string) => `Not a date (YYYY-MM-DD): ${v}`,
  validIncomplete: "Valid permit without a permit number and valid issue/expiry dates; no permit record created",
  expired: (d: string) => `Permit already expired on ${d}`,
  noPermitWithDetails: "Permit number or dates given but the status is No Permit; no permit record created (number kept on the tanker)",
  typeDiffers: (file: string, platform: string) => `Register says ${file}, the tanker on the platform is ${platform}; the platform's type is kept`,
  tooFewColumns: "Row has fewer columns than the header",
  missingColumn: (label: string) => `Column "${label}" is required`,
};

export type FieldKey = keyof typeof T.fields;
export const FIELDS = Object.keys(T.fields) as FieldKey[];
export const REQUIRED: FieldKey[] = ["plate", "tanker_type", "governorate"];

/** Header spellings recognised for each field (lower-case, punctuation removed). */
const HEADER_ALIASES: Record<FieldKey, string[]> = {
  plate: ["plate no", "plate", "plate number", "vehicle plate", "plate no."],
  owner: ["owner", "owner name", "name"],
  tanker_type: ["tanker type", "type", "service", "service type"],
  governorate: ["governorate", "gov"],
  cluster: ["cluster"],
  contact: ["contact", "phone", "mobile", "contact no", "mobile number", "phone number"],
  permit_status: ["permit status", "status"],
  permit_no: ["permit no", "permit number", "permit"],
  permit_issued: ["permit issued", "issued", "issue date", "permit issue date"],
  permit_expiry: ["permit expiry", "expiry", "expiry date", "permit expiry date", "expires"],
};

const headerKey = (h: string) => h.replace(/^﻿/, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC 4180 CSV (quotes, doubled quotes, CRLF or LF, a UTF-8 BOM). Blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(f);
      f = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(f);
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
      f = "";
    } else f += c;
  }
  row.push(f);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

export type Mapping = Record<FieldKey, number | null>;

/** Column index per field from the header row (null when no header matches). */
export function guessMapping(headers: string[]): Mapping {
  const keys = headers.map(headerKey);
  const used = new Set<number>();
  const m = {} as Mapping;
  // Exact register headers first, then aliases, so "Permit No." doesn't grab "Permit Status".
  for (const f of FIELDS) {
    const exact = keys.findIndex((k, i) => !used.has(i) && k === headerKey(T.fields[f]));
    const i = exact >= 0 ? exact : keys.findIndex((k, j) => !used.has(j) && HEADER_ALIASES[f].map(headerKey).includes(k));
    m[f] = i >= 0 ? i : null;
    if (i >= 0) used.add(i);
  }
  return m;
}

/** True when every required field is mapped (otherwise the mapping step must be shown). */
export const mappingComplete = (m: Mapping) => REQUIRED.every((f) => m[f] != null);
/** True when the file has exactly the register's headers (no mapping step needed). */
export const isRegisterLayout = (headers: string[]) => FIELDS.every((f, i) => headerKey(headers[i] ?? "") === headerKey(T.fields[f]));

// ---------------------------------------------------------------------------
// Values (the same rules as the SQL helpers)
// ---------------------------------------------------------------------------

/** "1798 ml", "1798ML", "9999/A A" → "1798 ML"/"9999 AA"; "12345" stays; null if not a plate. Mirrors normalize_plate(). */
export function normalizePlate(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = westernDigits(input.trim()).toUpperCase().replace(/[/\\._-]+/g, " ").replace(/\s+/g, " ").trim();
  const m = /^([0-9]{1,6}) ?([A-Z]) ?([A-Z])?$/.exec(s);
  if (m) return `${m[1]} ${m[2]}${m[3] ?? ""}`;
  if (/^[0-9]{1,7}$/.test(s)) return s;
  return null;
}

export type ServiceType = "DW" | "WW" | "TE";
const SERVICE: Record<string, ServiceType> = {
  "drinking water": "DW", dw: "DW", "potable water": "DW",
  "sewage water": "WW", sewage: "WW", ww: "WW", wastewater: "WW", "waste water": "WW",
  "treated effluent": "TE", te: "TE", tse: "TE",
};
/** Drinking Water → DW, Sewage Water → WW, Treated Effluent → TE. Mirrors register_service_type(). */
export const serviceType = (v: string | null | undefined): ServiceType | null => SERVICE[(v ?? "").trim().toLowerCase().replace(/\s+/g, " ")] ?? null;

export type PermitStatus = "none" | "in_progress" | "valid";
const STATUS: Record<string, PermitStatus> = { valid: "valid", approved: "valid", "in progress": "in_progress", pending: "in_progress", "no permit": "none", none: "none", "": "none" };
/** Mirrors register_permit_status(). */
export const permitStatus = (v: string | null | undefined): PermitStatus | null => STATUS[(v ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ")] ?? null;

/** Governorates and their clusters as seeded in 0031 (the database is the source of truth). */
export const GOVERNORATES: { code: string; name: string; cluster: string | null; aliases: string[] }[] = [
  { code: "MUS", name: "Muscat", cluster: "C1", aliases: ["muscat", "muscat governorate"] },
  { code: "NSH", name: "North Al Sharqiyah", cluster: "C1", aliases: ["north al sharqiyah", "north ash sharqiyah", "north sharqiyah", "shamal al sharqiyah"] },
  { code: "SSH", name: "South Al Sharqiyah", cluster: "C1", aliases: ["south al sharqiyah", "south ash sharqiyah", "south sharqiyah", "janub al sharqiyah"] },
  { code: "DHA", name: "Al Dhahirah", cluster: "C2", aliases: ["al dhahirah", "adh dhahirah", "al dhahira", "dhahirah", "ad dhahirah"] },
  { code: "NBA", name: "North Al Batinah", cluster: "C2", aliases: ["north al batinah", "north batinah", "shamal al batinah"] },
  { code: "SBA", name: "South Al Batinah", cluster: "C3", aliases: ["south al batinah", "south batinah", "janub al batinah"] },
  { code: "DAK", name: "Al Dakhiliyah", cluster: "C3", aliases: ["al dakhiliyah", "ad dakhiliyah", "dakhiliyah", "ad dakhiliya", "al dakhiliya"] },
  { code: "WUS", name: "Al Wusta", cluster: "C3", aliases: ["al wusta", "wusta"] },
  { code: "BUR", name: "Al Buraimi", cluster: null, aliases: ["al buraimi", "buraimi"] },
  { code: "MSN", name: "Musandam", cluster: null, aliases: ["musandam"] },
  { code: "DHO", name: "Dhofar", cluster: null, aliases: ["dhofar"] },
];
export type GovRef = { code: string; name: string; cluster: string | null; aliases: string[] };

/** Governorate code for a name in any known spelling, or null. Mirrors governorate_code(). */
export function governorateCode(v: string | null | undefined, govs: GovRef[] = GOVERNORATES): string | null {
  const s = (v ?? "").toLowerCase().replace(/[^a-z؀-ۿ ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const bare = s.replace(/ governorate$/, "");
  return govs.find((g) => g.code.toLowerCase() === s || g.name.toLowerCase() === s || g.aliases.includes(s) || g.aliases.includes(bare) || g.name.toLowerCase() === bare)?.code ?? null;
}

/** "Cluster 1", "cluster1", "C1", "1" → "C1" (1–3 only, as in the clusters table). Mirrors cluster_code(). */
export function clusterCode(v: string | null | undefined, known: string[] = ["C1", "C2", "C3"]): string | null {
  const m = /^(?:cluster\s*|c\s*)?0*([0-9]{1,2})$/.exec((v ?? "").trim().toLowerCase());
  const code = m && m[1] ? `C${m[1]}` : null;
  return code && known.includes(code) ? code : null;
}

/** YYYY-MM-DD (a real calendar date), or null. "null" and "" are null too. */
export function isoDate(v: string | null | undefined): string | null {
  const s = westernDigits((v ?? "").trim());
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const blank = (v: string | null | undefined) => {
  const s = (v ?? "").trim();
  return s === "" || s.toLowerCase() === "null";
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type Issue = { row: number; plate: string; level: "error" | "warning"; field: string; message: string };

/** What staff_import_register receives for one row. */
export type ImportRow = {
  row: number; plate: string; owner: string; service_type: ServiceType; governorate: string; cluster: string;
  phone: string | null; permit_status: PermitStatus; permit_no: string; issued: string; expires: string;
};

export type Existing = Map<string, { service_type: ServiceType; on_platform: boolean; in_register: boolean }>;

export type Summary = {
  total: number; ok: number; warnings: number; errors: number; send: number;
  duplicates: number; existing: number; existing_on_platform: number; new_tankers: number;
  status: Record<PermitStatus, number>; with_phone: number; no_phone: number; invalid_phone: number; owners_by_phone: number;
  by_governorate: Record<string, number>; by_service: Record<ServiceType, number>;
  /** (governorate, cluster) pairs as written in the file, with counts — shows whether the mapping is consistent. */
  pairs: Record<string, number>;
  inconsistent_governorates: string[];
};

export type Validated = { rows: ImportRow[]; issues: Issue[]; summary: Summary };

/**
 * Validate data rows (without the header). `firstRow` is the file line of rows[0] (2 when the
 * header is line 1). `existing` (plate → tanker) marks updates and type clashes; `today` (YYYY-MM-DD,
 * Muscat) flags already-expired permits. Rows with errors are not sent; warnings are.
 */
export function validateRows(
  data: string[][],
  mapping: Mapping,
  opts: { firstRow?: number; existing?: Existing; today?: string; govs?: GovRef[]; clusters?: string[] } = {},
): Validated {
  const govs = opts.govs ?? GOVERNORATES;
  const first = opts.firstRow ?? 2;
  const issues: Issue[] = [];
  const rows: ImportRow[] = [];
  const seenPlate = new Map<string, number>();
  const phoneOwner = new Map<string, { row: number; name: string }>();
  const pairs: Record<string, number> = {};
  const govClusters = new Map<string, Set<string>>();
  const sum: Summary = {
    total: data.length, ok: 0, warnings: 0, errors: 0, send: 0, duplicates: 0, existing: 0, existing_on_platform: 0, new_tankers: 0,
    status: { none: 0, in_progress: 0, valid: 0 }, with_phone: 0, no_phone: 0, invalid_phone: 0, owners_by_phone: 0,
    by_governorate: {}, by_service: { DW: 0, WW: 0, TE: 0 }, pairs, inconsistent_governorates: [],
  };
  const get = (r: string[], f: FieldKey) => (mapping[f] == null ? "" : (r[mapping[f]!] ?? "").trim());

  data.forEach((r, i) => {
    const row = first + i;
    const rawPlate = get(r, "plate");
    const plate = normalizePlate(rawPlate);
    const mine: Issue[] = [];
    const err = (field: string, message: string) => mine.push({ row, plate: plate ?? rawPlate, level: "error", field, message });
    const warn = (field: string, message: string) => mine.push({ row, plate: plate ?? rawPlate, level: "warning", field, message });

    if (!rawPlate) err("plate", T.plateMissing);
    else if (!plate || plate.length < 2) err("plate", T.plate); // tankers.plate is 2–20 characters
    else if (/^\d+$/.test(plate)) warn("plate", T.plateNoLetters);

    const rawType = get(r, "tanker_type");
    const svc = serviceType(rawType);
    if (!svc) err("tanker_type", T.typeUnknown(rawType));

    const rawGov = get(r, "governorate");
    const gov = governorateCode(rawGov, govs);
    if (!gov) err("governorate", T.govUnknown(rawGov));

    const rawCluster = get(r, "cluster");
    if (rawGov || rawCluster) pairs[`${rawGov} | ${rawCluster}`] = (pairs[`${rawGov} | ${rawCluster}`] ?? 0) + 1;
    if (gov && rawCluster) {
      const set = govClusters.get(gov) ?? new Set<string>();
      set.add(clusterCode(rawCluster, opts.clusters) ?? rawCluster);
      govClusters.set(gov, set);
      const want = govs.find((g) => g.code === gov)?.cluster ?? null;
      const have = clusterCode(rawCluster, opts.clusters);
      if (have !== want) warn("cluster", T.clusterDiffers(rawCluster, want ?? "none"));
    }

    const rawStatus = get(r, "permit_status");
    const status = permitStatus(rawStatus);
    if (!status) err("permit_status", T.statusUnknown(rawStatus));

    const rawPhone = get(r, "contact");
    const phone = blank(rawPhone) ? null : normalizePhone(rawPhone);
    if (!blank(rawPhone) && !phone) warn("contact", T.phoneInvalid);

    const owner = get(r, "owner").replace(/\s+/g, " ").slice(0, 120);
    if (blank(owner)) warn("owner", T.ownerMissing);
    else if (phone) {
      const prev = phoneOwner.get(phone);
      if (prev && prev.name.toLowerCase() !== owner.toLowerCase()) warn("contact", T.phoneShared(prev.row));
    }

    const permitNo = blank(get(r, "permit_no")) ? "" : get(r, "permit_no").toUpperCase();
    const rawIss = get(r, "permit_issued");
    const rawExp = get(r, "permit_expiry");
    const iss = isoDate(rawIss);
    const exp = isoDate(rawExp);
    if (!blank(rawIss) && !iss) warn("permit_issued", T.dateInvalid(rawIss));
    if (!blank(rawExp) && !exp) warn("permit_expiry", T.dateInvalid(rawExp));
    if (status === "valid") {
      if (!permitNo || !iss || !exp || exp <= iss) warn("permit", T.validIncomplete);
      else if (opts.today && exp < opts.today) warn("permit_expiry", T.expired(exp));
    } else if (status === "none" && (permitNo || iss || exp)) warn("permit_status", T.noPermitWithDetails);

    if (plate) {
      const firstAt = seenPlate.get(plate);
      if (firstAt != null) {
        err("plate", T.duplicate(firstAt));
        sum.duplicates++;
      }
    }

    const hasErr = mine.some((x) => x.level === "error");
    if (!hasErr && plate && svc && gov && status) {
      seenPlate.set(plate, row);
      const ex = opts.existing?.get(plate);
      if (ex) {
        sum.existing++;
        if (ex.on_platform) {
          sum.existing_on_platform++;
          if (ex.service_type !== svc) warn("tanker_type", T.typeDiffers(svc, ex.service_type));
        }
      } else sum.new_tankers++;
      if (phone && !blank(owner) && !phoneOwner.has(phone)) phoneOwner.set(phone, { row, name: owner });
      rows.push({
        row, plate, owner: blank(owner) ? "" : owner, service_type: svc, governorate: gov, cluster: rawCluster, phone,
        permit_status: status, permit_no: permitNo, issued: iss ?? "", expires: exp ?? "",
      });
      sum.status[status]++;
      sum.by_service[svc]++;
      sum.by_governorate[gov] = (sum.by_governorate[gov] ?? 0) + 1;
      if (phone) sum.with_phone++;
      else sum.no_phone++;
      if (!blank(rawPhone) && !phone) sum.invalid_phone++;
    }
    if (hasErr) sum.errors++;
    else if (mine.length) sum.warnings++;
    else sum.ok++;
    issues.push(...mine);
  });
  sum.send = rows.length;
  sum.owners_by_phone = phoneOwner.size;
  sum.inconsistent_governorates = [...govClusters].filter(([, s]) => s.size > 1).map(([g]) => g);
  return { rows, issues, summary: sum };
}

/** Parse a whole register file: header row, mapping (guessed unless given) and validation. */
export function validateCsv(text: string, opts: Parameters<typeof validateRows>[2] & { mapping?: Mapping } = {}) {
  const all = parseCsv(text);
  const headers = all[0] ?? [];
  const mapping = opts.mapping ?? guessMapping(headers);
  const missing = REQUIRED.filter((f) => mapping[f] == null).map((f) => T.missingColumn(T.fields[f]));
  return { headers, mapping, missing, ...validateRows(all.slice(1), mapping, { ...opts, firstRow: 2 }) };
}

/** Split into chunks of `size` (500 per staff_import_register call). */
export function chunks<T>(xs: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Issues rows that never reach the database (errors), for staff_import_batch_finish. */
export const clientOnlyIssues = (issues: Issue[]) => {
  const errRows = new Set(issues.filter((x) => x.level === "error").map((x) => x.row));
  return issues.filter((x) => errRows.has(x.row));
};

/** Error report as CSV rows (first row = headers). */
export function issuesTable(issues: Issue[]): (string | number)[][] {
  return [["Row", "Plate", "Level", "Field", "Message"], ...[...issues].sort((a, b) => a.row - b.row).map((x) => [x.row, x.plate, x.level, x.field, x.message])];
}

/** Server counts added up across chunks. */
export function addCounts(a: Record<string, number>, b: Record<string, number> | null | undefined) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = (out[k] ?? 0) + (Number(v) || 0);
  return out;
}
