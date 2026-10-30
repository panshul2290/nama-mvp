"use client";

// Where a tanker's last fix came from and whether it is evidence grade (C1/C5, 0028):
// IVMS or phone, ± accuracy, and "low accuracy" above the ±10 m the tender requires.
import { OPS } from "@/components/nws/i18n/ops";
import { localDigits, useLang, useT } from "@/lib/i18n";

export const EVIDENCE_M = 10;
const SOURCE: Record<string, string> = { ivms: "fqIvms", phone: "fqPhone", simulated: "fqSimulated" };

export function FixQuality({ source, accuracy }: { source: string | null | undefined; accuracy: number | null | undefined }) {
  const t = useT(OPS);
  const { lang } = useLang();
  if (accuracy == null && !source) return <>—</>;
  const low = accuracy == null || accuracy > EVIDENCE_M;
  const key = SOURCE[source ?? "phone"];
  return (
    <span title={low ? t("fqLowTip", { m: EVIDENCE_M }) : t("fqOkTip", { m: EVIDENCE_M })}>
      <span className={`st ${source === "ivms" ? "ok" : "act"}`}>{key ? t(key) : source}</span>{" "}
      {accuracy != null ? <span dir="ltr">{`±${localDigits(accuracy.toFixed(1), lang)} ${t("fqUnitM")}`}</span> : ""}
      {low && <span className="st warn ptag">{t("fqLow")}</span>}
    </span>
  );
}
