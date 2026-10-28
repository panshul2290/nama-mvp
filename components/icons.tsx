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
  wallet: "M3 7h15a3 3 0 0 1 3 3v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l12-4v4M16 14h.01",
  star: "M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z",
  chat: "M4 5h16v11H8l-4 4z",
  camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7a3.5 3.5 0 1 0 0 7",
  file: "M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h6",
  settings: "M12 15a3 3 0 1 0 0-6a3 3 0 1 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  users: "M9 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8M2 21a7 7 0 0 1 14 0M16 3.1a4 4 0 0 1 0 7.8M18 14a6 6 0 0 1 4 7",
  building: "M4 21V5l8-3v19M12 9h8v12M8 8h.01M8 12h.01M8 16h.01M16 13h.01M16 17h.01M2 21h20",
  plus: "M12 5v14M5 12h14",
  x: "M6 6l12 12M18 6 6 18",
  search: "M11 18a7 7 0 1 0 0-14a7 7 0 1 0 0 14M21 21l-5-5",
  download: "M12 4v12M7 11l5 5 5-5M4 20h16",
  calendar: "M4 6h16v15H4zM4 10h16M8 3v4M16 3v4",
  flag: "M5 21V4h11l-1.5 4L16 12H5",
  gift: "M4 10h16v11H4zM2 7h20v3H2zM12 7v14M12 7S10 3 8 3a2 2 0 0 0 0 4M12 7s2-4 4-4a2 2 0 0 1 0 4",
  headset: "M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v5H4zM17 14h3v5h-3zM20 19a3 3 0 0 1-3 3h-4",
  zap: "M13 2 4 14h7l-1 8 9-12h-7z",
  globe: "M12 21a9 9 0 1 0 0-18a9 9 0 1 0 0 18M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12M12 15a3 3 0 1 0 0-6a3 3 0 1 0 0 6",
  play: "M7 4l13 8-13 8z",
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
