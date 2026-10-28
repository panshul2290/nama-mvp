// SVG glyphs shared by the phone maps (HTML markers) and the fleet maps (map icons), so a
// tanker, a delivery point or a filling station looks the same in every app.
import { MAP_COLORS } from "@/lib/mapStyle";

/** Tanker truck, side view (tank, cab, three wheels) in a 24×24 box, drawn in `ink` over `bg`. */
export const truckPath = (ink: string, bg: string) =>
  `<rect x="1.6" y="6.4" width="13.2" height="7.6" rx="3.8" fill="${ink}"/>` +
  `<path d="M15.6 8.4h3.3l3 3.6V16h-6.3z" fill="${ink}"/>` +
  `<path d="M17 9.7h1.5l1.8 2.2H17z" fill="${bg}"/>` +
  `<rect x="1.6" y="14.2" width="20.3" height="1.8" rx=".6" fill="${ink}"/>` +
  `<circle cx="5.6" cy="17.3" r="2.1" fill="${ink}" stroke="${bg}" stroke-width="1.1"/>` +
  `<circle cx="10.7" cy="17.3" r="2.1" fill="${ink}" stroke="${bg}" stroke-width="1.1"/>` +
  `<circle cx="18.4" cy="17.3" r="2.1" fill="${ink}" stroke="${bg}" stroke-width="1.1"/>`;

export const TRUCK_SVG = (bg: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${truckPath("#fff", bg)}</svg>`;

const DROP = (c: string) => `<path d="M12 3.2s-5.6 6.3-5.6 10.2a5.6 5.6 0 0 0 11.2 0C17.6 9.5 12 3.2 12 3.2z" fill="${c}"/>`;
const PLANT = (c: string) => `<path d="M3.5 19.5V10l5 3V10l5 3V5.5h3v3h2v-3h2v14z" fill="${c}"/>`;
const HOME = (c: string) => `<path d="M12 4.2 4 10.8V20h5.6v-5.2h4.8V20H20v-9.2z" fill="${c}"/>`;

/** Delivery destination: brand-teal teardrop with a house. */
export const PIN_SVG = (color: string = MAP_COLORS.brand) =>
  `<svg viewBox="0 0 36 46" width="36" height="46" aria-hidden="true">` +
  `<path d="M18 44.5S33.5 29 33.5 17.6C33.5 8.7 26.6 1.5 18 1.5S2.5 8.7 2.5 17.6C2.5 29 18 44.5 18 44.5z" fill="${color}" stroke="#fff" stroke-width="2.6"/>` +
  `<circle cx="18" cy="17.4" r="9.6" fill="#fff"/>` +
  `<g transform="translate(9.6 9) scale(.7)">${HOME(color)}</g></svg>`;

/** Filling station (drop) or discharge site (plant) badge. */
export const SITE_SVG = (kind: "fill" | "discharge", size = 30) => {
  const c = kind === "fill" ? MAP_COLORS.DW : MAP_COLORS.WW;
  return (
    `<svg viewBox="0 0 30 30" width="${size}" height="${size}" aria-hidden="true">` +
    `<rect x="1.5" y="1.5" width="27" height="27" rx="8" fill="${c}" stroke="#fff" stroke-width="2.4"/>` +
    `<g transform="translate(4.2 4.2) scale(.9)">${kind === "fill" ? DROP("#fff") : PLANT("#fff")}</g></svg>`
  );
};

/** Tanker disc (map icon for the fleet maps): service colour, white ring, white truck. */
export const TANKER_ICON_SVG = (color: string, size = 34) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34" width="${size}" height="${size}">` +
  `<circle cx="17" cy="17" r="15" fill="${color}" stroke="#fff" stroke-width="2.6"/>` +
  `<g transform="translate(6.2 5.8) scale(.9)">${truckPath("#fff", color)}</g></svg>`;

/** Small heading arrow drawn above a tanker disc on the fleet maps. */
export const HEADING_ICON_SVG = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 10" width="14" height="10"><path d="M7 .8 13 9.2 7 7.2 1 9.2z" fill="${color}" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>`;

/** Delivery point (map icon for the fleet maps), coloured by service. */
export const ORDER_ICON_SVG = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 32" width="26" height="32">` +
  `<path d="M13 31S24.5 19.6 24.5 12.3C24.5 5.9 19.4 1.2 13 1.2S1.5 5.9 1.5 12.3C1.5 19.6 13 31 13 31z" fill="${color}" stroke="#fff" stroke-width="2.2"/>` +
  `<circle cx="13" cy="12.3" r="6.6" fill="#fff"/><g transform="translate(7.3 6.6) scale(.475)">${HOME(color)}</g></svg>`;

export const SITE_ICON_SVG = (kind: "fill" | "discharge") => SITE_SVG(kind, 26).replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');

/** Load an SVG string as an image for map.addImage (drawn at 2× for sharp icons). */
export function svgImage(svg: string, scale = 2): Promise<HTMLImageElement> {
  const sized = svg.replace(/width="(\d+(?:\.\d+)?)" height="(\d+(?:\.\d+)?)"/, (_, w, h) => `width="${Number(w) * scale}" height="${Number(h) * scale}"`);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  return img.decode().then(() => img);
}
