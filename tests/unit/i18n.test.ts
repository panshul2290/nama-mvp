// Arabic for the web portals (NWS staff, Company, Business).  npm run test:unit
// 1. Every dictionary entry the portals use has both English and Arabic, with the same {placeholders}.
// 2. A scan of the portals' JSX for English text that is not going through a dictionary.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  if (!ok || process.env.VERBOSE) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${JSON.stringify(detail)}`}`);
};

const ROOT = join(__dirname, "..", "..");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

// ---------------------------------------------------------------- 1. dictionaries
const DICT_FILES = [
  "components/portal/dict.ts",
  "components/portal/authI18n.ts",
  "lib/labels.ts",
  "lib/errors.ts",
  ...walk(join(ROOT, "components/nws/i18n")).map(rel),
  "components/company/i18n.ts",
  "components/business/i18n.ts",
  "components/business/money.ts",
  // Sign-in, messaging and support batch: the one refund policy, the customer app's words.
  "lib/refundPolicy.ts",
  "components/customer/i18n.ts",
  // Addresses, drivers and scheduling batch (0040–0045): the driver app and the shared address / fallback words.
  "components/driver/i18n.ts",
  "lib/addressI18n.ts",
].filter((f) => f.endsWith(".ts"));

type Entry = { en: string; ar: string };
const isEntry = (v: unknown): v is Entry => !!v && typeof v === "object" && "en" in v && "ar" in v;
const isDict = (v: unknown): v is Record<string, Entry> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0 && Object.values(v).every(isEntry);
const holes = (s: string) => (s.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort().join(",");
const ARABIC = /[؀-ۿ]/;
// Entries whose Arabic is deliberately the same Latin text (brand names, file formats).
const LATIN_OK = /^(OmanNet|CSV|XLS|XML|TXT|HTML|ASCII|API|SMS|GPS|IVMS|TFS|PDF|OMR|ID|[A-Z0-9 ._\-/·:+%()]+)$/;

async function dictionaries() {
  console.log("## UNIT portal dictionaries have English and Arabic");
  let entries = 0;
  for (const f of DICT_FILES) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(join(ROOT, f)).href)) as Record<string, unknown>;
    } catch (e) {
      check(`${f} loads`, false, String(e));
      continue;
    }
    const dicts = Object.entries(mod).filter(([, v]) => isDict(v)) as [string, Record<string, Entry>][];
    check(`${f} exports at least one dictionary`, dicts.length > 0, Object.keys(mod));
    for (const [name, d] of dicts) {
      for (const [key, e] of Object.entries(d)) {
        entries++;
        const id = `${f} ${name}.${key}`;
        check(`${id} has English`, typeof e.en === "string" && e.en.trim() !== "", e);
        check(`${id} has Arabic`, typeof e.ar === "string" && e.ar.trim() !== "", e);
        if (!e.ar) continue;
        // Placeholders and punctuation only ("{what}: {n}") need no Arabic letters.
        const words = e.ar.replace(/\{[a-zA-Z0-9_]+\}/g, "");
        check(`${id} Arabic is Arabic`, ARABIC.test(e.ar) || !/[A-Za-z]/.test(words) || LATIN_OK.test(e.ar.trim()) || e.ar === e.en, e.ar);
        check(`${id} same {placeholders}`, holes(e.en) === holes(e.ar), { en: e.en, ar: e.ar });
      }
    }
  }
  console.log(`   ${entries} entries in ${DICT_FILES.length} files`);
}

