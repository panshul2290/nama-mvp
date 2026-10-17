import { NAMA_LOGO_SVG } from "@/lib/nama-logo";

// Stroke icons from prototype.html (24×24, 1.8 stroke).
const PATHS = {
  home: "M3 11 12 4l9 7M5 10v10h14V10M10 20v-6h4v6",
  list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  user: "M12 12a4 4 0 1 0 0-8a4 4 0 1 0 0 8M4 21a8 8 0 0 1 16 0",
  jobs: "M3 7h18v13H3zM8 7V4h8v3M3 12h18",
  route: "M4 19a2 2 0 1 0 4 0a2 2 0 1 0-4 0M16 5a2 2 0 1 0 4 0a2 2 0 1 0-4 0M6 17V9a3 3 0 0 1 3-3h7M18 7v8a3 3 0 0 1-3 3H8",
  coins: "M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3ZM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  truck: "M2 6h12v10H2zM14 9h4l4 4v3h-8M4 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0M15 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
  back: "M15 18l-6-6 6-6",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4",
  drop: "M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z",
  check: "M5 12l5 5L20 7",
  alert: "M12 4l9 16H3zM12 10v4M12 17h.01",
  pin: "M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11zM12 12a2 2 0 1 0 0-4a2 2 0 1 0 0 4",
  clock: "M12 21a9 9 0 1 0 0-18a9 9 0 1 0 0 18M12 7v5l3 2",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  phone: "M7 2h10v20H7zM11 18h2",
  map: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`ic ${className ?? ""}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function NamaLogo({ className }: { className?: string }) {
  return <span className={`nl ${className ?? ""}`} role="img" aria-label="Nama Water Services" dangerouslySetInnerHTML={{ __html: NAMA_LOGO_SVG }} />;
}
