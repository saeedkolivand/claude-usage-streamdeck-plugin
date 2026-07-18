// usage-core.ts — data + rendering logic, no Stream Deck SDK dependency.
import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
export const DEFAULT_UA = "claude-code/2.0.31";
const CACHE_TTL_MS = 55_000;

export type UsageNode = { utilization: number; resets_at: string | null };
export type UsageData = {
  five_hour?: UsageNode | null;
  seven_day?: UsageNode | null;
  [k: string]: unknown;
};

export type FetchResult = { data: UsageData | null; error?: string; stale?: boolean };

// Module-level cache shared across all key instances in the plugin process,
// so 3-4 keys produce a single network call per minute, not 3-4.
let cache: { at: number; data: UsageData | null } = { at: 0, data: null };

// How old the cached data may get before a failing refresh is surfaced as
// stale. A single failed poll out of the 60s cadence self-heals within a
// minute and shouldn't flash the keys amber; once the numbers on screen are
// ~3 missed polls old, that's worth showing. Age-based on purpose: during an
// outage every visible key retries the fetch, so counting failures would
// scale with the number of keys, not with elapsed time.
const STALE_AFTER_MS = 3 * 60_000;

function failResult(error: string): FetchResult {
  return {
    data: cache.data,
    error,
    stale: cache.data != null && Date.now() - cache.at > STALE_AFTER_MS,
  };
}

export function credentialsPath(): string {
  // Windows: %USERPROFILE%\.claude\.credentials.json  (homedir() resolves USERPROFILE)
  // Linux:   ~/.claude/.credentials.json
  // macOS:   stored in Keychain instead (file fallback handled by caller if present)
  return join(homedir(), ".claude", ".credentials.json");
}

export function readToken(): { token?: string; expired?: boolean } {
  // macOS keeps the OAuth token in the login Keychain, not on disk.
  if (process.platform === "darwin") {
    const fromKeychain = readTokenFromKeychain();
    if (fromKeychain.token) return fromKeychain;
    // fall through to the file in case this machine also has one
  }
  return readTokenFromFile();
}

function parseCred(raw: string): { token?: string; expired?: boolean } {
  const j = JSON.parse(raw);
  const o = (j && j.claudeAiOauth) || {};
  const token: string | undefined = o.accessToken;
  const expiresAt = Number(o.expiresAt || 0);
  const expired = expiresAt > 0 && Date.now() > expiresAt;
  return { token, expired };
}

function readTokenFromFile(): { token?: string; expired?: boolean } {
  try {
    return parseCred(readFileSync(credentialsPath(), "utf8"));
  } catch {
    return {};
  }
}

function readTokenFromKeychain(): { token?: string; expired?: boolean } {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", timeout: 4000 },
    );
    return parseCred(out.trim());
  } catch {
    return {};
  }
}

export async function fetchUsage(ua: string, force = false): Promise<FetchResult> {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_TTL_MS) {
    return { data: cache.data };
  }
  const { token, expired } = readToken();
  if (!token) return failResult("no-token");
  // A token the credentials already mark as expired guarantees a 401 — skip
  // the request and wait for Claude Code to write a refreshed one.
  if (expired) return failResult("token-expired");

  try {
    const res = await fetch(ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        // Required: without a claude-code User-Agent the endpoint serves an
        // aggressively rate-limited bucket and returns persistent 429s.
        "User-Agent": ua || DEFAULT_UA,
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
      },
    });
    if (!res.ok) return failResult(`http-${res.status}`);
    const data = (await res.json()) as UsageData;
    cache = { at: now, data };
    return { data };
  } catch {
    return failResult("network");
  }
}

export const METRICS: Record<string, { label: string; key: keyof UsageData }> = {
  session: { label: "Session", key: "five_hour" },
  weekly: { label: "Weekly", key: "seven_day" },
};

export function pickMetric(
  data: UsageData | null,
  metric: string,
): { label: string; pct: number | null; resetsAt: string | null } {
  const m = METRICS[metric] || METRICS.session;
  const node = data ? (data[m.key] as UsageNode | null | undefined) : null;
  if (!node || typeof node.utilization !== "number") {
    return { label: m.label, pct: null, resetsAt: null };
  }
  return { label: m.label, pct: node.utilization, resetsAt: node.resets_at ?? null };
}

