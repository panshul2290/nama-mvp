// Spreadsheet-safe CSV (P4). Text that a spreadsheet would read as a formula
// (=, +, -, @, tab or CR first, after any leading whitespace) gets a leading
// single quote so it stays literal; numbers stay numbers.

export type CsvCell = string | number | null | undefined;

export function csvCell(v: CsvCell) {
  if (v == null) return "";
  let s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v);
  // A plain number written as text ("-12.500", "1,284") is data, not a formula.
  if (typeof v !== "number" && /^\s*[=+\-@\t\r]/.test(s) && !/^\s*[-+]?\d[\d,]*(\.\d+)?\s*$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows to CSV text with a UTF-8 BOM (so Excel reads Arabic correctly). */
export function toCsv(rows: CsvCell[][], eol = "\r\n") {
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join(eol);
}

/** Save rows as a .csv download in the browser. */
export function saveCsv(filename: string, rows: CsvCell[][]) {
  const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type TableFormat = "csv" | "xls" | "xml" | "txt" | "html" | "ascii";
export const TABLE_FORMATS: TableFormat[] = ["csv", "xls", "xml", "txt", "html", "ascii"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const text = (v: CsvCell) => (v == null ? "" : typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v));

/**
 * First row = headers. XLS is SpreadsheetML 2003 (opens in Excel); XML is one <row> per line; TXT is
 * tab-separated; HTML is a plain table page; ASCII is a fixed-width text table (non-ASCII characters
 * such as Arabic become "?", as the format requires).
 */
export function toTable(rows: CsvCell[][], fmt: TableFormat): { body: string; type: string; ext: string } {
  if (fmt === "csv") return { body: toCsv(rows), type: "text/csv;charset=utf-8", ext: "csv" };
  if (fmt === "html") {
    const [h = [], ...b] = rows;
    const tr = (r: CsvCell[], tag: string) => `<tr>${r.map((c) => `<${tag}>${esc(text(c))}</${tag}>`).join("")}</tr>`;
    return {
      body: `<!doctype html><html><head><meta charset="utf-8"><title>Export</title></head><body><table border="1" cellspacing="0" cellpadding="4"><thead>${tr(h, "th")}</thead><tbody>${b.map((r) => tr(r, "td")).join("")}</tbody></table></body></html>`,
      type: "text/html;charset=utf-8",
      ext: "html",
    };
  }
  if (fmt === "ascii") {
    const cells = rows.map((r) => r.map((c) => text(c).replace(/[\t\r\n]+/g, " ").replace(/[^\x20-\x7e]/g, "?")));
    const cols = Math.max(0, ...cells.map((r) => r.length));
    const w = Array.from({ length: cols }, (_, i) => Math.max(0, ...cells.map((r) => (r[i] ?? "").length)));
    const line = "+" + w.map((n) => "-".repeat(n + 2)).join("+") + "+";
    const row = (r: string[]) => "| " + w.map((n, i) => (r[i] ?? "").padEnd(n)).join(" | ") + " |";
    const [h = [], ...b] = cells;
    return { body: [line, row(h), line, ...b.map(row), line].join("\r\n") + "\r\n", type: "text/plain;charset=us-ascii", ext: "ascii.txt" };
  }
  if (fmt === "txt") return { body: "﻿" + rows.map((r) => r.map((c) => text(c).replace(/[\t\r\n]+/g, " ")).join("\t")).join("\r\n"), type: "text/plain;charset=utf-8", ext: "txt" };
  const [head = [], ...body] = rows;
  if (fmt === "xml") {
    const tag = (h: CsvCell, i: number) => text(h).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "c$1") || `c${i}`;
    const names = head.map(tag);
    const xml = body.map((r) => `  <row>${r.map((c, i) => `<${names[i] ?? `c${i}`}>${esc(text(c))}</${names[i] ?? `c${i}`}>`).join("")}</row>`).join("\n");
    return { body: `<?xml version="1.0" encoding="UTF-8"?>\n<rows>\n${xml}\n</rows>\n`, type: "application/xml", ext: "xml" };
  }
  const cell = (c: CsvCell) => `<Cell><Data ss:Type="${typeof c === "number" && Number.isFinite(c) ? "Number" : "String"}">${esc(text(c))}</Data></Cell>`;
  const sheet = rows.map((r) => `<Row>${r.map(cell).join("")}</Row>`).join("");
  return {
    body: `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Sheet1"><Table>${sheet}</Table></Worksheet></Workbook>`,
    type: "application/vnd.ms-excel",
    ext: "xls",
  };
}

/** Save rows as a download in the chosen format. */
export function saveTable(name: string, rows: CsvCell[][], fmt: TableFormat) {
  const t = toTable(rows, fmt);
  const url = URL.createObjectURL(new Blob([t.body], { type: t.type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.${t.ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
