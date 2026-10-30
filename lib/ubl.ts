// UBL 2.1 Invoice XML for business invoices (Fawtara-ready, PEPPOL BIS Billing 3.0 shape).
// Pure: invoiceToUbl() maps an invoice and its lines (0036) to a UblInvoice, and ublInvoiceXml()
// writes the XML document in the schema's element order. tests/unit/ubl.test.ts checks the
// structure; nothing here talks to a real e-invoicing service.

export type VatCategory = "S" | "Z" | "E" | "O";
export type UblParty = { name: string; vatin?: string | null; crNo?: string | null; city?: string; country: string };
export type UblLine = {
  id: string;
  description: string;
  name: string;
  itemCode: string;
  orderRef?: string;
  quantity: number;
  unitCode: string;
  net: number;
  vatCategory: VatCategory;
  vatRate: number; // fraction, 0.05 = 5%
  vatAmount: number;
};
export type UblInvoice = {
  id: string;
  issueDate: string; // YYYY-MM-DD (Muscat)
  issueTime: string; // HH:MM:SS (Muscat)
  dueDate?: string;
  typeCode: string; // 380 commercial invoice, 381 credit note…
  currency: string;
  note?: string;
  buyerReference?: string;
  periodStart?: string;
  periodEnd?: string;
  seller: UblParty;
  buyer: UblParty;
  paymentId?: string;
  paymentTerms?: string;
  lines: UblLine[];
};

const NS = {
  inv: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
};
export const UBL_CUSTOMIZATION = "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0";
export const UBL_PROFILE = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";

export const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** OMR amounts carry 3 decimals (1 OMR = 1,000 baisa). */
const amt = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3);
const pct = (rate: number) => String(Math.round(rate * 10000) / 100);
const qty = (v: number) => String(Math.round(v * 1000) / 1000);

type Totals = { net: number; vat: number; gross: number; subtotals: { category: VatCategory; rate: number; taxable: number; tax: number }[] };

/** Line, VAT and document totals, summed in baisa so they add up exactly. */
export function ublTotals(lines: UblLine[]): Totals {
  const b = (v: number) => Math.round(v * 1000);
  const groups = new Map<string, { category: VatCategory; rate: number; taxable: number; tax: number }>();
  let net = 0;
  let vat = 0;
  for (const l of lines) {
    net += b(l.net);
    vat += b(l.vatAmount);
    const k = `${l.vatCategory}:${l.vatRate}`;
    const g = groups.get(k) ?? { category: l.vatCategory, rate: l.vatRate, taxable: 0, tax: 0 };
    g.taxable += b(l.net);
    g.tax += b(l.vatAmount);
    groups.set(k, g);
  }
  return {
    net: net / 1000,
    vat: vat / 1000,
    gross: (net + vat) / 1000,
    subtotals: [...groups.values()].map((g) => ({ ...g, taxable: g.taxable / 1000, tax: g.tax / 1000 })),
  };
}

/** What a receiving e-invoicing platform would reject or query (shown before export). */
export function ublProblems(inv: UblInvoice): string[] {
  const out: string[] = [];
  if (!inv.seller.vatin) out.push("seller_vatin");
  if (!inv.buyer.vatin) out.push("buyer_vatin");
  if (!inv.lines.length) out.push("no_lines");
  if (inv.currency !== "OMR") out.push("currency");
  return out;
}

function party(tag: "AccountingSupplierParty" | "AccountingCustomerParty", p: UblParty): string {
  return [
    `  <cac:${tag}>`,
    "    <cac:Party>",
    `      <cac:PartyName><cbc:Name>${xmlEscape(p.name)}</cbc:Name></cac:PartyName>`,
    "      <cac:PostalAddress>",
    p.city ? `        <cbc:CityName>${xmlEscape(p.city)}</cbc:CityName>` : "",
    `        <cac:Country><cbc:IdentificationCode>${xmlEscape(p.country)}</cbc:IdentificationCode></cac:Country>`,
    "      </cac:PostalAddress>",
    p.vatin
      ? `      <cac:PartyTaxScheme><cbc:CompanyID>${xmlEscape(p.vatin)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`
      : "",
    `      <cac:PartyLegalEntity><cbc:RegistrationName>${xmlEscape(p.name)}</cbc:RegistrationName>${p.crNo ? `<cbc:CompanyID>${xmlEscape(p.crNo)}</cbc:CompanyID>` : ""}</cac:PartyLegalEntity>`,
    "    </cac:Party>",
    `  </cac:${tag}>`,
  ]
    .filter(Boolean)
    .join("\n");
}

