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
