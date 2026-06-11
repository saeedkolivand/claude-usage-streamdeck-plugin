/**
 * Generates Elgato Marketplace listing media at the exact required dimensions,
 * from the *real* key faces in src/usage-core.ts. Run with: `npm run marketplace`.
 *
 *   docs/marketplace/icon.png        288 x 288   (1:1)
 *   docs/marketplace/thumbnail.png   1920 x 960  (2:1)
 *   docs/marketplace/gallery-1.png   1920 x 960  (2:1)  — limits
 *   docs/marketplace/gallery-2.png   1920 x 960  (2:1)  — tokens & cost
 *   docs/marketplace/gallery-3.png   1920 x 960  (2:1)  — full row
 *
 * Maker Console requires a 1:1 icon, a 2:1 thumbnail, and at least 3 gallery
 * images at 2:1. These compose the device-accurate key SVGs onto branded canvases.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { svgKey, svgStat, color } from "../src/usage-core";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, "docs", "marketplace");
mkdirSync(outDir, { recursive: true });

const ACCENT = "#d97757";
const WARN = 50;
const CRIT = 80;
const BG = "#06080f";
const MUTED = "#9aa0aa";
const FONT = "Arial, Helvetica, sans-serif";
const KEY = 144; // native key size

const GAUGES = [
  svgKey({ label: "Session", pct: 33, note: "2h 14m", col: color(33, WARN, CRIT), stale: false }),
  svgKey({ label: "Weekly", pct: 61, note: "4d 6h", col: color(61, WARN, CRIT), stale: false }),
  svgKey({ label: "Opus 7d", pct: 84, note: "4d 6h", col: color(84, WARN, CRIT), stale: false }),
  svgKey({ label: "Sonn 7d", pct: 12, note: "4d 6h", col: color(12, WARN, CRIT), stale: false }),
];
const STATS = [
  svgStat({ label: "Tokens", value: "1.2M", sub: "today", accent: ACCENT, stale: false }),
  svgStat({ label: "Cost", value: "$8.40", sub: "7 days", accent: ACCENT, stale: false }),
  svgStat({ label: "Tokens", value: "318K", sub: "session", accent: ACCENT, stale: false }),
];

/** Strip the key SVG's outer wrapper and place its body at (x,y), scaled. */
function place(svg: string, x: number, y: number, scale: number): string {
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return `<g transform="translate(${x}, ${y}) scale(${scale})">${inner}</g>`;
}

/** Lay out a row of faces centered horizontally, returning the placed SVG groups. */
function row(faces: string[], size: number, gap: number, yTop: number, W: number): string {
  const scale = size / KEY;
  const total = faces.length * size + (faces.length - 1) * gap;
  let x = (W - total) / 2;
  const out: string[] = [];
  for (const f of faces) {
    out.push(place(f, x, yTop, scale));
    x += size + gap;
  }
  return out.join("\n");
}

function text(x: number, y: number, s: string, size: number, weight: number, fill: string, spacing = 0): string {
  return `<text x="${x}" y="${y}" text-anchor="middle" font-family="${FONT}" font-size="${size}" font-weight="${weight}" letter-spacing="${spacing}" fill="${fill}">${s}</text>`;
}

async function render(name: string, W: number, H: number, body: string): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${BG}"/>
${body}
</svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const out = join(outDir, name);
  writeFileSync(out, png);
  console.log(`Wrote ${out} (${W}x${H}, ${(png.length / 1024).toFixed(0)} KB)`);
}

const W = 1920;
const H = 960;

// Icon — resize the high-res plugin icon to the required 288x288.
const iconSrc = join(root, "com.saeedkolivand.claude-usage.sdPlugin", "imgs", "plugin-icon@2x.png");
await sharp(iconSrc).resize(288, 288).png().toBuffer().then((buf) => {
  writeFileSync(join(outDir, "icon.png"), buf);
  console.log(`Wrote ${join(outDir, "icon.png")} (288x288, ${(buf.length / 1024).toFixed(0)} KB)`);
});

// Thumbnail — branded hero with the full row of keys.
await render(
  "thumbnail.png",
  W,
  H,
  [
    text(W / 2, 250, "AI Coding Usage Meter", 78, 800, "#ffffff"),
    text(W / 2, 312, "Live limits, tokens &amp; cost — right on your Stream Deck", 32, 400, MUTED),
    row([...GAUGES, ...STATS], 184, 26, 430, W),
    text(W / 2, 800, "Windows &amp; macOS   ·   Free &amp; open source   ·   Works with Claude Code", 26, 600, MUTED, 0.5),
  ].join("\n")
);

// Gallery 1 — limits.
await render(
  "gallery-1.png",
  W,
  H,
  [
    text(W / 2, 175, "LIMITS", 26, 700, ACCENT, 3),
    text(W / 2, 248, "Session &amp; weekly, color-coded", 60, 800, "#ffffff"),
    row(GAUGES, 300, 56, 380, W),
    text(W / 2, 800, "Green → amber → red, with a live reset countdown", 28, 400, MUTED),
  ].join("\n")
);

// Gallery 2 — tokens & cost.
await render(
  "gallery-2.png",
  W,
  H,
  [
    text(W / 2, 175, "TOKENS &amp; COST", 26, 700, ACCENT, 3),
    text(W / 2, 248, "Counted from your own logs", 60, 800, "#ffffff"),
    row(STATS, 320, 70, 380, W),
    text(W / 2, 800, "Today, the last 7 days, or your current session — per key", 28, 400, MUTED),
  ].join("\n")
);

// Gallery 3 — full row.
await render(
  "gallery-3.png",
  W,
  H,
  [
    text(W / 2, 175, "ONE ACTION", 26, 700, ACCENT, 3),
    text(W / 2, 248, "As many keys as you like", 60, 800, "#ffffff"),
    row([...GAUGES, ...STATS], 184, 26, 410, W),
    text(W / 2, 800, "All keys share one cached request · tap any key to refresh", 28, 400, MUTED),
  ].join("\n")
);