const taxCategory = (tag: "TaxCategory" | "ClassifiedTaxCategory", c: VatCategory, rate: number, indent: string) =>
  `${indent}<cac:${tag}><cbc:ID>${c}</cbc:ID><cbc:Percent>${pct(rate)}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:${tag}>`;

/** The UBL 2.1 Invoice document, elements in the schema's sequence. */
export function ublInvoiceXml(inv: UblInvoice): string {
  const cur = xmlEscape(inv.currency);
  const money = (tag: string, v: number) => `<cbc:${tag} currencyID="${cur}">${amt(v)}</cbc:${tag}>`;
  const tot = ublTotals(inv.lines);
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Invoice xmlns="${NS.inv}" xmlns:cac="${NS.cac}" xmlns:cbc="${NS.cbc}">`,
    "  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>",
    `  <cbc:CustomizationID>${UBL_CUSTOMIZATION}</cbc:CustomizationID>`,
    `  <cbc:ProfileID>${UBL_PROFILE}</cbc:ProfileID>`,
    `  <cbc:ID>${xmlEscape(inv.id)}</cbc:ID>`,
    `  <cbc:IssueDate>${inv.issueDate}</cbc:IssueDate>`,
    `  <cbc:IssueTime>${inv.issueTime}</cbc:IssueTime>`,
  ];
  if (inv.dueDate) out.push(`  <cbc:DueDate>${inv.dueDate}</cbc:DueDate>`);
  out.push(`  <cbc:InvoiceTypeCode>${xmlEscape(inv.typeCode)}</cbc:InvoiceTypeCode>`);
  if (inv.note) out.push(`  <cbc:Note>${xmlEscape(inv.note)}</cbc:Note>`);
  out.push(`  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>`);
  if (inv.buyerReference) out.push(`  <cbc:BuyerReference>${xmlEscape(inv.buyerReference)}</cbc:BuyerReference>`);
  if (inv.periodStart && inv.periodEnd) {
    out.push(`  <cac:InvoicePeriod><cbc:StartDate>${inv.periodStart}</cbc:StartDate><cbc:EndDate>${inv.periodEnd}</cbc:EndDate></cac:InvoicePeriod>`);
  }
  out.push(party("AccountingSupplierParty", inv.seller), party("AccountingCustomerParty", inv.buyer));
  out.push(
    `  <cac:PaymentMeans><cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>${inv.paymentId ? `<cbc:PaymentID>${xmlEscape(inv.paymentId)}</cbc:PaymentID>` : ""}</cac:PaymentMeans>`,
  );
  if (inv.paymentTerms) out.push(`  <cac:PaymentTerms><cbc:Note>${xmlEscape(inv.paymentTerms)}</cbc:Note></cac:PaymentTerms>`);
  out.push("  <cac:TaxTotal>", `    ${money("TaxAmount", tot.vat)}`);
  for (const s of tot.subtotals) {
    out.push("    <cac:TaxSubtotal>", `      ${money("TaxableAmount", s.taxable)}`, `      ${money("TaxAmount", s.tax)}`, taxCategory("TaxCategory", s.category, s.rate, "      "), "    </cac:TaxSubtotal>");
  }
  out.push(
    "  </cac:TaxTotal>",
    "  <cac:LegalMonetaryTotal>",
    `    ${money("LineExtensionAmount", tot.net)}`,
    `    ${money("TaxExclusiveAmount", tot.net)}`,
    `    ${money("TaxInclusiveAmount", tot.gross)}`,
    `    ${money("PayableAmount", tot.gross)}`,
    "  </cac:LegalMonetaryTotal>",
  );
  for (const l of inv.lines) {
    out.push(
      "  <cac:InvoiceLine>",
      `    <cbc:ID>${xmlEscape(l.id)}</cbc:ID>`,
      `    <cbc:InvoicedQuantity unitCode="${xmlEscape(l.unitCode)}">${qty(l.quantity)}</cbc:InvoicedQuantity>`,
      `    ${money("LineExtensionAmount", l.net)}`,
    );
    if (l.orderRef) out.push(`    <cac:OrderLineReference><cbc:LineID>${xmlEscape(l.orderRef)}</cbc:LineID></cac:OrderLineReference>`);
    out.push(
      "    <cac:Item>",
      `      <cbc:Description>${xmlEscape(l.description)}</cbc:Description>`,
      `      <cbc:Name>${xmlEscape(l.name)}</cbc:Name>`,
      `      <cac:SellersItemIdentification><cbc:ID>${xmlEscape(l.itemCode)}</cbc:ID></cac:SellersItemIdentification>`,
      taxCategory("ClassifiedTaxCategory", l.vatCategory, l.vatRate, "      "),
      "    </cac:Item>",
      // The price of the whole quantity: PriceAmount × InvoicedQuantity / BaseQuantity = the line net, exactly.
      `    <cac:Price>${money("PriceAmount", l.net)}<cbc:BaseQuantity unitCode="${xmlEscape(l.unitCode)}">${qty(l.quantity || 1)}</cbc:BaseQuantity></cac:Price>`,
      "  </cac:InvoiceLine>",
    );
  }
  out.push("</Invoice>", "");
  return out.join("\n");
}

// ---------------------------------------------------------------- from the database rows

export type InvoiceRow = {
  invoice_no: number;
  issued_at: string;
  due_at: string;
  period_start: string;
  period_end: string;
  type_code?: string | null;
  currency?: string | null;
  seller_name?: string | null;
  seller_vatin?: string | null;
  buyer_name?: string | null;
  buyer_cr?: string | null;
  buyer_vatin?: string | null;
};
export type InvoiceLineRow = {
  line_no: number;
  description: string;
  item_code: string;
  quantity: string | number;
  unit_code: string;
  net_amount: string | number;
  vat_category: string;
  vat_rate: string | number;
  vat_amount: string | number;
  order_no?: number | null;
};
export type SellerSetting = { name_en?: string; vat_number?: string; cr_no?: string; address_en?: string };

/** Date and time parts in Muscat (UTC+4, no daylight saving). */
export function muscatParts(iso: string): { date: string; time: string } {
  const d = new Date(Date.parse(iso) + 4 * 3600_000).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 19) };
}

const SERVICE_NAME: Record<string, string> = { "TANKER-DW": "Drinking water tanker delivery", "TANKER-WW": "Wastewater tanker collection", "TANKER-TE": "Treated effluent tanker delivery" };

export function invoiceToUbl(
  inv: InvoiceRow,
  lines: InvoiceLineRow[],
  seller: SellerSetting,
  buyer: { name: string; cr_no?: string | null; vat_number?: string | null },
  opts: { note?: string; terms?: string } = {},
): UblInvoice {
  const { date, time } = muscatParts(inv.issued_at);
  const no = `INV-${inv.invoice_no}`;
  return {
    id: no,
    issueDate: date,
    issueTime: time,
    dueDate: muscatParts(inv.due_at).date,
    typeCode: inv.type_code || "380",
    currency: inv.currency || "OMR",
    note: opts.note,
    buyerReference: buyer.cr_no ?? inv.buyer_cr ?? undefined,
    periodStart: inv.period_start?.slice(0, 10),
    periodEnd: inv.period_end?.slice(0, 10),
    seller: { name: inv.seller_name || seller.name_en || "Nama Water Services", vatin: inv.seller_vatin || seller.vat_number || null, crNo: seller.cr_no || null, city: "Muscat", country: "OM" },
    buyer: { name: inv.buyer_name || buyer.name, vatin: inv.buyer_vatin || buyer.vat_number || null, crNo: inv.buyer_cr || buyer.cr_no || null, country: "OM" },
    paymentId: no,
    paymentTerms: opts.terms,
    lines: [...lines]
      .sort((a, b) => a.line_no - b.line_no)
      .map((l) => ({
        id: String(l.line_no),
        description: l.description,
        name: SERVICE_NAME[l.item_code] ?? l.item_code,
        itemCode: l.item_code,
        orderRef: l.order_no != null ? `TO-${l.order_no}` : undefined,
        quantity: Number(l.quantity),
        unitCode: l.unit_code || "GLL",
        net: Number(l.net_amount),
        vatCategory: (["S", "Z", "E", "O"].includes(l.vat_category) ? l.vat_category : "S") as VatCategory,
        vatRate: Number(l.vat_rate),
        vatAmount: Number(l.vat_amount),
      })),
  };
}

/** Save the XML as a file (browser only). */
export function downloadXml(filename: string, xml: string) {
  const url = URL.createObjectURL(new Blob([xml], { type: "application/xml;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
