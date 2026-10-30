// Water-quality certificate data (E15): the tanker's test in force for a delivery and how
// each parameter compares with its limit (Omani Standard OS 8/2012, as shown before in the
// order card). order_water_certificate() (0030) when the database has it; otherwise the
// latest test from order_verification(), with a 90-day validity.
import { isMissing } from "@/lib/rpcCompat";
import { supabase } from "@/lib/supabase/client";

export type Certificate = {
  test_id: string | null;
  cert_no: string;
  tested_at: string;
  lab: string | null;
  valid_until: string;
  passed: boolean;
  sample: boolean;
  valid_on_delivery: boolean | null;
  chlorine: number | string;
  turbidity: number | string;
  tds: number | string;
  ph: number | string;
  ecoli: string;
  coliforms: string;
  order_no?: number | string | null;
  plate?: string | null;
  company?: string | null;
  delivered_at?: string | null;
};

export type ParamRow = { key: "wqCl" | "wqTurb" | "wqTds" | "wqPh" | "wqEcoli" | "wqColi"; value: string; unit: string; limit: string; ok: boolean; nd?: boolean };

const notDetected = (s: string) => /not detected/i.test(s ?? "");

export function parameterRows(c: Pick<Certificate, "chlorine" | "turbidity" | "tds" | "ph" | "ecoli" | "coliforms">): ParamRow[] {
  const cl = Number(c.chlorine);
  const tu = Number(c.turbidity);
  const td = Number(c.tds);
  const ph = Number(c.ph);
  return [
    { key: "wqCl", value: String(c.chlorine), unit: "mg/L", limit: "0.2–1.0", ok: cl >= 0.2 && cl <= 1 },
    { key: "wqTurb", value: String(c.turbidity), unit: "NTU", limit: "< 1", ok: tu < 1 },
    { key: "wqTds", value: String(c.tds), unit: "ppm", limit: "< 1000", ok: td < 1000 },
    { key: "wqPh", value: String(c.ph), unit: "", limit: "6.5–8.5", ok: ph >= 6.5 && ph <= 8.5 },
    { key: "wqEcoli", value: c.ecoli, unit: "", limit: "0 / 100 mL", ok: notDetected(c.ecoli), nd: notDetected(c.ecoli) },
    { key: "wqColi", value: c.coliforms, unit: "", limit: "0 / 100 mL", ok: notDetected(c.coliforms), nd: notDetected(c.coliforms) },
  ];
}

const addDays = (d: string, n: number) => new Date(Date.parse(d.slice(0, 10) + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

/** null = no certificate (no test on file, wastewater, or no tanker yet). */
export async function loadCertificate(orderId: string, deliveredAt: string | null): Promise<Certificate | null> {
  const db = supabase();
  const { data, error } = await db.rpc("order_water_certificate", { p_order_id: orderId });
  if (!error) return (data as Certificate | null) ?? null;
  if (!isMissing(error)) throw error;
  // Before 0030: the tanker's latest test from the verification card.
  const { data: v, error: e2 } = await db.rpc("order_verification", { p_order_id: orderId });
  if (e2) throw e2;
  const w = (v as { water_test?: Omit<Certificate, "lab" | "valid_until" | "sample" | "valid_on_delivery" | "test_id"> | null; plate?: string; company?: string } | null)?.water_test;
  if (!w) return null;
  const until = addDays(w.tested_at, 90);
  const day = (deliveredAt ?? new Date().toISOString()).slice(0, 10);
  return {
    ...w,
    test_id: null,
    lab: null,
    valid_until: until,
    sample: true,
    valid_on_delivery: w.tested_at.slice(0, 10) <= day && until >= day,
    plate: (v as { plate?: string }).plate ?? null,
    company: (v as { company?: string }).company ?? null,
  };
}
