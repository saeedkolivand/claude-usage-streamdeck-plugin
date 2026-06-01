/**
 * Regenerates docs/preview.png from the *real* key faces in src/usage-core.ts, so the README banner
 * always matches what the device shows. Run with: `npm run preview`.
 *
 * Each readout is rendered by svgKey()/svgStat() (the same SVG the plugin sends to setImage); we
 * strip the outer <svg> wrapper, inline each into a wider single-row banner SVG, and rasterize to
 * PNG with sharp at 2x. Laid out exactly like the device: a row of 144px keys with gaps + padding.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { svgKey, svgStat, color } from "../src/usage-core";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "docs", "preview.png");

const ACCENT = "#d97757"; // Claude coral, used on the stat tiles (mirrors plugin.ts)
const WARN = 50;
const CRIT = 80; // default gauge thresholds, so colors match the real green→amber→red

// Representative sample values — a marketing banner, not live data. Single row of 7 faces:
// four live-limit gauges, then three local-log stat tiles, matching the plugin's two metric families.
const FACES: string[] = [
	svgKey({ label: "Session", pct: 33, note: "2h 14m", col: color(33, WARN, CRIT), stale: false }),
	svgKey({ label: "Weekly", pct: 61, note: "4d 6h", col: color(61, WARN, CRIT), stale: false }),
	svgKey({ label: "Opus 7d", pct: 84, note: "4d 6h", col: color(84, WARN, CRIT), stale: false }),
	svgKey({ label: "Sonn 7d", pct: 12, note: "4d 6h", col: color(12, WARN, CRIT), stale: false }),
	svgStat({ label: "Tokens", value: "1.2M", sub: "today", accent: ACCENT, stale: false }),
	svgStat({ label: "Cost", value: "$8.40", sub: "7 days", accent: ACCENT, stale: false }),
	svgStat({ label: "Tokens", value: "318K", sub: "session", accent: ACCENT, stale: false }),
];

const KEY = 144;
const GAP = 24;
const PAD = 36;
const SCALE = 2; // rasterize at 2x → 2448×432, the same banner footprint as a 7-key row
const W = PAD * 2 + FACES.length * KEY + (FACES.length - 1) * GAP;
const H = PAD * 2 + KEY;

/** Strip svgKey/svgStat's outer <svg> wrapper and re-place the body at (x, PAD). */
function placed(svg: string, x: number): string {
	const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
	return `<g transform="translate(${x}, ${PAD})">${inner}</g>`;
}

const keys = FACES.map((f, i) => placed(f, PAD + i * (KEY + GAP))).join("\n");
const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}">
<rect x="0" y="0" width="${W}" height="${H}" rx="28" fill="#06080f"/>
${keys}
</svg>`;

const png = await sharp(Buffer.from(banner)).png().toBuffer();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`Wrote ${out} (${W * SCALE}×${H * SCALE}px, ${(png.length / 1024).toFixed(0)} KB)`);
