// usage-core.ts — data + rendering logic, no Stream Deck SDK dependency.
import {
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
export const DEFAULT_UA = "claude-code/2.0.31";
const CACHE_TTL_MS = 55_000;

export const TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
// Claude Code's public OAuth client id (verified as a string in the CLI binary).
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Longer than the 60s poll period on purpose: reusing the 55s fetch cooldown
// would let every tick POST a known-dead refresh token to the endpoint.
const REFRESH_COOLDOWN_MS = 5 * 60_000;
const refreshing = new Map<string, Promise<{ token?: string; expired?: boolean } | null>>();
const refreshFailedAt = new Map<string, number>();

export type UsageNode = { utilization: number; resets_at: string | null };
export type UsageData = {
  five_hour?: UsageNode | null;
  seven_day?: UsageNode | null;
  [k: string]: unknown;
};

export type FetchResult = { data: UsageData | null; error?: string; stale?: boolean };

// Cache shared across key instances so 3-4 keys produce a single network call
// per minute, not 3-4 — but keyed by profile. A single slot would let a key
// pointing at the work account serve its numbers to a key pointing at the
// personal one, silently, for the rest of the cache window.
type ApiCache = { at: number; data: UsageData | null };
const caches = new Map<string, ApiCache>();
function cacheFor(key: string): ApiCache {
  let entry = caches.get(key);
  if (!entry) {
    entry = { at: 0, data: null };
    caches.set(key, entry);
  }
  return entry;
}

// How old the cached data may get before a failing refresh is surfaced as
// stale. A single failed poll out of the 60s cadence self-heals within a
// minute and shouldn't flash the keys amber; once the numbers on screen are
// ~3 missed polls old, that's worth showing. Age-based on purpose: during an
// outage every visible key retries the fetch, so counting failures would
// scale with the number of keys, not with elapsed time.
const STALE_AFTER_MS = 3 * 60_000;

// After a failed attempt, hold off further automatic retries for a full cache
// window. Without this the failure path *raises* the request rate: a failure
// leaves cache.at untouched, so every visible key's redraw fires its own
// retry — exactly when the API is asking for less (rate limits, outages).
// A manual key tap passes force=true and still retries immediately.
const failures = new Map<string, { at: number; error: string }>();

function failResult(key: string, error: string): FetchResult {
  failures.set(key, { at: Date.now(), error });
  const cache = cacheFor(key);
  return {
    data: cache.data,
    error,
    stale: cache.data != null && Date.now() - cache.at > STALE_AFTER_MS,
  };
}

/// One Claude Code config directory, i.e. one logged-in account.
export type Profile = {
  configDir: string;
  isDefault: boolean;
  email?: string;
  organization?: string;
  plan?: string;
  displayName: string;
};

export function defaultConfigDir(home = homedir()): string {
  return join(home, ".claude");
}

/** Transcripts are the only thing that makes a directory worth reading.
 *  Deliberately not requiring .credentials.json: it can be relocated by
 *  CLAUDE_SECURESTORAGE_CONFIG_DIR, or live in the macOS Keychain or Windows
 *  Credential Manager with no file at all. */
export function isProfileDir(dir: string): boolean {
  try {
    return statSync(join(dir, "projects")).isDirectory();
  } catch {
    return false;
  }
}

/** Where the account identity lives, which depends on the profile.
 *
 *  A relocated profile keeps its global config *inside* the config dir; the
 *  default keeps it as a *sibling* — ~/.claude.json, not ~/.claude/.claude.json.
 *  The sibling branch is gated to the default on purpose: ~/.claude-work's
 *  parent is also ~, so applying it everywhere would stamp the default
 *  account's email onto every relocated profile. */
export function globalConfigPath(dir: string, isDefault: boolean): string | null {
  const candidates = [join(dir, ".config.json"), join(dir, ".claude.json")];
  if (isDefault) candidates.push(join(dirname(dir), ".claude.json"));
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** "default_claude_max_20x" -> "Max". Unrecognized stays undefined rather than
 *  putting a raw internal tier string in front of the user. */
export function planLabel(tier?: string): string | undefined {
  const t = (tier || "").toLowerCase();
  for (const name of ["enterprise", "team", "max", "pro", "free"]) {
    if (t.includes(name)) return name[0].toUpperCase() + name.slice(1);
  }
  return undefined;
}

function describeProfile(dir: string, isDefault: boolean): Profile {
  const p: Profile = {
    configDir: dir,
    isDefault,
    displayName: isDefault ? "Default" : (dir.split(/[\\/]/).pop() || dir),
  };
  const configPath = globalConfigPath(dir, isDefault);
  if (configPath) {
    try {
      const account = JSON.parse(readFileSync(configPath, "utf8"))?.oauthAccount || {};
      p.email = account.emailAddress || undefined;
      p.organization = account.organizationName || undefined;
      p.plan = planLabel(account.organizationRateLimitTier);
    } catch {
      /* a profile with no readable global config still has usable transcripts */
    }
  }
  if (p.email) p.displayName = `${p.displayName} — ${p.email}`;
  return p;
}

/** Every profile on this machine, default first. CLAUDE_CONFIG_DIR is honored
 *  when set, though the plugin runs as a child of the Stream Deck app and so
 *  rarely inherits a shell environment. */
export function discoverProfiles(extra: string[] = [], home = homedir()): Profile[] {
  const defaultDir = defaultConfigDir(home);
  const candidates: string[] = [];

  if (process.env.CLAUDE_CONFIG_DIR) candidates.push(process.env.CLAUDE_CONFIG_DIR);
  candidates.push(defaultDir);
  try {
    for (const name of readdirSync(home)) {
      if (name.startsWith(".claude")) candidates.push(join(home, name));
    }
  } catch {
    /* unreadable home: the default candidate still gets its chance */
  }
  candidates.push(...extra);

  const seen = new Set<string>();
  const out: Profile[] = [];
  for (const candidate of candidates) {
    const dir = resolve(candidate);
    if (seen.has(dir) || !isProfileDir(dir)) continue;
    seen.add(dir);
    out.push(describeProfile(dir, dir === resolve(defaultDir)));
  }
  return out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/** The profile a key is configured for, falling back to the default when its
 *  directory has since gone away. */
export function resolveProfile(configDir?: string, extra: string[] = []): Profile | null {
  const all = discoverProfiles(extra);
  if (configDir) {
    const match = all.find((p) => resolve(p.configDir) === resolve(configDir));
    if (match) return match;
  }
  return all[0] ?? null;
}

export function credentialsPath(configDir = defaultConfigDir()): string {
  return join(configDir, ".credentials.json");
}

/** File first, Keychain second — and the Keychain **only for the default
 *  profile**.
 *
 *  There is exactly one Keychain item, "Claude Code-credentials", with no
 *  per-profile variant. Falling back to it for a relocated profile would show
 *  another account's limit percentages under that profile's name: wrong, and
 *  invisibly so. */
export function readToken(profile?: Profile): { token?: string; expired?: boolean } {
  const dir = profile?.configDir ?? defaultConfigDir();
  const isDefault = profile ? profile.isDefault : true;

  const fromFile = readTokenFromFile(credentialsPath(dir));
  if (fromFile.token) return fromFile;

  if (process.platform === "darwin" && isDefault) return readTokenFromKeychain();
  return {};
}

function parseCred(raw: string): { token?: string; expired?: boolean } {
  const j = JSON.parse(raw);
  const o = (j && j.claudeAiOauth) || {};
  const token: string | undefined = o.accessToken;
  const expiresAt = Number(o.expiresAt || 0);
  const expired = expiresAt > 0 && Date.now() > expiresAt;
  return { token, expired };
}

function readTokenFromFile(path: string): { token?: string; expired?: boolean } {
  try {
    return parseCred(readFileSync(path, "utf8"));
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

/** Refresh the OAuth token ourselves instead of waiting for Claude Code.
 *
 *  Refresh tokens are single-use and rotate: the response carries a new one
 *  that supersedes ours server-side, so the rotated pair MUST be written back
 *  to .credentials.json or the CLI's next refresh fails and it gets logged
 *  out. Keychain-only setups (macOS default profile with no file) are skipped
 *  for the same reason — there is no file to persist the rotation to.
 *
 *  Returns null when refresh can't help; callers keep their readToken result
 *  so every existing failure render stays as it was. */
export async function refreshCredentials(
  profile?: Profile,
  force = false,
  badToken?: string,
): Promise<{ token?: string; expired?: boolean } | null> {
  const dir = profile?.configDir ?? defaultConfigDir();
  // One in-flight refresh per profile: two concurrent consumers of a
  // single-use rotating token would invalidate each other.
  const inflight = refreshing.get(dir);
  if (inflight) return inflight;
  if (!force && Date.now() - (refreshFailedAt.get(dir) ?? 0) < REFRESH_COOLDOWN_MS) {
    return null;
  }
  const job = doRefresh(credentialsPath(dir), badToken).then((r) => {
    if (r) refreshFailedAt.delete(dir);
    else refreshFailedAt.set(dir, Date.now());
    return r;
  });
  refreshing.set(dir, job);
  try {
    return await job;
  } finally {
    refreshing.delete(dir);
  }
}

async function doRefresh(
  path: string,
  badToken?: string,
): Promise<{ token?: string; expired?: boolean } | null> {
  // Read fresh rather than trusting the caller: another process (the CLI)
  // may have rotated the token since — its rotation supersedes ours, and a
  // POST with our stale copy is a guaranteed invalid_grant.
  let j: any;
  try {
    j = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const o = j?.claudeAiOauth;
  if (!o?.refreshToken) return null;
  const expiresAt = Number(o.expiresAt || 0);
  if (
    o.accessToken &&
    o.accessToken !== badToken &&
    !(expiresAt > 0 && Date.now() > expiresAt)
  ) {
    // The CLI already refreshed while we were deciding to — use its token.
    // badToken is the one the server just 401'd; a file still holding it is
    // not "already refreshed", however valid its expiresAt claims to be.
    return { token: o.accessToken, expired: false };
  }
  const rtExpiresAt = Number(o.refreshTokenExpiresAt || 0);
  if (rtExpiresAt > 0 && Date.now() > rtExpiresAt) return null;

  let body: any;
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": DEFAULT_UA },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: o.refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });
    if (!res.ok) {
      // invalid_grant here usually means a concurrent CLI session consumed
      // the token first and wrote fresh credentials — pick those up instead.
      const again = readTokenFromFile(path);
      return again.token && !again.expired ? again : null;
    }
    body = await res.json();
  } catch {
    return null;
  }
  const token: string | undefined = body?.access_token;
  if (!token) return null;

  // Merge the rotation into a fresh read so fields we don't know about —
  // and anything the CLI wrote meanwhile — survive the rewrite.
  let fresh: any = j;
  try {
    fresh = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  const target = (fresh.claudeAiOauth ||= {});
  target.accessToken = token;
  target.refreshToken = body.refresh_token || o.refreshToken;
  target.expiresAt = Date.now() + num(body.expires_in, 28800) * 1000;
  try {
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(fresh), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // The rotation is already consumed server-side; persisting non-atomically
    // beats losing it.
    try {
      writeFileSync(path, JSON.stringify(fresh), { mode: 0o600 });
    } catch {}
  }
  // The in-memory token is authoritative even if both writes failed: the old
  // access token may already be dead and the rotation is spent.
  return { token, expired: false };
}

export async function fetchUsage(
  ua: string,
  force = false,
  profile?: Profile,
): Promise<FetchResult> {
  const now = Date.now();
  const key = profile?.configDir ?? defaultConfigDir();
  const cache = cacheFor(key);
  const lastFail = failures.get(key);

  if (!force && cache.data && now - cache.at < CACHE_TTL_MS) {
    return { data: cache.data };
  }
  // Failure cooldown: serve the cache and the last error instead of retrying.
  if (!force && lastFail && now - lastFail.at < CACHE_TTL_MS) {
    return {
      data: cache.data,
      error: lastFail.error,
      stale: cache.data != null && now - cache.at > STALE_AFTER_MS,
    };
  }
  let cred = readToken(profile);
  // An expired or missing access token no longer waits for Claude Code to
  // write a refreshed one — refresh it ourselves from the rotating
  // refresh token.
  if (!cred.token || cred.expired) {
    cred = (await refreshCredentials(profile, force)) ?? cred;
  }
  if (!cred.token) return failResult(key, "no-token");
  if (cred.expired) return failResult(key, "token-expired");

  try {
    const get = (t: string) =>
      fetch(ENDPOINT, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${t}`,
          "anthropic-beta": "oauth-2025-04-20",
          // Required: without a claude-code User-Agent the endpoint serves an
          // aggressively rate-limited bucket and returns persistent 429s.
          "User-Agent": ua || DEFAULT_UA,
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, */*",
        },
      });
    let res = await get(cred.token);
    if (res.status === 401) {
      // The file said the token was valid but the server disagrees (clock
      // skew, revocation) — refresh once and retry.
      const r = await refreshCredentials(profile, force, cred.token);
      if (r?.token && r.token !== cred.token) res = await get(r.token);
    }
    if (!res.ok) return failResult(key, `http-${res.status}`);
    const data = (await res.json()) as UsageData;
    cache.at = now;
    cache.data = data;
    failures.delete(key);
    recordBurnSample(key, (data.five_hour as UsageNode | null | undefined)?.utilization, now);
    return { data };
  } catch {
    return failResult(key, "network");
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
  // Per-model weekly limit ("weekly_scoped" in the limits[] array) — reported
  // for the account's primary model on some plans, absent on others.
  if (metric === "model_weekly") {
    const limits = Array.isArray(data?.limits) ? (data!.limits as any[]) : [];
    const l = limits.find((x) => x?.kind === "weekly_scoped" && typeof x?.percent === "number");
    if (!l) return { label: "Model", pct: null, resetsAt: null };
    return {
      label: l.scope?.model?.display_name || "Model",
      pct: l.percent,
      resetsAt: l.resets_at ?? null,
    };
  }
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
  // Margins settled by side-by-side testing on hardware: the countdown ends a
  // fixed 6 units from the right edge, the ring's ink sits 3 from the left.
  // Deliberately unequal numbers that LOOK equal on a key: the ring is round —
  // only its equator reaches the margin — and its dark track all but vanishes
  // on LCDs, so the left gap reads far wider than it measures. The text is a
  // solid bright block and reads at face value.
  const cx = 41.5; // = 3 + outer radius 38.5
  const cy = 82; // gap title→ring top = gap ring bottom→key edge (A = B)
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
    // Right-anchored at a fixed edge so every line ends 6 units from the key
    // edge on any renderer — a centered anchor lets a wider host font grow the
    // text into the margin (seen on Stream Deck hardware), and drifts with the
    // text's width. Anchored, all values share one right edge.
    const edgeX = size - 6;
    const parts = opts.note.split(" ");
    const lines = parts.length === 2 ? parts : [opts.note];
    // Growing left from the fixed edge must never run into the ring: fit the
    // countdown so its widest line keeps ≥6 units of air to the ring's outer
    // stroke. Host fonts render wider than the design font, hence the 1.08 on
    // the width estimate. At the shipped margins this never triggers.
    const avail = edgeX - (cx + r + sw / 2) - 6;
    const widestEm = Math.max(...lines.map(textWidthEm)) * 1.08;
    let cdSize = glance;
    while (cdSize > 15 && widestEm * cdSize > avail) cdSize -= 1;
    const aside = (t: string, y: number) =>
      `<text x="${edgeX}" y="${y}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="${cdSize}" font-weight="700" fill="${noteFill}">${esc(t)}</text>`;
    noteMarkup =
      lines.length === 2
        ? `${aside(lines[0], cy - 5)}
  ${aside(lines[1], cy + 19)}`
        : aside(lines[0], cy + Math.round(cdSize * 0.34));
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
// cw = 5-minute cache write (1.25x input), cw1h = 1-hour cache write (2x input).
const PRICING = {
  opus: { in: 5 / 1e6, out: 25 / 1e6, cr: 0.5 / 1e6, cw: 6.25 / 1e6, cw1h: 10 / 1e6 },
  opusLegacy: { in: 15 / 1e6, out: 75 / 1e6, cr: 1.5 / 1e6, cw: 18.75 / 1e6, cw1h: 30 / 1e6 },
  sonnet: { in: 3 / 1e6, out: 15 / 1e6, cr: 0.3 / 1e6, cw: 3.75 / 1e6, cw1h: 6 / 1e6 },
  haiku: { in: 1 / 1e6, out: 5 / 1e6, cr: 0.1 / 1e6, cw: 1.25 / 1e6, cw1h: 2 / 1e6 },
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
  // cache_creation_input_tokens is the total; newer entries break it down in
  // the nested cache_creation object. 1h writes bill at 2x input, 5m at 1.25x —
  // without the split, 1h-heavy sessions (the CLI's default cache) read low.
  const cc = (u.cache_creation ?? {}) as Record<string, unknown>;
  const w1h = num(cc.ephemeral_1h_input_tokens, 0);
  const w5m = Math.max(0, num(u.cache_creation_input_tokens, 0) - w1h);
  return (
    num(u.input_tokens, 0) * r.in +
    num(u.output_tokens, 0) * r.out +
    num(u.cache_read_input_tokens, 0) * r.cr +
    w5m * r.cw +
    w1h * r.cw1h
  );
}

export function projectsDir(configDir = defaultConfigDir()): string {
  return join(configDir, "projects");
}

// Keyed by config dir for the same reason the API cache is.
const logCaches = new Map<string, { at: number; data: LogStats }>();
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

export async function getLogStats(force = false, configDir?: string): Promise<LogStats> {
  const now = Date.now();
  const key = configDir ?? defaultConfigDir();
  const logCache = logCaches.get(key);
  if (!force && logCache && now - logCache.at < LOG_TTL_MS) {
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

  const files = await listJsonl(projectsDir(key));
  if (files.length === 0) {
    // Could be "no logs yet" or "dir missing"; treat missing dir as not-ok.
    let dirExists = true;
    try {
      await stat(projectsDir(key));
    } catch {
      dirExists = false;
    }
    out.ok = dirExists;
    logCaches.set(key, { at: now, data: out });
    return out;
  }

  files.sort((a, b) => b.mtime - a.mtime); // newest first
  const sessionPath = files[0].path; // most-recently-active conversation
  const todayStr = new Date().toDateString();
  const startOfWeekMs = now - 7 * 86400 * 1000; // rolling 7-day window

  const seenToday = new Set<string>();
  const seenWeek = new Set<string>();
  const seenSession = new Set<string>();
  const seenDay = new Set<string>();
  const perDay: Record<string, DayStat> = {};

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
      if (!Number.isNaN(ts)) {
        const day = dayKey(ts);
        const kd = "d:" + day + ":" + key;
        if (!key || !seenDay.has(kd)) {
          if (key) seenDay.add(kd);
          const d = (perDay[day] ??= { tokens: 0, cost: 0 });
          d.tokens += tokens;
          d.cost += cost;
        }
      }
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

  // Persist per-day totals so charts survive Claude Code pruning old logs.
  writeHistory(key, mergeHistory(readHistory(key), perDay, dayKey(startOfWeekMs)));

  logCaches.set(key, { at: now, data: out });
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

// ---------------------------------------------------------------------------
// Burn rate: %/hour on the five-hour window, measured across this process's
// own readings. ponytail: in memory only — a plugin restart loses the rate for
// ~2 polls; persisting a number that is meaningless five minutes later isn't
// worth a file write per minute.
// ---------------------------------------------------------------------------
const burnSamples = new Map<string, { at: number; pct: number }[]>();
const BURN_WINDOW_MS = 30 * 60_000;
// The shortest gap worth measuring a slope across; below it one large turn
// reads as an implausible rate.
const BURN_MIN_GAP_MS = 120_000;

export function recordBurnSample(key: string, pct: unknown, now = Date.now()): void {
  if (typeof pct !== "number") return;
  let s = burnSamples.get(key);
  if (!s) burnSamples.set(key, (s = []));
  const last = s[s.length - 1];
  // A falling reading is the window turning over; everything before it
  // describes a window that no longer exists.
  if (last && pct < last.pct) s.length = 0;
  s.push({ at: now, pct });
  while (s.length && now - s[0].at > BURN_WINDOW_MS) s.shift();
}

/** Whole %/hour, or null when idle or there's not enough data yet. */
export function burnRate(key: string, now = Date.now()): number | null {
  const s = burnSamples.get(key) ?? [];
  const last = s[s.length - 1];
  const prev = s[s.length - 2];
  // Nothing since the last poll means nothing is burning right now — without
  // this the slope keeps decaying for half an hour after a session ends.
  if (!last || !prev || last.pct <= prev.pct) return null;
  const oldest = s.find((x) => now - x.at >= BURN_MIN_GAP_MS);
  if (!oldest) return null;
  const delta = last.pct - oldest.pct;
  const elapsedH = (last.at - oldest.at) / 3_600_000;
  if (delta <= 0 || elapsedH <= 0) return null;
  const rate = delta / elapsedH;
  return rate < 1 ? null : Math.round(rate);
}

/** "full ~2h 10m" projection from the current pct and rate; "" when unknowable. */
export function burnNote(pct: number | null, rate: number | null): string {
  if (pct == null || rate == null || rate <= 0 || pct >= 100) return "";
  const mins = Math.round(((100 - pct) / rate) * 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return "full ~" + (h > 0 ? `${h}h ${m}m` : `${m}m`);
}

// ---------------------------------------------------------------------------
// Daily history: per-day token/cost totals persisted outside the transcripts,
// so charts survive Claude Code pruning old JSONL files. One small JSON per
// profile in ~/.claude-usage/.
// ---------------------------------------------------------------------------
export type DayStat = { tokens: number; cost: number };
const HISTORY_CAP_DAYS = 400;

export function dataDir(home = homedir()): string {
  return join(home, ".claude-usage");
}

function historyPath(configDir: string): string {
  // Hash keeps one file per profile without leaking the path into a filename.
  const h = createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  return join(dataDir(), `history-${h}.json`);
}

export function readHistory(configDir: string): Record<string, DayStat> {
  try {
    const j = JSON.parse(readFileSync(historyPath(configDir), "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

/** Merge freshly-scanned days into the stored ones.
 *  Days inside the scan window are authoritative (the scan saw every file that
 *  feeds them); older days can only be partial re-reads of one session file,
 *  so those never shrink a stored total. */
export function mergeHistory(
  existing: Record<string, DayStat>,
  fresh: Record<string, DayStat>,
  windowStartDay: string,
): Record<string, DayStat> {
  const out: Record<string, DayStat> = { ...existing };
  for (const [day, v] of Object.entries(fresh)) {
    const old = out[day];
    out[day] =
      day >= windowStartDay || !old
        ? v
        : { tokens: Math.max(old.tokens, v.tokens), cost: Math.max(old.cost, v.cost) };
  }
  const days = Object.keys(out).sort();
  while (days.length > HISTORY_CAP_DAYS) delete out[days.shift()!];
  return out;
}

function writeHistory(configDir: string, days: Record<string, DayStat>): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(historyPath(configDir), JSON.stringify(days));
  } catch {
    /* history is best-effort */
  }
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Last `n` days (oldest first, today last) from a history map. */
export function lastDays(
  history: Record<string, DayStat>,
  n: number,
  now = Date.now(),
): DayStat[] {
  const out: DayStat[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(history[dayKey(now - i * 86400_000)] ?? { tokens: 0, cost: 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// stats.json export: everything the keys know, written once per poll for
// external consumers (OBS overlays, scripts). Best-effort by design.
// ---------------------------------------------------------------------------
export function writeStatsExport(
  entries: {
    profile: string;
    displayName?: string;
    usage: UsageData | null;
    stats: LogStats | null;
    burnRatePerHour: number | null;
  }[],
): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(
      join(dataDir(), "stats.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), profiles: entries }, null, 2),
    );
  } catch {
    /* export is best-effort */
  }
}

// Sparkline stat face: label on top, today's value big, a 7-bar week strip
// below it, scope note at the bottom. Bars normalize to the busiest day so the
// strip always uses its full height; zero days keep a 2px floor so the week's
// shape stays readable.
export function svgSpark(opts: {
  label: string;
  value: string;
  sub: string;
  bars: number[];
  accent: string;
  stale: boolean;
}): string {
  const size = 144;
  const cx = 72;
  const noteFill = opts.stale ? "#f59e0b" : "#9ca3af";
  const n = Math.max(1, opts.bars.length);
  const max = Math.max(...opts.bars, 1);
  const areaW = 108;
  const areaH = 30;
  const baseY = 116;
  const gap = 4;
  const barW = (areaW - gap * (n - 1)) / n;
  const x0 = cx - areaW / 2;
  const bars = opts.bars
    .map((v, i) => {
      const h = Math.max(2, Math.round((v / max) * areaH));
      const x = (x0 + i * (barW + gap)).toFixed(1);
      // Today (last bar) in the accent, the rest dimmed to keep focus.
      const fill = i === n - 1 ? opts.accent : "#4b5563";
      return `<rect x="${x}" y="${baseY - h}" width="${barW.toFixed(1)}" height="${h}" rx="1.5" fill="${fill}"/>`;
    })
    .join("");
  // Same tile chrome as svgStat (rounded #0f1216, Arial, accent underline) so a
  // chart key sits next to a stat key as one family.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="20" fill="#0f1216"/>
  <text x="${cx}" y="30" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="700" fill="#e5e7eb">${esc(opts.label)}</text>
  <rect x="${cx - 16}" y="38" width="32" height="3" rx="1.5" fill="${opts.accent}"/>
  <text x="${cx}" y="72" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="800" fill="#ffffff">${esc(opts.value)}</text>
  ${bars}
  <text x="${cx}" y="136" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="${noteFill}">${esc(opts.sub)}</text>
</svg>`;
}

// Big face for the carousel: icon + label on top in the face's signature
// accent, huge % centered (colored by the warn/crit thresholds), a slim
// progress bar, reset countdown below, page dots at the bottom. The accent
// gives each window its own identity; the % and bar keep the semantic
// green/amber/red so "how close to the limit" never changes meaning.
export type FaceIcon = "clock" | "calendar";

function iconMarkup(icon: FaceIcon, x: number, y: number, sizePx: number, stroke: string): string {
  // Icons drawn on a 16x16 grid, scaled to sizePx, stroke-only for crispness.
  const s = sizePx / 16;
  const g = (inner: string) =>
    `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
  if (icon === "clock") {
    return g(`<circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.6 1.8"/>`);
  }
  // calendar: body, binder tabs, header line
  return g(
    `<rect x="1.5" y="3" width="13" height="11.5" rx="2"/><path d="M5 1.5v3M11 1.5v3M1.5 7h13"/>`,
  );
}

export function svgBig(opts: {
  label: string;
  pct: number | null;
  note: string;
  col: string;
  stale: boolean;
  face?: number;
  faces?: number;
  accent?: string; // signature color of this face (label, icon, active dot)
  icon?: FaceIcon;
  noteCol?: string; // countdown tint (family shade); stale amber still wins
}): string {
  const size = 144;
  const cx = 72;
  const accent = opts.accent || "#9ca3af";
  const pctNum = opts.pct == null ? "--" : `${Math.round(opts.pct)}`;
  // "100" steps down so the number never touches the key edges.
  const pctSize = pctNum.length >= 3 ? 42 : 48;
  const symSize = Math.round(pctSize * 0.5); // % symbol reads as a unit, not a digit
  const pctBaseline = 80;
  const noteFill = opts.stale ? "#f59e0b" : opts.noteCol || "#e5e7eb";
  // Fit label and note by estimated width so wide strings ("open Claude")
  // shrink instead of overflowing; the 1.08 covers wider host fonts. The
  // header reserves room for the face icon beside the label when present.
  const iconSize = 17;
  const iconGap = 6;
  const headerAvail = opts.icon ? 132 - iconSize - iconGap : 132;
  let labelSize = 22;
  while (labelSize > 12 && textWidthEm(opts.label) * labelSize * 1.08 > headerAvail) labelSize -= 1;
  let noteSize = 25;
  while (noteSize > 13 && textWidthEm(opts.note) * noteSize * 1.08 > 132) noteSize -= 1;

  // Header: icon + label rendered as one centered group, both in the accent.
  let header: string;
  if (opts.icon) {
    const labelWpx = textWidthEm(opts.label) * labelSize;
    const startX = cx - (labelWpx + iconSize + iconGap) / 2;
    const iconY = 26 - labelSize * 0.36 - iconSize / 2; // optical middle of the cap height
    header =
      iconMarkup(opts.icon, startX, iconY, iconSize, accent) +
      `<text x="${startX + iconSize + iconGap}" y="26" text-anchor="start" font-family="Arial, Helvetica, sans-serif" font-size="${labelSize}" font-weight="700" fill="${accent}">${esc(opts.label)}</text>`;
  } else {
    header = `<text x="${cx}" y="26" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${labelSize}" font-weight="700" fill="${accent}">${esc(opts.label)}</text>`;
  }

  let dots = "";
  if (opts.faces && opts.faces > 1) {
    const gap = 14;
    const x0 = cx - ((opts.faces - 1) * gap) / 2;
    for (let i = 0; i < opts.faces; i++) {
      dots += `<circle cx="${x0 + i * gap}" cy="138" r="3.5" fill="${i === (opts.face ?? 0) ? accent : "#4b5563"}"/>`;
    }
  }

  // Slim progress bar between the % and the countdown: dark track always
  // visible, colored fill proportional to the percentage. rx stays smaller
  // than half the fill height so tiny fills (<7 units wide) still render.
  const barX = 22;
  const barW = size - 2 * barX; // 100
  const barY = 92;
  const barH = 14;
  const p = opts.pct == null ? 0 : Math.max(0, Math.min(100, opts.pct));
  const fillW = (p / 100) * barW;
  const bar =
    `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="${barH / 2}" fill="#2a313d"/>` +
    (fillW > 0
      ? `<rect x="${barX}" y="${barY}" width="${fillW.toFixed(1)}" height="${barH}" rx="${barH / 2}" fill="${opts.col}"/>`
      : "");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="20" fill="#0f1216"/>
  ${header}
  <text x="${cx}" y="${pctBaseline}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${pctSize}" font-weight="800" fill="${opts.col}">${esc(pctNum)}${opts.pct == null ? "" : `<tspan font-size="${symSize}" font-weight="700">%</tspan>`}</text>
  ${bar}
  <text x="${cx}" y="${opts.faces && opts.faces > 1 ? 129 : 131}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${noteSize}" font-weight="700" fill="${noteFill}">${esc(opts.note)}</text>
  ${dots}
</svg>`;
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
