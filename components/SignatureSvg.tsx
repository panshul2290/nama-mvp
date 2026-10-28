/** The driver app's signature pad draws path data in this box (components/driver/TripSheets.tsx). */
const SIG_W = 300;
const SIG_H = 120;

/**
 * A stored signature (pods.signature_svg): either a complete `<svg…>` document or path-only
 * data ("M10 10L20 20…") from the driver's signature pad. A document is shown as an image
 * (scripts in an SVG image never run); path data is drawn inside a bounded viewBox.
 */
export function SignatureSvg({ value, label, className, style }: { value: string | null | undefined; label: string; className?: string; style?: React.CSSProperties }) {
  const s = value?.trim();
  if (!s) return null;
  if (/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(s)) {
    // eslint-disable-next-line @next/next/no-img-element -- inline SVG data URL
    return <img className={className} style={style} src={`data:image/svg+xml;utf8,${encodeURIComponent(s)}`} alt={label} />;
  }
  return (
    <svg className={className} style={style} viewBox={`0 0 ${SIG_W} ${SIG_H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={label}>
      <path d={s} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