// ---------------------------------------------------------------- 2. hard-coded English in JSX
const SCAN_DIRS = ["app/nws", "components/nws", "app/company", "components/company", "app/business", "components/business", "components/portal"];
// Files to leave out of the scan (none at the moment).
const SKIP_FILES = new Set<string>([]);
// Text that is the same in both languages: units, codes, brand and format names, sample input.
const ALLOW = new Set([
  "English", "OMR", "CSV", "XLS", "XML", "TXT", "HTML", "ASCII", "API", "SMS", "GPS", "IVMS", "PDF", "JSON", "NWS", "TFS",
  "DW", "WW", "TE", "km", "m", "gal", "OmanNet", "WhatsApp", "TO-", "PO-", "CR", "ID", "QR", "SLA", "KPI", "BI", "OK", "SSO",
]);
const ATTRS = new Set(["title", "placeholder", "aria-label", "alt", "label"]);
// A literal that needs translating: two or more English words, or one capitalised word of 3+ letters.
const ENGLISH = /[A-Za-z]{2,}[^<>{}]*\s[A-Za-z]{2,}|^[A-Z][a-z]{2,}/;
// Placeholders that are sample data (a phone, a plate, a CR or permit number, an email).
const SAMPLE = /^(e\.g\.\s*)?[+\d\s\-()]+$|@|^[A-Z]{1,3}[\s-]?\d|^\d/;

function scanFile(path: string): string[] {
  const src = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const ignored = (n: ts.Node) => {
    // `// i18n-ignore` on the line above (or the same line) keeps a deliberate English literal.
    const line = lineOf(n);
    const lines = src.split("\n");
    return /i18n-ignore/.test(lines[line - 1] ?? "") || /i18n-ignore/.test(lines[line - 2] ?? "");
  };
  const flag = (n: ts.Node, text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t || ALLOW.has(t) || !ENGLISH.test(t) || ignored(n)) return;
    found.push(`${rel(path)}:${lineOf(n)}  ${JSON.stringify(t.slice(0, 80))}`);
  };
  // The string literals an expression can evaluate to: `"Save"`, `busy ? "Saving…" : "Save"`,
  // `ok && "Done"`, the fixed parts of a template literal.
  const leaves = (e: ts.Expression): ts.Node[] => {
    if (ts.isStringLiteralLike(e)) return [e];
    if (ts.isParenthesizedExpression(e)) return leaves(e.expression);
    if (ts.isConditionalExpression(e)) return [...leaves(e.whenTrue), ...leaves(e.whenFalse)];
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind))
      return e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? leaves(e.right) : [...leaves(e.left), ...leaves(e.right)];
    if (ts.isTemplateExpression(e)) return [e.head, ...e.templateSpans.map((s) => s.literal)];
    return [];
  };
  const textOf = (n: ts.Node) => (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) ? n.text : "");
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) flag(n, n.text);
    else if (ts.isJsxAttribute(n) && ATTRS.has(n.name.getText(sf)) && n.initializer) {
      const init = n.initializer;
      const lits = ts.isStringLiteral(init) ? [init] : ts.isJsxExpression(init) && init.expression ? leaves(init.expression) : [];
      for (const lit of lits) if (!(n.name.getText(sf) === "placeholder" && SAMPLE.test(textOf(lit)))) flag(lit, textOf(lit));
    } else if (ts.isJsxExpression(n) && n.expression && !ts.isJsxAttribute(n.parent)) {
      for (const lit of leaves(n.expression)) flag(lit, textOf(lit));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

function literals() {
  console.log("## UNIT no hard-coded English in the portals' JSX");
  // I18N_SCAN=app/nws/orders,components/nws/ops.tsx narrows the scan to some paths (while translating).
  const only = (process.env.I18N_SCAN ?? "").split(",").filter(Boolean);
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)))
    .filter((f) => f.endsWith(".tsx") && !SKIP_FILES.has(rel(f)))
    .filter((f) => !only.length || only.some((o) => rel(f).startsWith(o)));
  const found = files.flatMap(scanFile);
  for (const f of found) console.log(`   english: ${f}`);
  check(`${files.length} portal .tsx files have no English JSX text outside the dictionaries`, found.length === 0, `${found.length} found`);
}

(async () => {
  await dictionaries();
  literals();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
