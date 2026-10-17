// MapLibre GL 6 loads its web worker from a URL next to the bundle, which
// Next's bundler doesn't emit. Serve it from /public instead.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("maplibre-gl/dist/maplibre-gl.css"));
mkdirSync("public", { recursive: true });
copyFileSync(join(dist, "maplibre-gl-worker.mjs"), join("public", "maplibre-gl-worker.mjs"));
