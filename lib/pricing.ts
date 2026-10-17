// Tariff, mirrored from public.price_quote() in the migration. The server
// recomputes the price on place_order; this copy is only for the live quote.
// Integer arithmetic in hundredths of a baisa avoids float drift.

export type ServiceType = "DW" | "WW" | "TE";

export const SERVICE_LABEL: Record<ServiceType, string> = {
  DW: "Drinking water",
  WW: "Wastewater",
  TE: "Treated effluent",
};

export const VOLUME_PRESETS: Record<ServiceType, number[]> = {
  DW: [650, 1000, 3000, 5000],
  WW: [1000, 3000, 5000],
  TE: [3000, 5000, 10000],
};

const FEE_BAISA: Record<ServiceType, number> = { DW: 3500, WW: 6000, TE: 8000 };

export type Quote = {
  water: number; // all amounts in baisa (integer)
  fee: number;
  vat: number;
  total: number;
  driverEarnings: number;
};

function waterCentiBaisa(type: ServiceType, gallons: number): number {
  switch (type) {
    case "DW":
      return Math.min(gallons, 650) * 100 + Math.max(gallons - 650, 0) * 300;
    case "WW":
      return gallons * 100;
    case "TE":
      return gallons * 5;
  }
}

// Half away from zero, matching Postgres round(numeric).
const roundDiv = (n: number, d: number) => Math.floor((n * 2 + d) / (2 * d));

export function quote(type: ServiceType, gallons: number): Quote {
  const g = Math.max(0, Math.floor(gallons));
  const water = roundDiv(waterCentiBaisa(type, g), 100);
  const fee = FEE_BAISA[type];
  const vat = roundDiv((water + fee) * 5, 100);
  return { water, fee, vat, total: water + fee + vat, driverEarnings: roundDiv(fee * 85, 100) };
}

export const omr = (baisa: number) => `${(baisa / 1000).toFixed(3)} OMR`;

// Postgres numeric(10,3) arrives as a string or number of OMR.
export const omrValue = (v: string | number) => `${Number(v).toFixed(3)} OMR`;
