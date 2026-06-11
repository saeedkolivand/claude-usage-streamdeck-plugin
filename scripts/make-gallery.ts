/**
 * Generates one Marketplace gallery image per metric variant, from the *real* key faces in
 * src/usage-core.ts (the same SVG the plugin sends to setImage). Run with: `npm run gallery`.
 *
 * Unlike make-preview.ts (a single wide README banner), this writes individual PNGs to
 * docs/gallery/<slug>.png — one card per variant — sized for a Marketplace listing gallery.
 * Each card centers a single, scaled-up key face on a rounded background.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { svgKey, svgStat, color } from "../src/usage-core";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "docs", "gallery");

const ACCENT = "#d97757"; // Claude coral, used on the stat tiles (mirrors plugin.ts)
const WARN = 50;
const CRIT = 80; // default gauge thresholds, so colors match the real green→amber→red

// One entry per variant. slug → output filename; svg → the real rendered key face.
const VARIANTS: { slug: string; svg: string }[] = [
	{ slug: "session", svg: svgKey({ label: "Session", pct: 33, note: "2h 14m", col: color(33, WARN, CRIT), stale: false }) },
	{ slug: "weekly", svg: svgKey({ label: "Weekly", pct: 61, note: "4d 6h", col: color(61, WARN, CRIT), stale: false }) },
	{ slug: "opus-7d", svg: svgKey({ label: "Opus 7d", pct: 84, note: "4d 6h", col: color(84, WARN, CRIT), stale: false }) },
	{ slug: "sonnet-7d", svg: svgKey({ label: "Sonn 7d", pct: 12, note: "4d 6h", col: color(12, WARN, CRIT), stale: false }) },
	{ slug: "tokens-today", svg: svgStat({ label: "Tokens", value: "1.2M", sub: "today", accent: ACCENT, stale: false }) },
	{ slug: "cost-7d", svg: svgStat({ label: "Cost", value: "$8.40", sub: "7 days", accent: ACCENT, stale: false }) },
	{ slug: "tokens-session", svg: svgStat({ label: "Tokens", value: "318K", sub: "session", accent: ACCENT, stale: false }) },
];

const KEY = 144; // native key size
const FACE = 360; // drawn size of the key on the card (vector, stays crisp)
const PAD = 90; // background padding around the face
const CARD = FACE + PAD * 2; // logical card size (square)
const SCALE = 2; // rasterize at 2x → 1080×1080 per card
const FACTOR = FACE / KEY;

/** Strip svgKey/svgStat's outer <svg> wrapper and re-place the body, scaled + centered. */
function placed(svg: string): string {
	const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
	return `<g transform="translate(${PAD}, ${PAD}) scale(${FACTOR})">${inner}</g>`;
}

mkdirSync(outDir, { recursive: true });
for (const { slug, svg } of VARIANTS) {
	const card = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD * SCALE}" height="${CARD * SCALE}" viewBox="0 0 ${CARD} ${CARD}">
<rect x="0" y="0" width="${CARD}" height="${CARD}" rx="40" fill="#06080f"/>
${placed(svg)}
</svg>`;
	const png = await sharp(Buffer.from(card)).png().toBuffer();
	const out = join(outDir, `${slug}.png`);
	writeFileSync(out, png);
	console.log(`Wrote ${out} (${CARD * SCALE}×${CARD * SCALE}px, ${(png.length / 1024).toFixed(0)} KB)`);
}
