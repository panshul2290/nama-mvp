"use client";

// Small hand-written SVG charts for Reports and Settings (no chart library).
// Colours are CSS variables from nws.css so they follow the portal theme.

export const SERVICE_COLOR = { DW: "var(--dw)", WW: "var(--ww)", TE: "var(--te)" } as const;
export const PALETTE = ["var(--accent)", "var(--dw)", "var(--ww)", "var(--te)", "var(--warn)", "#a78bfa", "var(--bad)", "var(--muted)"];

const fmtDefault = (v: number) => v.toLocaleString();

/** Horizontal labelled bars (the prototype's bars()). */
export function BarList({
  rows,
  max,
  fmt = fmtDefault,
  color = "var(--accent)",
  empty = "No data in this range.",
}: {
  rows: { label: React.ReactNode; value: number | null; color?: string; key?: string }[];
  max?: number;
  fmt?: (v: number) => string;
  color?: string;
  empty?: string;
}) {
  if (rows.length === 0) return <div className="empty">{empty}</div>;
  const top = max ?? Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <div className="bars">
      {rows.map((r, i) => (
        <div className="bar" key={r.key ?? (typeof r.label === "string" ? r.label : i)}>
          <span className="bl">{r.label}</span>
          <div className="track">
            <div className="fill" style={{ width: `${r.value == null ? 0 : Math.min(100, (r.value / top) * 100).toFixed(1)}%`, background: r.color ?? color }} />
          </div>
          <span className="num">{r.value == null ? "TBC" : fmt(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** Multi-series line chart over shared x labels. */
export function LineChart({
  labels,
  series,
  height = 190,
  fmt = fmtDefault,
  yMax,
}: {
  labels: string[];
  series: { name: string; color: string; values: (number | null)[] }[];
  height?: number;
  fmt?: (v: number) => string;
  yMax?: number;
}) {
  const W = 640, H = height, L = 44, R = 12, T = 12, B = 26;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  if (labels.length === 0 || all.length === 0) return <div className="empty">No data in this range.</div>;
  const top = yMax ?? niceMax(Math.max(...all));
  const x = (i: number) => L + (labels.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (labels.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => top * f);
  const every = Math.max(1, Math.ceil(labels.length / 10));
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={series.map((s) => s.name).join(", ")}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={L - 6} y={y(t) + 4} textAnchor="end" className="ax">{fmt(Math.round(t * 100) / 100)}</text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % every === 0 || i === labels.length - 1 ? (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle" className="ax">{l}</text>
          ) : null,
        )}
        {series.map((s) => {
          const pts = s.values.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`));
          const d = pts.reduce<string>((acc, p, i) => (p == null ? acc : acc + (i === 0 || pts[i - 1] == null ? "M" : "L") + p), "");
          return (
            <g key={s.name}>
              <path d={d} fill="none" stroke={s.color} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
              {s.values.map((v, i) => (v == null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={labels.length > 40 ? 0 : 2.8} fill={s.color}><title>{`${s.name} · ${labels[i]}: ${fmt(v)}`}</title></circle>))}
            </g>
          );
        })}
      </svg>
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Donut with a legend. */
export function Donut({
  slices,
  center,
  sub,
  fmt = fmtDefault,
}: {
  slices: { label: string; value: number; color: string }[];
  center?: string;
  sub?: string;
  fmt?: (v: number) => string;
}) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (total === 0) return <div className="empty">No data in this range.</div>;
  const r = 52, c = 2 * Math.PI * r;
  // Start offset of each slice along the circumference.
  const offs = slices.map((_, i) => slices.slice(0, i).reduce((a, s) => a + (s.value / total) * c, 0));
  return (
    <div className="donut">
      <svg viewBox="0 0 140 140" role="img" aria-label={slices.map((s) => `${s.label} ${fmt(s.value)}`).join(", ")}>
        <circle cx={70} cy={70} r={r} fill="none" stroke="var(--sunk)" strokeWidth={18} />
        {slices.map((s, i) => {
          const len = (s.value / total) * c;
          return (
            <circle key={s.label} cx={70} cy={70} r={r} fill="none" stroke={s.color} strokeWidth={18}
              strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offs[i]} transform="rotate(-90 70 70)">
              <title>{`${s.label}: ${fmt(s.value)}`}</title>
            </circle>
          );
        })}
        <text x={70} y={sub ? 70 : 76} textAnchor="middle" className="dc">{center ?? fmt(total)}</text>
        {sub && <text x={70} y={88} textAnchor="middle" className="ax">{sub}</text>}
      </svg>
      <ul>
        {slices.map((s) => (
          <li key={s.label}>
            <i style={{ background: s.color }} />
            <span>{s.label}</span>
            <b className="num">{fmt(s.value)}</b>
            <small>{Math.round((s.value / total) * 100)}%</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Tiny inline trend: bars (default) or a line. */
export function Sparkline({ values, width = 120, height = 24, color = "var(--accent)", line }: { values: number[]; width?: number; height?: number; color?: string; line?: boolean }) {
  const mx = Math.max(1, ...values);
  if (line) {
    const step = values.length > 1 ? width / (values.length - 1) : 0;
    const d = values.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${(height - 2 - (v / mx) * (height - 4)).toFixed(1)}`).join("");
    return (
      <svg width={width} height={height} aria-hidden="true">
        <path d={d} fill="none" stroke={color} strokeWidth={1.8} />
      </svg>
    );
  }
  const bw = width / values.length;
  return (
    <svg width={width} height={height} aria-hidden="true">
      {values.map((v, i) => {
        const h = Math.max(v > 0 ? 2 : 0, (v / mx) * (height - 2));
        return <rect key={i} x={i * bw} y={height - h} width={Math.max(1, bw - 4)} height={h} rx={1} fill={color} />;
      })}
    </svg>
  );
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