export function untilText(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  let s = Math.max(0, Math.floor((t - Date.now()) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function color(pct: number | null, warn: number, crit: number): string {
  if (pct == null) return "#6b7280"; // gray — no data
  if (pct >= crit) return "#ef4444"; // red
  if (pct >= warn) return "#f59e0b"; // amber
  return "#22c55e"; // green
}

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Rough Arial advance widths (in em) — enough to fit the title to the key width
// without measuring real glyphs. Narrow chars, the wide m/w/M/W, and capitals
// are grouped; everything else is treated as a mid-width glyph.
function textWidthEm(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (" fijltr.,:;'!|".includes(ch)) w += 0.3;
    else if ("mwMW".includes(ch)) w += 0.92;
    else if (ch >= "A" && ch <= "Z") w += 0.72;
    else w += 0.56;
  }
  return w;
}

export function svgKey(opts: {
  label: string;
  pct: number | null;
  note: string;
  col: string;
  stale: boolean;
}): string {
  const size = 144;
  const midX = size / 2; // 72 — canvas center, for the top title and wide status notes
  const cx = 50; // ring shifted left so the reset countdown gets its own column on the right
  const cy = 80; // ring center dropped a little so the title above still clears it
  const r = 35; // smaller ring frees a wider column on the right for the countdown
  const sw = 7; // thinner stroke → larger clear area inside for the number
  const circ = 2 * Math.PI * r;
  const p = opts.pct == null ? 0 : Math.max(0, Math.min(100, opts.pct));
  const dash = (p / 100) * circ;
  const pctText = opts.pct == null ? "--" : `${Math.round(opts.pct)}%`;
  // Shrink the number for 4-char values like "100%" so it always clears the ring.
  const pctSize = pctText.length >= 4 ? 16 : 20;
  const pctBaseline = cy + Math.round(pctSize * 0.34); // optical vertical centering
  // Countdown (and status notes) take the bright tone; the title takes the muted
  // gray — swapped from the obvious pairing so the remaining time reads first.
  const noteFill = opts.stale ? "#f59e0b" : "#e5e7eb";
  const titleFill = "#9ca3af";
  // Title and reset countdown share one "read-at-a-glance" size so the two pieces
  // of text on the key match. Fit the title by actual width, not character count,
  // so short custom titles keep the full size (matching the built-in "Session" /
  // "Weekly") and only a genuinely wide one steps down to stay inside the key.
  const glance = 21;
  let labelSize = glance;
  const labelW = textWidthEm(opts.label);
  while (labelSize > 12 && labelW * labelSize > 130) labelSize -= 1;

  // The note slot carries two very different strings: a short reset countdown
  // ("2h 14m", "4d 6h", "45m") on a live gauge, or a wider status word
  // ("open Claude", "offline", "n/a here", "--") when there's no data. Only the
  // countdown is narrow enough to sit beside the ring; place it there — big and
  // bold, stacked when it has two parts — and fall back to the old full-width
  // line under the ring for everything else, which stays readable.
  const isCountdown = /^(?:\d+d \d+h|\d+h \d+m|\d+m)$/.test(opts.note);
  let noteMarkup: string;
  if (isCountdown) {
    const cdSize = glance; // reset countdown matches the title size
    const asideX = 118; // center of the free column to the right of the ring
    const aside = (t: string, y: number) =>
      `<text x="${asideX}" y="${y}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${cdSize}" font-weight="700" fill="${noteFill}">${esc(t)}</text>`;
    const parts = opts.note.split(" ");
    noteMarkup =
      parts.length === 2
        ? `${aside(parts[0], cy - 5)}
  ${aside(parts[1], cy + 19)}`
        : aside(opts.note, cy + Math.round(cdSize * 0.34));
  } else {
    noteMarkup = `<text x="${midX}" y="134" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="${noteFill}">${esc(opts.note)}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="20" fill="#0f1216"/>
  <text x="${midX}" y="20" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${labelSize}" font-weight="700" fill="${titleFill}">${esc(opts.label)}</text>
  <g transform="rotate(-90 ${cx} ${cy})">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#3a4250" stroke-width="${sw}"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${opts.col}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${dash.toFixed(2)} ${circ.toFixed(2)}"/>
  </g>
  <text x="${cx}" y="${pctBaseline}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${pctSize}" font-weight="800" fill="#ffffff">${pctText}</text>
  ${noteMarkup}
</svg>`;
}

export function toDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Local-log metrics: tokens / cost parsed from Claude Code's JSONL transcripts.
//
// Caveat: Claude Code currently under-records input_tokens/output_tokens in the
// JSONL (a known upstream bug); cache token counts are accurate. For cost we
// therefore prefer the per-entry `costUSD` Claude Code writes, and only fall
// back to computing from tokens (which makes the estimate a lower bound). For
// subscription (Pro/Max) users this cost is notional "equivalent API spend",
// not an actual charge.
// ---------------------------------------------------------------------------

export type LogStats = {
  todayTokens: number;
  todayCost: number;
  weekTokens: number; // rolling last 7 days
  weekCost: number;
  sessionTokens: number;
  sessionCost: number;
  ok: boolean; // false when the projects directory can't be read
};

// $ per single token (list price / 1e6). Edit if Anthropic changes pricing.
const PRICING = {
  opus: { in: 5 / 1e6, out: 25 / 1e6, cr: 0.5 / 1e6, cw: 6.25 / 1e6 },
  opusLegacy: { in: 15 / 1e6, out: 75 / 1e6, cr: 1.5 / 1e6, cw: 18.75 / 1e6 },
  sonnet: { in: 3 / 1e6, out: 15 / 1e6, cr: 0.3 / 1e6, cw: 3.75 / 1e6 },
  haiku: { in: 1 / 1e6, out: 5 / 1e6, cr: 0.1 / 1e6, cw: 1.25 / 1e6 },
};

export type ModelFamily = "opus" | "opus-legacy" | "sonnet" | "haiku" | "unknown";

// Reduce whatever model id Claude Code recorded in its logs to just the family
// (e.g. "claude-opus-4-8-2026..." -> "opus"). Version-agnostic on purpose, so
// new releases within a family are picked up automatically without code changes.
export function modelFamily(model: string): ModelFamily {
  const m = (model || "").toLowerCase();
  if (m.includes("opus")) {
    // Opus 4.5–4.8+ (and any 5.x) use current pricing; Opus 4 / 4.0 / 4.1 cost more.
    return /opus-4-[5-9]/.test(m) || /opus-[5-9]/.test(m) ? "opus" : "opus-legacy";
  }
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "unknown";
}

export function rateFor(model: string): (typeof PRICING)["opus"] {
  switch (modelFamily(model)) {
    case "opus":
      return PRICING.opus;
    case "opus-legacy":
      return PRICING.opusLegacy;
    case "haiku":
      return PRICING.haiku;
    case "sonnet":
      return PRICING.sonnet;
    default:
      return PRICING.sonnet; // unknown / future family -> assume Sonnet-class
  }
}

export function computeCost(u: Record<string, unknown>, model: string): number {
  const r = rateFor(model);
  return (
    num(u.input_tokens, 0) * r.in +
    num(u.output_tokens, 0) * r.out +
    num(u.cache_read_input_tokens, 0) * r.cr +
    num(u.cache_creation_input_tokens, 0) * r.cw
  );
}

export function projectsDir(base?: string): string {
  return join(base || homedir(), ".claude", "projects");
}

let logCache: { at: number; data: LogStats } | null = null;
const LOG_TTL_MS = 30_000;

async function listJsonl(dir: string): Promise<{ path: string; mtime: number }[]> {
  const res: { path: string; mtime: number }[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return res;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      res.push(...(await listJsonl(full)));
    } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
      try {
        const s = await stat(full);
        res.push({ path: full, mtime: s.mtimeMs });
      } catch {
        /* skip unreadable file */
      }
    }
  }
  return res;
}

export async function getLogStats(force = false, baseDir?: string): Promise<LogStats> {
  const now = Date.now();
  if (!force && !baseDir && logCache && now - logCache.at < LOG_TTL_MS) {
    return logCache.data;
  }

  const out: LogStats = {
    todayTokens: 0,
    todayCost: 0,
    weekTokens: 0,
    weekCost: 0,
    sessionTokens: 0,
    sessionCost: 0,
    ok: true,
  };

  const files = await listJsonl(projectsDir(baseDir));
  if (files.length === 0) {
    // Could be "no logs yet" or "dir missing"; treat missing dir as not-ok.
    let dirExists = true;
    try {
      await stat(projectsDir(baseDir));
    } catch {
      dirExists = false;
    }
    out.ok = dirExists;
    if (!baseDir) logCache = { at: now, data: out };
    return out;
  }

  files.sort((a, b) => b.mtime - a.mtime); // newest first
  const sessionPath = files[0].path; // most-recently-active conversation
  const todayStr = new Date().toDateString();
  const startOfWeekMs = now - 7 * 86400 * 1000; // rolling 7-day window

  const seenToday = new Set<string>();
  const seenWeek = new Set<string>();
  const seenSession = new Set<string>();

  for (const f of files) {
    // We need files touched within the last 7 days (covers today + week);
    // always read the session file regardless of when it was last touched.
    if (f.mtime < startOfWeekMs && f.path !== sessionPath) continue;

    let text: string;
    try {
      text = await readFile(f.path, "utf8");
    } catch {
      continue;
    }

    for (const line of text.split("\n")) {
      if (!line) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e?.type !== "assistant" || !e?.message?.usage) continue;

      const u = e.message.usage as Record<string, unknown>;
      const model = (e.message.model as string) || "";
      const key: string = e.requestId || e.message.id || "";
      const tokens =
        num(u.input_tokens, 0) +
        num(u.output_tokens, 0) +
        num(u.cache_creation_input_tokens, 0) +
        num(u.cache_read_input_tokens, 0);
      const cost = typeof e.costUSD === "number" ? e.costUSD : computeCost(u, model);

      const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
      const isToday = !Number.isNaN(ts) && new Date(ts).toDateString() === todayStr;
      if (isToday) {
        const k = "t:" + key;
        if (!key || !seenToday.has(k)) {
          if (key) seenToday.add(k);
          out.todayTokens += tokens;
          out.todayCost += cost;
        }
      }

      const isThisWeek = !Number.isNaN(ts) && ts >= startOfWeekMs;
      if (isThisWeek) {
        const k = "w:" + key;
        if (!key || !seenWeek.has(k)) {
          if (key) seenWeek.add(k);
          out.weekTokens += tokens;
          out.weekCost += cost;
        }
      }

      if (f.path === sessionPath) {
        const k = "s:" + key;
        if (!key || !seenSession.has(k)) {
          if (key) seenSession.add(k);
          out.sessionTokens += tokens;
          out.sessionCost += cost;
        }
      }
    }
  }

  if (!baseDir) logCache = { at: now, data: out };
  return out;
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K";
  return String(Math.round(n));
}

