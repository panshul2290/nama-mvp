// Where a tanker's last fix came from and whether it is evidence grade (C1/C5, 0028):
// IVMS or phone, ± accuracy, and "low accuracy" above the ±10 m the tender requires.
export const EVIDENCE_M = 10;
const SOURCE: Record<string, string> = { ivms: "IVMS", phone: "Phone", simulated: "Simulated" };

export function FixQuality({ source, accuracy }: { source: string | null | undefined; accuracy: number | null | undefined }) {
  if (accuracy == null && !source) return <>—</>;
  const low = accuracy == null || accuracy > EVIDENCE_M;
  return (
    <span title={low ? `Worse than ±${EVIDENCE_M} m: not evidence grade for geofence checks` : `Within ±${EVIDENCE_M} m: evidence grade`}>
      <span className={`st ${source === "ivms" ? "ok" : "act"}`}>{SOURCE[source ?? "phone"] ?? source}</span>{" "}
      {accuracy != null ? `±${accuracy.toFixed(1)} m` : ""}
      {low && <span className="st warn ptag">low accuracy</span>}
    </span>
  );
}
