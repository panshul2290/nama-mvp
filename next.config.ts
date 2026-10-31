import type { NextConfig } from "next";

// Security headers for the hosted web app (security review SEC-07). The Capacitor apps are a
// static export built from their own next.config (scripts/build-mobile.mjs), where headers()
// doesn't apply; nothing here runs there.
//
// The CSP allows exactly what the app loads:
// - Supabase (REST, Auth, Storage signed URLs, Realtime over wss) from NEXT_PUBLIC_SUPABASE_URL;
// - the basemap (OpenFreeMap styles, tiles, glyphs and sprites, or NEXT_PUBLIC_MAP_STYLE_*);
// - road routing (NEXT_PUBLIC_OSRM_URL, default the public OSRM demo server) and Nominatim
//   reverse geocoding;
// - MapLibre's worker from /maplibre-gl-worker.mjs (plus blob: workers), data:/blob: images
//   (signatures, photo previews), inline styles (MapLibre, React style props).
// next/font self-hosts Google Fonts, so fonts come from 'self'.
// Scripts: Next's inline bootstrap needs 'unsafe-inline' until nonces are wired in through the
// proxy (follow-up); 'unsafe-eval' only in development (React Refresh).
const dev = process.env.NODE_ENV !== "production";

const origin = (url: string | undefined) => {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
};

const supabase = origin(process.env.NEXT_PUBLIC_SUPABASE_URL);
const supabaseHosts = supabase ? [supabase, supabase.replace(/^http/, "ws")] : ["https://*.supabase.co", "wss://*.supabase.co"];
const mapHosts = [
  "https://tiles.openfreemap.org",
  origin(process.env.NEXT_PUBLIC_MAP_STYLE_LIGHT),
  origin(process.env.NEXT_PUBLIC_MAP_STYLE_DARK),
].filter((x): x is string => !!x);
const routing = [origin(process.env.NEXT_PUBLIC_OSRM_URL) ?? "https://router.project-osrm.org", "https://nominatim.openstreetmap.org"];
const uniq = (xs: string[]) => [...new Set(xs)].join(" ");

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src ${uniq(["'self'", "data:", "blob:", ...supabaseHosts.filter((h) => h.startsWith("http")), ...mapHosts])}`,
  "font-src 'self' data:",
  `connect-src ${uniq(["'self'", ...supabaseHosts, ...mapHosts, ...routing, ...(dev ? ["ws:", "wss:"] : [])])}`,
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "media-src 'self' blob: mediastream:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  ...(dev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(self), geolocation=(self), screen-wake-lock=(self), fullscreen=(self), microphone=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), browsing-topics=()",
  },
  // Popups the app opens itself (the NWS wall screen, the app launcher, report print windows) keep working.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  // Two years, subdomains included. Not "preload": that commits the whole registrable domain to
  // HTTPS in browsers for good, so it's the owner's call once the production domain is fixed.
  ...(dev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Public live-route links carry a bearer token in the URL: never pass it on as a referrer,
      // and keep the page out of search engines (for the same key, the later entry wins).
      {
        source: "/share/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
