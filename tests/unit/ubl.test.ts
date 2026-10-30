// Unit tests for the UBL 2.1 Invoice XML (lib/ubl.ts) behind "Export UBL XML" on business
// invoices (Fawtara-ready). Structure only: well-formed XML, the UBL namespaces, the schema's
// element order, PEPPOL BIS 3 identifiers, totals that add up. No real e-invoicing service.
//   npm run test:unit
import { invoiceToUbl, muscatParts, ublInvoiceXml, ublProblems, ublTotals, xmlEscape, type InvoiceLineRow, type InvoiceRow } from "../../lib/ubl";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${JSON.stringify(detail)}`}`);
};

// ---------------------------------------------------------------- a tiny XML reader
type El = { name: string; attrs: Record<string, string>; children: El[]; text: string };
function parse(xml: string): El {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, "");
  const root: El = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: El[] = [root];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(body))) {
    if (m.index !== consumed) throw new Error(`unexpected text at ${consumed}`);
    consumed = re.lastIndex;
    if (m[5] !== undefined) {
      if (/[<>]/.test(m[5])) throw new Error("stray angle bracket");
      if (/&(?!(amp|lt|gt|quot|apos);)/.test(m[5])) throw new Error(`bad entity in ${JSON.stringify(m[5])}`);
      stack[stack.length - 1].text += m[5];
      continue;
    }
    const [, close, name, rawAttrs, selfClose] = m;
    if (close) {
      const top = stack.pop();
      if (!top || top.name !== name) throw new Error(`mismatched </${name}> (open: ${top?.name})`);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs.matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    const el: El = { name, attrs, children: [], text: "" };
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
  }
  if (consumed !== body.length) throw new Error("trailing content");
  if (stack.length !== 1) throw new Error(`unclosed <${stack[stack.length - 1].name}>`);
  if (root.children.length !== 1) throw new Error("not exactly one root element");
  return root.children[0];
}
const kids = (e: El, name?: string) => e.children.filter((c) => !name || c.name === name);
const kid = (e: El, path: string) => path.split("/").reduce<El | undefined>((x, n) => x && kids(x, n)[0], e);
const textOf = (e: El, path: string) => kid(e, path)?.text.trim();
/** True when `names` appear among e's children in this relative order (others may be in between). */
const inOrder = (e: El, names: string[]) => {
  const seq = e.children.map((c) => c.name).filter((n) => names.includes(n));
  const firsts = names.filter((n) => seq.includes(n));
  const order = [...new Set(seq)];
  return JSON.stringify(order) === JSON.stringify(firsts);
};

// ---------------------------------------------------------------- the invoice
console.log("## UNIT UBL 2.1 invoice XML (lib/ubl)");
const inv: InvoiceRow = {
  invoice_no: 9312,
  issued_at: "2026-10-30T20:15:30Z", // 00:15:30 on 31 Oct in Muscat
  due_at: "2026-11-29T20:15:30Z",
  period_start: "2026-10-01",
  period_end: "2026-10-30",
  type_code: "380",
  currency: "OMR",
  seller_name: "Nama Water Services",
  seller_vatin: "OM1100000001",
  buyer_name: "Hotel <Al Bustan> & Spa",
  buyer_cr: "1234567",
  buyer_vatin: "OM1234567891",
};
const lines: InvoiceLineRow[] = [
  { line_no: 2, description: "Drinking water delivery TO-48202", item_code: "TANKER-DW", quantity: "5000", unit_code: "GLL", net_amount: "16.200", vat_category: "S", vat_rate: "0.0500", vat_amount: "0.810", order_no: 48202 },
  { line_no: 1, description: "Drinking water delivery TO-48201", item_code: "TANKER-DW", quantity: "3000", unit_code: "GLL", net_amount: "11.200", vat_category: "S", vat_rate: "0.0500", vat_amount: "0.560", order_no: 48201 },
  { line_no: 3, description: "Wastewater collection TO-48203", item_code: "TANKER-WW", quantity: "3000", unit_code: "GLL", net_amount: "9.000", vat_category: "S", vat_rate: "0.0500", vat_amount: "0.450", order_no: 48203 },
];
const u = invoiceToUbl(inv, lines, { name_en: "Nama Water Services", vat_number: "", cr_no: "" }, { name: "Hotel", cr_no: "1234567", vat_number: null },
  { note: "VAT treatment to be confirmed with the Tax Authority", terms: "Net 30 days" });
