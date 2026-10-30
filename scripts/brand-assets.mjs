// Regenerates the icons from the logos in public/brand (cut from the official NWS
// and Aldar guides in Logo/): the web favicon and home-screen icon (app/), and the
// Android launcher icons and splash screens of both Capacitor apps.
// Usage: node scripts/brand-assets.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// sharp ships with Next.js; resolve it from the repo.
const sharp = createRequire(join(process.cwd(), "package.json"))("sharp");

const MARK = "public/brand/nws-mark.svg";
const LOGO = "public/brand/nws-logo.svg";
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

// An SVG drawn to fit inside a box of `fit` px, centred on a `size` px canvas.
async function centred(svg, width, height, fit, background, shape) {
  const art = await sharp(svg, { density: 1200 }).resize({ width: fit[0], height: fit[1], fit: "inside" }).png().toBuffer();
  const layers = [];
  if (shape) layers.push({ input: Buffer.from(shape(width, height)), left: 0, top: 0 });
  layers.push({ input: art, gravity: "center" });
  return sharp({ create: { width, height, channels: 4, background: shape ? CLEAR : background } }).composite(layers).png().toBuffer();
}
const square = (s, f = 0.62, background = CLEAR, shape) => centred(MARK, s, s, [Math.round(s * f), Math.round(s * f)], background, shape);
const rounded = (w, h) => `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${w * 0.2}" fill="#fff"/></svg>`;
const circle = (w, h) => `<svg width="${w}" height="${h}"><circle cx="${w / 2}" cy="${h / 2}" r="${w / 2}" fill="#fff"/></svg>`;

// .ico holding PNG images (supported by every current browser).
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

// ---- web: favicon.ico, icon.svg, apple-icon.png --------------------------------------
writeFileSync("app/favicon.ico", ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await square(size, 0.92) })))));
copyFileSync(MARK, "app/icon.svg");
writeFileSync("app/apple-icon.png", await square(180, 0.68, WHITE));
console.log("web: app/favicon.ico, app/icon.svg, app/apple-icon.png");

// ---- Android: launcher icons and splash screens --------------------------------------
const DENSITY = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const app of ["customer", "driver"]) {
  const res = join("mobile", app, "android", "app", "src", "main", "res");
  if (!existsSync(res)) continue;
  for (const [d, k] of Object.entries(DENSITY)) {
    const dir = join(res, `mipmap-${d}`);
    if (!existsSync(dir)) continue;
    writeFileSync(join(dir, "ic_launcher.png"), await square(48 * k, 0.64, CLEAR, rounded));
    writeFileSync(join(dir, "ic_launcher_round.png"), await square(48 * k, 0.58, CLEAR, circle));
    // Adaptive icon: 108dp canvas on the white ic_launcher_background; keep the mark in the 66dp safe zone.
    writeFileSync(join(dir, "ic_launcher_foreground.png"), await square(108 * k, 0.46));
  }
  for (const dir of readdirSync(res).filter((n) => n.startsWith("drawable"))) {
    const file = join(res, dir, "splash.png");
    if (!existsSync(file)) continue;
    const { width, height } = await sharp(readFileSync(file)).metadata();
    const w = Math.round(Math.min(width * 0.5, height * 0.42 * (322.3 / 190.1)));
    writeFileSync(file, await centred(LOGO, width, height, [w, height], WHITE));
  }
  console.log(`android ${app}: launcher icons and splash screens`);
}
