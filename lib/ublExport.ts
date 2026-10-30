// "Export UBL XML" for one business invoice (business portal and NWS finance): read the
// invoice, its lines (with their order numbers), the organisation and the seller setting under
// the caller's RLS, build the UBL 2.1 document (lib/ubl.ts) and save it.
import { supabase } from "@/lib/supabase/client";
import { downloadXml, invoiceToUbl, ublInvoiceXml, ublProblems, type InvoiceLineRow, type InvoiceRow, type SellerSetting } from "@/lib/ubl";

export async function exportInvoiceUbl(invoiceId: string): Promise<{ file: string; problems: string[] } | { error: { message?: string } }> {
  const db = supabase();
  const [i, l, s] = await Promise.all([
    db.from("invoices").select("*").eq("id", invoiceId).maybeSingle<InvoiceRow & { org_id: string }>(),
    db.from("invoice_lines").select("*, order:orders(order_no)").eq("invoice_id", invoiceId).order("line_no"),
    db.from("app_settings").select("value").eq("key", "SELLER").maybeSingle<{ value: string }>(),
  ]);
  if (i.error || !i.data) return { error: i.error ?? { message: "not_found" } };
  if (l.error) return { error: l.error };
  const { data: org } = await db.from("organizations").select("name, cr_no, vat_number").eq("id", i.data.org_id).maybeSingle<{ name: string; cr_no: string; vat_number: string | null }>();
  let seller: SellerSetting = {};
  try {
    seller = s.data?.value ? (JSON.parse(s.data.value) as SellerSetting) : {};
  } catch {
    seller = {};
  }
  const lines = ((l.data ?? []) as (InvoiceLineRow & { order: { order_no: number } | null })[]).map((x) => ({ ...x, order_no: x.order?.order_no ?? null }));
  const doc = invoiceToUbl(i.data, lines, seller, { name: org?.name ?? i.data.buyer_name ?? "", cr_no: org?.cr_no ?? i.data.buyer_cr, vat_number: org?.vat_number ?? i.data.buyer_vatin }, {
    note: "VAT treatment to be confirmed with the Tax Authority.",
  });
  const file = `INV-${i.data.invoice_no}.xml`;
  downloadXml(file, ublInvoiceXml(doc));
  return { file, problems: ublProblems(doc) };
}