const xml = ublInvoiceXml(u);

let doc: El | null = null;
try {
  doc = parse(xml);
  check("the document is well-formed XML", true);
} catch (e) {
  check("the document is well-formed XML", false, String(e));
}
if (doc) {
  check("root element is <Invoice> in the UBL 2.1 Invoice namespace",
    doc.name === "Invoice" && doc.attrs.xmlns === "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" &&
      doc.attrs["xmlns:cac"] === "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" &&
      doc.attrs["xmlns:cbc"] === "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    doc.attrs);
  check("UBLVersionID 2.1 and the PEPPOL BIS Billing 3.0 customization and profile",
    textOf(doc, "cbc:UBLVersionID") === "2.1" && textOf(doc, "cbc:CustomizationID")?.includes("peppol.eu:2017:poacc:billing:3.0") === true &&
      textOf(doc, "cbc:ProfileID") === "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0");
  check("invoice number, issue date and time in Muscat, due date, type code 380, currency OMR",
    textOf(doc, "cbc:ID") === "INV-9312" && textOf(doc, "cbc:IssueDate") === "2026-10-31" && textOf(doc, "cbc:IssueTime") === "00:15:30" &&
      textOf(doc, "cbc:DueDate") === "2026-11-30" && textOf(doc, "cbc:InvoiceTypeCode") === "380" && textOf(doc, "cbc:DocumentCurrencyCode") === "OMR",
    { date: textOf(doc, "cbc:IssueDate"), time: textOf(doc, "cbc:IssueTime") });
  const order = ["cbc:UBLVersionID", "cbc:CustomizationID", "cbc:ProfileID", "cbc:ID", "cbc:IssueDate", "cbc:IssueTime", "cbc:DueDate", "cbc:InvoiceTypeCode", "cbc:Note",
    "cbc:DocumentCurrencyCode", "cbc:BuyerReference", "cac:InvoicePeriod", "cac:AccountingSupplierParty", "cac:AccountingCustomerParty", "cac:PaymentMeans", "cac:PaymentTerms",
    "cac:TaxTotal", "cac:LegalMonetaryTotal", "cac:InvoiceLine"];
  check("top-level elements follow the UBL 2.1 Invoice sequence", inOrder(doc, order) && order.every((n) => kids(doc!, n).length > 0), doc.children.map((c) => c.name));
  const sup = kid(doc, "cac:AccountingSupplierParty/cac:Party");
  const cus = kid(doc, "cac:AccountingCustomerParty/cac:Party");
  check("seller VAT number (PartyTaxScheme, scheme VAT) and legal name",
    textOf(sup!, "cac:PartyTaxScheme/cbc:CompanyID") === "OM1100000001" && textOf(sup!, "cac:PartyTaxScheme/cac:TaxScheme/cbc:ID") === "VAT" &&
      textOf(sup!, "cac:PartyLegalEntity/cbc:RegistrationName") === "Nama Water Services" && textOf(sup!, "cac:PostalAddress/cac:Country/cbc:IdentificationCode") === "OM");
  check("buyer VAT number, CR number and a name with special characters escaped",
    textOf(cus!, "cac:PartyTaxScheme/cbc:CompanyID") === "OM1234567891" && textOf(cus!, "cac:PartyLegalEntity/cbc:CompanyID") === "1234567" &&
      textOf(cus!, "cac:PartyName/cbc:Name") === "Hotel &lt;Al Bustan&gt; &amp; Spa");
  check("party children follow the UBL sequence", inOrder(sup!, ["cac:PartyName", "cac:PostalAddress", "cac:PartyTaxScheme", "cac:PartyLegalEntity"]));
  const il = kids(doc, "cac:InvoiceLine");
  check("one InvoiceLine per invoice line, numbered in line order", il.length === 3 && il.map((l) => textOf(l, "cbc:ID")).join(",") === "1,2,3", il.map((l) => textOf(l, "cbc:ID")));
  const l1 = il[0];
  check("a line: quantity in gallons (GLL), net amount, VAT category S at 5%, item code, order reference",
    kid(l1, "cbc:InvoicedQuantity")?.attrs.unitCode === "GLL" && textOf(l1, "cbc:InvoicedQuantity") === "3000" && textOf(l1, "cbc:LineExtensionAmount") === "11.200" &&
      kid(l1, "cbc:LineExtensionAmount")?.attrs.currencyID === "OMR" && textOf(l1, "cac:Item/cac:ClassifiedTaxCategory/cbc:ID") === "S" &&
      textOf(l1, "cac:Item/cac:ClassifiedTaxCategory/cbc:Percent") === "5" && textOf(l1, "cac:Item/cac:SellersItemIdentification/cbc:ID") === "TANKER-DW" &&
      textOf(l1, "cac:OrderLineReference/cbc:LineID") === "TO-48201");
  check("line children follow the UBL sequence", inOrder(l1, ["cbc:ID", "cbc:InvoicedQuantity", "cbc:LineExtensionAmount", "cac:OrderLineReference", "cac:Item", "cac:Price"]));
  check("item children follow the UBL sequence", inOrder(kid(l1, "cac:Item")!, ["cbc:Description", "cbc:Name", "cac:SellersItemIdentification", "cac:ClassifiedTaxCategory"]));
  check("price × quantity / base quantity gives the line net exactly",
    Number(textOf(l1, "cac:Price/cbc:PriceAmount")) * 3000 / Number(textOf(l1, "cac:Price/cbc:BaseQuantity")) === 11.2);
  const tt = kid(doc, "cac:TaxTotal")!;
  const sub = kids(tt, "cac:TaxSubtotal");
  check("tax total 1.820 OMR with one subtotal for category S 5% on 36.400",
    textOf(tt, "cbc:TaxAmount") === "1.820" && sub.length === 1 && textOf(sub[0], "cbc:TaxableAmount") === "36.400" && textOf(sub[0], "cbc:TaxAmount") === "1.820" &&
      textOf(sub[0], "cac:TaxCategory/cbc:ID") === "S" && textOf(sub[0], "cac:TaxCategory/cac:TaxScheme/cbc:ID") === "VAT");
  const mt = kid(doc, "cac:LegalMonetaryTotal")!;
  check("monetary totals: lines 36.400, tax-exclusive 36.400, tax-inclusive and payable 38.220",
    textOf(mt, "cbc:LineExtensionAmount") === "36.400" && textOf(mt, "cbc:TaxExclusiveAmount") === "36.400" && textOf(mt, "cbc:TaxInclusiveAmount") === "38.220" &&
      textOf(mt, "cbc:PayableAmount") === "38.220" && inOrder(mt, ["cbc:LineExtensionAmount", "cbc:TaxExclusiveAmount", "cbc:TaxInclusiveAmount", "cbc:PayableAmount"]));
  check("every amount carries currencyID OMR and three decimals",
    [...xml.matchAll(/<cbc:(\w+Amount) currencyID="(\w+)">([^<]+)</g)].every((m) => m[2] === "OMR" && /^-?\d+\.\d{3}$/.test(m[3])));
  check("the VAT note is carried", textOf(doc, "cbc:Note") === "VAT treatment to be confirmed with the Tax Authority");
}

// ---------------------------------------------------------------- helpers
check("totals add up in baisa (no floating drift)", ublTotals([{ ...u.lines[0], net: 0.1, vatAmount: 0.005 }, { ...u.lines[0], net: 0.2, vatAmount: 0.01 }]).gross === 0.315);
check("two VAT rates give two tax subtotals", ublTotals([{ ...u.lines[0] }, { ...u.lines[0], vatCategory: "Z", vatRate: 0, vatAmount: 0 }]).subtotals.length === 2);
check("missing VAT numbers are reported before export", JSON.stringify(ublProblems({ ...u, seller: { ...u.seller, vatin: null }, buyer: { ...u.buyer, vatin: "" } })) === JSON.stringify(["seller_vatin", "buyer_vatin"]));
const noVat = ublInvoiceXml({ ...u, seller: { ...u.seller, vatin: null } });
check("without a seller VAT number the PartyTaxScheme is left out (still well-formed)", (() => {
  try {
    const d = parse(noVat);
    return !kid(d, "cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme");
  } catch {
    return false;
  }
})());
check("xmlEscape escapes the five XML characters", xmlEscape(`a<b>&"c'`) === "a&lt;b&gt;&amp;&quot;c&apos;");
check("Muscat parts: 20:00 UTC is midnight next day", JSON.stringify(muscatParts("2026-12-31T20:00:00Z")) === JSON.stringify({ date: "2027-01-01", time: "00:00:00" }));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
