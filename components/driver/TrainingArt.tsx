// Illustrations for the training lessons (components/driver/training.ts): simple inline
// drawings, so the lessons work offline and in both app builds.
import type { LessonKey } from "./training";

const INK = "#0e2329";
const SKY = "#dfeaec";

function Tanker({ x = 40, y = 70, color = "var(--dw)" }: { x?: number; y?: number; color?: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x="0" y="0" width="120" height="44" rx="20" fill={color} />
      <rect x="122" y="10" width="40" height="34" rx="6" fill={INK} opacity=".85" />
      <rect x="132" y="16" width="20" height="12" rx="2" fill="#fff" opacity=".7" />
      <circle cx="28" cy="50" r="10" fill={INK} />
      <circle cx="96" cy="50" r="10" fill={INK} />
      <circle cx="145" cy="50" r="10" fill={INK} />
    </g>
  );
}

export function TrainingArt({ lesson, label }: { lesson: LessonKey; label: string }) {
  return (
    <svg className="tr-art" viewBox="0 0 300 150" role="img" aria-label={label}>
      <rect width="300" height="150" rx="10" fill={SKY} />
      {lesson === "safety" && (
        <>
          <Tanker x={20} y={62} />
          <g transform="translate(212 28)">
            <path d="M34 0l34 12v26c0 22-15 38-34 46C15 76 0 60 0 38V12z" fill="var(--ok)" opacity=".9" />
            <path d="M18 40l11 11 22-24" stroke="#fff" strokeWidth="7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </g>
          <g transform="translate(190 118)">
            <circle r="16" cx="16" cy="0" fill="#fff" stroke="var(--bad)" strokeWidth="4" />
            <text x="16" y="5" textAnchor="middle" fontSize="13" fontWeight="700" fill={INK}>100</text>
          </g>
        </>
      )}
      {lesson === "filling" && (
        <>
          <rect x="18" y="30" width="70" height="96" rx="6" fill="#fff" stroke={INK} strokeWidth="2" />
          <text x="53" y="52" textAnchor="middle" fontSize="12" fontWeight="700" fill={INK}>NWS</text>
          <path d="M88 70 C 120 70, 120 82, 150 82" stroke={INK} strokeWidth="5" fill="none" />
          <Tanker x={120} y={70} />
          <circle cx="150" cy="80" r="66" fill="none" stroke="var(--dw)" strokeWidth="2" strokeDasharray="6 5" opacity=".6" />
        </>
      )}
      {lesson === "discharge" && (
        <>
          <Tanker x={14} y={70} color="var(--ww)" />
          <rect x="200" y="58" width="80" height="60" rx="8" fill="#fff" stroke={INK} strokeWidth="2" />
          <circle cx="226" cy="90" r="14" fill="var(--ww)" opacity=".5" />
          <circle cx="258" cy="90" r="14" fill="var(--ww)" opacity=".5" />
          <circle cx="240" cy="88" r="58" fill="none" stroke="var(--ok)" strokeWidth="2.5" strokeDasharray="6 5" />
          <path d="M160 40 l6 -14 l6 14 a6 6 0 1 1 -12 0z" fill="var(--bad)" transform="translate(70 -10)" />
        </>
      )}
      {lesson === "pod" && (
        <>
          <rect x="96" y="14" width="108" height="124" rx="14" fill={INK} />
          <rect x="104" y="26" width="92" height="64" rx="4" fill="#fff" />
          <rect x="118" y="44" width="64" height="34" rx="12" fill="var(--dw)" opacity=".6" />
          <circle cx="182" cy="36" r="6" fill="var(--bad)" />
          <path d="M108 112 c10 -14 18 10 28 -4 s16 8 26 -2 s14 6 30 -4" stroke="#fff" strokeWidth="2.5" fill="none" />
          <path d="M240 46 a14 14 0 1 1 28 0 c0 12 -14 26 -14 26 s-14 -14 -14 -26z" fill="var(--bad)" />
          <circle cx="254" cy="46" r="5" fill="#fff" />
        </>
      )}
      {lesson === "etiquette" && (
        <>
          <circle cx="90" cy="54" r="18" fill={INK} opacity=".85" />
          <rect x="66" y="76" width="48" height="56" rx="18" fill="var(--dw)" />
          <circle cx="210" cy="54" r="18" fill={INK} opacity=".55" />
          <rect x="186" y="76" width="48" height="56" rx="18" fill="var(--te)" />
          <rect x="120" y="24" width="60" height="34" rx="10" fill="#fff" stroke={INK} strokeWidth="2" />
          <path d="M134 41h32M134 33h20" stroke={INK} strokeWidth="3" strokeLinecap="round" />
          <path d="M138 58l-8 10 14-10z" fill="#fff" stroke={INK} strokeWidth="2" />
        </>
      )}
    </svg>
  );
}