export function fmtCost(n: number): string {
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "k";
  if (n >= 100) return "$" + n.toFixed(0);
  if (n >= 10) return "$" + n.toFixed(1);
  return "$" + n.toFixed(2);
}

// Stat tile: label on top, big value centered, scope subtitle below. No ring.
export function svgStat(opts: {
  label: string;
  value: string;
  sub: string;
  accent: string;
  stale: boolean;
}): string {
  const size = 144;
  const cx = 72;
  const len = opts.value.length;
  const valSize = len <= 4 ? 40 : len === 5 ? 34 : 28;
  const valBaseline = 82 + Math.round((40 - valSize) * 0.2);
  const noteFill = opts.stale ? "#f59e0b" : "#9ca3af";
  // Fit a custom title to the tile by width, mirroring svgKey, so a long override
  // doesn't overflow the canvas; the built-in "Tokens" / "Cost" stay at 18.
  let labelSize = 18;
  const labelW = textWidthEm(opts.label);
  while (labelSize > 12 && labelW * labelSize > 130) labelSize -= 1;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="20" fill="#0f1216"/>
  <text x="${cx}" y="34" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${labelSize}" font-weight="700" fill="#e5e7eb">${esc(opts.label)}</text>
  <rect x="${cx - 16}" y="42" width="32" height="3" rx="1.5" fill="${opts.accent}"/>
  <text x="${cx}" y="${valBaseline}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${valSize}" font-weight="800" fill="#ffffff">${esc(opts.value)}</text>
  <text x="${cx}" y="120" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="${noteFill}">${esc(opts.sub)}</text>
</svg>`;
}
