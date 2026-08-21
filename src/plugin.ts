// plugin.ts — Stream Deck wiring around usage-core.
import { readFileSync, statSync } from "node:fs";
import streamDeck, {
  action,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type KeyDownEvent,
  type DidReceiveSettingsEvent,
} from "@elgato/streamdeck";

import {
  DEFAULT_UA,
  defaultConfigDir,
  discoverProfiles,
  resolveProfile,
  type Profile,
  type LogStats,
  fetchUsage,
  pickMetric,
  untilText,
  color,
  svgKey,
  toDataUri,
  num,
  getLogStats,
  fmtTokens,
  fmtCost,
  svgStat,
  type Face,
  carouselAuto,
  faceCount,
  faceOrder,
  faceSec,
  startFace,
  svgBig,
  svgBadge,
  svgSpark,
  svgDial,
  burnRate,
  burnNote,
  readHistory,
  lastDays,
  writeStatsExport,
} from "./usage-core";

type Settings = {
  metric?: string;
  profile?: string; // config dir of the Claude account this key reads; empty = default
  profilePath?: string; // a config dir discovery wouldn't find on its own
  warn?: number;
  crit?: number;
  userAgent?: string;
  title?: string; // optional custom key title; overrides the metric's default label
  subtitle?: string; // stat tiles: overrides the scope line ("today" / "7 days" / "session")
  carouselSec?: number; // seconds between automatic face switches (default 10)
  carouselAuto?: boolean; // false disables auto-rotate; key press still switches
  carouselStart?: string; // face shown on load: "session" (default) or "weekly"
  faceOrder?: string; // carousel faces to show, in order (comma-separated ids)
  badgeSec?: number; // seconds the badge face stays up; overrides the interval
  badgeLabel?: string; // optional caption under the badge; empty = mark alone
  badgeImage?: string; // path to a user-supplied image shown instead of the gauge
  labelSession?: string; // carousel face label override (default "5 HOURS")
  labelWeekly?: string; // carousel face label override (default "WEEKLY")
  labelModel?: string; // carousel face label override (default: the model's name)
  colorModel?: string; // carousel face base color override (default indigo)
  colorSession?: string; // carousel face base color override (default fuchsia)
  colorWeekly?: string; // carousel face base color override (default sky)
  alertFlash?: boolean; // false disables the key flash on crossing the Red threshold
  bg?: string; // background color for this key's faces (and the Deck+ strip)
  accentColor?: string; // identity accent (ticks, bars, icons) override
  textColor?: string; // big value / number color override
  labelColor?: string; // label and sub-line color override
};

/** A user color when it's a valid hex, else undefined (= built-in default). */
function hexOf(v?: string): string | undefined {
  const t = (v || "").trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(t) ? t : undefined;
}
const bgOf = (s: Settings) => hexOf(s.bg);
/** The four appearance overrides for the plain (non-carousel) faces. */
function themeOf(s: Settings): { bg?: string; fg?: string; muted?: string } {
  return { bg: hexOf(s.bg), fg: hexOf(s.textColor), muted: hexOf(s.labelColor) };
}

const ACCENT = "#d97757"; // Claude coral, used on stat tiles
const LOG_METRICS = new Set([
  "tokens_today",
  "cost_today",
  "tokens_week",
  "cost_week",
  "tokens_session",
  "cost_session",
]);

// Every visible key instance, so the refresh loop can repaint all of them.
const visible = new Set<any>();

// Carousel faces, in rotation order: window label + the metric it reads,
// plus each face's visual identity (signature accent + icon). The accent is
// deliberately distinct from the semantic green/amber/red of the % and bar.
// "Monochrome until the alarm": while below the warn threshold the whole face
// lives in its color family (accent 400 for header/dot, 300 for % and bar,
// 200 for the countdown); past warn/crit the % and bar switch to the semantic
// amber/red, which pops against the cool family tones.
// Blend a #rrggbb toward white by t (0..1) — derives the lighter family
// shades (% / countdown) from a user-picked base color.
function tint(hex: string, t: number): string {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return "#" + ch.map((v) => Math.round(v + (255 - v) * t).toString(16).padStart(2, "0")).join("");
}

/** This key's custom label for a face, if any. */
function faceLabelOf(f: Face, s: Settings): string | undefined {
  if (f.id === "session") return s.labelSession;
  if (f.id === "weekly") return s.labelWeekly;
  if (f.id === "model_weekly") return s.labelModel;
  return undefined;
}

/** This key's custom base color for a face, if any. */
function faceColorOf(f: Face, s: Settings): string | undefined {
  if (f.id === "session") return s.colorSession;
  if (f.id === "weekly") return s.colorWeekly;
  if (f.id === "model_weekly") return s.colorModel;
  return undefined;
}

// The face's palette: the preset family, or one derived from the per-key
// custom base color (tint ratios matched to the preset 400→300→200 steps).
function facePalette(f: Face, s: Settings): { accent: string; pctCol: string; noteCol: string } {
  const custom = (faceColorOf(f, s) || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(custom)) {
    return { accent: custom, pctCol: tint(custom, 0.38), noteCol: tint(custom, 0.65) };
  }
  return { accent: f.accent, pctCol: f.pctCol, noteCol: f.noteCol };
}

// Per-key carousel state (current face + auto-rotate timer), keyed by action id.
const carousel = new Map<
  string,
  { face: number; start?: string; timer?: ReturnType<typeof setTimeout> }
>();

// A user-supplied badge image, inlined as a data URI so it can go straight into
// the SVG. Cached by path + mtime + size: the carousel repaints on every
// rotation and on every refresh tick, and re-reading the file each time would
// be pure waste — but editing the picture in place still takes effect.
const MAX_BADGE_BYTES = 2 * 1024 * 1024; // a key is 144px; anything larger is a mistake
const badgeCache = new Map<string, { key: string; uri: string }>();
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function badgeImage(path?: string): string | undefined {
  const file = (path || "").trim();
  if (!file) return undefined;
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return undefined; // an unreadable pick falls back to the built-in mark
  try {
    const st = statSync(file);
    if (st.size > MAX_BADGE_BYTES) return undefined;
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = badgeCache.get(file);
    if (hit?.key === key) return hit.uri;
    const uri = `data:${mime};base64,${readFileSync(file).toString("base64")}`;
    badgeCache.set(file, { key, uri });
    return uri;
  } catch {
    return undefined; // missing file, no permission — draw the gauge instead
  }
}

// (Re)arm the auto-rotate timer to match the key's settings; tears everything
// down when the key is no longer a carousel.
function syncCarousel(act: any, s: Settings): void {
  const isCarousel = (s.metric || "session") === "carousel";
  const st = carousel.get(act.id);
  if (st?.timer) clearTimeout(st.timer);
  if (!isCarousel) {
    carousel.delete(act.id);
    return;
  }
  const cur = st ?? { face: startFace(s), start: s.carouselStart };
  // Changing the starting face in the inspector jumps the key there right away,
  // so the setting can be previewed without waiting for a rotation or a press.
  if (cur.start !== s.carouselStart) {
    cur.start = s.carouselStart;
    cur.face = startFace(s);
  }
  // Turning a face off while it is on screen would otherwise leave the key
  // parked on a face that no longer exists.
  if (cur.face >= faceCount(s)) cur.face = startFace(s);
  cur.timer = undefined;
  if (carouselAuto(s)) {
    // Faces hold for different lengths (the badge is a quick signature, the
    // numbers stay up longer), so each step schedules the next one itself
    // instead of running on one fixed interval.
    const step = () => {
      cur.face = (cur.face + 1) % faceCount(s);
      draw(act, s).catch(() => {});
      cur.timer = setTimeout(step, faceSec(s, cur.face) * 1000);
    };
    cur.timer = setTimeout(step, faceSec(s, cur.face) * 1000);
  }
  carousel.set(act.id, cur);
}

/** Which Claude account this key reads. Settings are per action instance, so
 *  one key can show work and the next personal. */
function profileFor(s: Settings): Profile | null {
  const extra = (s.profilePath || "").trim();
  return resolveProfile(s.profile, extra ? [extra] : []);
}

async function draw(act: any, s: Settings): Promise<void> {
  // Encoders (Stream Deck + dials) render to the touch strip, not a key face.
  if (typeof act.setFeedback === "function") return drawDial(act, s);
  const metric = s.metric || "session";
  if (metric === "carousel") return drawCarousel(act, s);
  if (metric === "burn") return drawBurn(act, s);
  if (metric.startsWith("hist_")) return drawHist(act, s, metric);
  if (LOG_METRICS.has(metric)) return drawStat(act, s, metric);
  return drawGauge(act, s, metric);
}

// Per-key above-Red latch: flash once on the way up, re-arm when the window
// resets. Keyed by action id + metric so a carousel face can't flap it.
const alerted = new Map<string, boolean>();

function maybeAlert(act: any, s: Settings, metricKey: string, pct: number | null, crit: number): void {
  if (String(s.alertFlash) === "false") return;
  const k = act.id + ":" + metricKey;
  const above = pct != null && pct >= crit;
  if (above && !alerted.get(k)) act.showAlert?.()?.catch?.(() => {});
  alerted.set(k, above);
}

async function drawBurn(act: any, s: Settings): Promise<void> {
  const ua = (s.userAgent && s.userAgent.trim()) || DEFAULT_UA;
  const p = profileFor(s);
  const { data, stale } = await fetchUsage(ua, false, p ?? undefined);
  const key = p?.configDir ?? defaultConfigDir();
  const pct = data ? pickMetric(data, "session").pct : null;
  const rate = burnRate(key);
  // The %/h slope needs the API's integer utilization to tick, which takes
  // minutes; until then show live token velocity from the logs so an active
  // session never reads as idle.
  const stats = await getLogStats(false, key);
  const tpm = stats.ok ? stats.burnTokensPerMin : 0;
  const title = (s.title || "").trim();
  const value = rate != null ? `${rate}%/h` : tpm > 0 ? `${fmtTokens(tpm)}/m` : "idle";
  const sub =
    (s.subtitle || "").trim() ||
    (rate != null ? burnNote(pct, rate) || "5h window" : tpm > 0 ? "tokens/min" : "5h window");
  await act.setImage(
    toDataUri(svgStat({ label: title || "Burn", value, sub, accent: hexOf(s.accentColor) || ACCENT, stale: !!stale, ...themeOf(s) })),
  );
}

async function drawHist(act: any, s: Settings, metric: string): Promise<void> {
  const p = profileFor(s);
  const dir = p?.configDir ?? defaultConfigDir();
  await getLogStats(false, dir); // refreshes today's totals and persists history
  const days = lastDays(readHistory(dir), 7);
  const cost = metric === "hist_cost";
  const bars = days.map((d) => (cost ? d.cost : d.tokens));
  const today = days[days.length - 1];
  const title = (s.title || "").trim();
  await act.setImage(
    toDataUri(
      svgSpark({
        label: title || (cost ? "Cost" : "Tokens"),
        value: cost ? fmtCost(today.cost) : fmtTokens(today.tokens),
        sub: (s.subtitle || "").trim() || "7 days",
        bars,
        accent: hexOf(s.accentColor) || ACCENT,
        stale: false,
        ...themeOf(s),
      }),
    ),
  );
}

// What a log metric shows, shared between key faces and the dial strip.
function statValue(stats: LogStats, metric: string): { label: string; value: string; sub: string } {
  switch (metric) {
    case "cost_today": return { label: "Cost", value: fmtCost(stats.todayCost), sub: "today" };
    case "tokens_week": return { label: "Tokens", value: fmtTokens(stats.weekTokens), sub: "7 days" };
    case "cost_week": return { label: "Cost", value: fmtCost(stats.weekCost), sub: "7 days" };
    case "tokens_session": return { label: "Tokens", value: fmtTokens(stats.sessionTokens), sub: "session" };
    case "cost_session": return { label: "Cost", value: fmtCost(stats.sessionCost), sub: "session" };
    default: return { label: "Tokens", value: fmtTokens(stats.todayTokens), sub: "today" };
  }
}

// Touch-strip identity accents: distinct hue per metric family, matching the
// carousel's fuchsia/sky pairing; burn takes flame orange, logs the coral.
const DIAL_ACCENTS: Record<string, string> = {
  session: "#e879f9",
  weekly: "#38bdf8",
  model_weekly: "#818cf8",
  burn: "#fb923c",
};

async function drawDial(act: any, s: Settings): Promise<void> {
  const metric = s.metric === "carousel" ? "session" : s.metric || "session";
  const p = profileFor(s);
  const ua = (s.userAgent && s.userAgent.trim()) || DEFAULT_UA;
  const dir = p?.configDir ?? defaultConfigDir();
  const title = (s.title || "").trim();
  const push = (o: Parameters<typeof svgDial>[0]) =>
    act.setFeedback({
      canvas: toDataUri(
        svgDial({ ...o, ...themeOf(s), accent: hexOf(s.accentColor) || o.accent }),
      ),
    });

  if (metric === "burn") {
    const { data, stale } = await fetchUsage(ua, false, p ?? undefined);
    const pct = data ? pickMetric(data, "session").pct : null;
    const rate = burnRate(dir);
    const stats = await getLogStats(false, dir);
    const tpm = stats.ok ? stats.burnTokensPerMin : 0;
    await push({
      label: title || "Burn",
      value: rate != null ? `${rate}%/h` : tpm > 0 ? `${fmtTokens(tpm)}/m` : "idle",
      sub: rate != null ? burnNote(pct, rate) || "5h window" : tpm > 0 ? "tokens/min" : "5h window",
      pct,
      col: DIAL_ACCENTS.burn,
      accent: DIAL_ACCENTS.burn,
      icon: "clock",
      stale: !!stale,
    });
    return;
  }
  if (LOG_METRICS.has(metric) || metric.startsWith("hist_")) {
    const stats = await getLogStats(false, dir);
    const base = metric.startsWith("hist_") ? metric.replace("hist_", "") + "_today" : metric;
    const m = statValue(stats, base);
    const cost = base.startsWith("cost");
    const bars = lastDays(readHistory(dir), 7).map((d) => (cost ? d.cost : d.tokens));
    await push({
      label: title || m.label,
      value: stats.ok ? m.value : "--",
      sub: stats.ok ? m.sub : "no logs",
      pct: null,
      col: ACCENT,
      accent: ACCENT,
      bars,
      stale: false,
    });
    return;
  }
  const { data, error, stale } = await fetchUsage(ua, false, p ?? undefined);
  const accent = DIAL_ACCENTS[metric] ?? DIAL_ACCENTS.session;
  const icon = metric === "session" ? ("clock" as const) : ("calendar" as const);
  if (!data) {
    await push({
      label: title || "Claude",
      value: "--",
      sub: error === "network" ? "offline" : "open Claude",
      pct: null,
      col: color(null, 50, 80),
      accent,
      icon,
      stale: true,
    });
    return;
  }
  const { label, pct, resetsAt } = pickMetric(data, metric);
  await push({
    label: title || label,
    value: pct == null ? "--" : `${Math.round(pct)}%`,
    sub: pct == null ? "n/a here" : untilText(resetsAt),
    pct,
    col: color(pct, num(s.warn, 50), num(s.crit, 80)),
    accent,
    icon,
    stale: !!stale,
  });
}

async function drawCarousel(act: any, s: Settings): Promise<void> {
  const ua = (s.userAgent && s.userAgent.trim()) || DEFAULT_UA;
  const { data, error, stale } = await fetchUsage(ua, false, profileFor(s) ?? undefined); // per-profile cache
  const warn = num(s.warn, 50);
  const crit = num(s.crit, 80);
  const order = faceOrder(s);
  const faces = order.length;
  const face = (carousel.get(act.id)?.face ?? startFace(s)) % faces;
  const f = order[face];
  // The badge face carries no metric — it's the signature between numbers.
  if (f.id === "badge") {
    await act.setImage(
      toDataUri(
        svgBadge({
          bg: bgOf(s),
          face,
          faces,
          label: (s.badgeLabel || "").trim(),
          image: badgeImage(s.badgeImage),
        }),
      ),
    );
    return;
  }
  // Per-key label and color overrides for each face; empty = built-in default.
  const label = (faceLabelOf(f, s) || "").trim() || f.label;
  const pal = facePalette(f, s);

  if (!data) {
    const note =
      error === "no-token" || error === "token-expired"
        ? "open Claude"
        : error === "network"
          ? "offline"
          : "…";
    await act.setImage(
      toDataUri(
        svgBig({
          label, pct: null, note, col: color(null, warn, crit), stale: true, bg: bgOf(s),
          face, faces, accent: pal.accent, icon: f.icon, noteCol: pal.noteCol,
        }),
      ),
    );
    return;
  }

  const { label: apiLabel, pct, resetsAt } = pickMetric(data, f.metric);
  maybeAlert(act, s, f.metric, pct, crit);
  // The model face is named by the API after the account's model ("Fable"),
  // which beats a generic "MODEL" — a custom label still wins over both.
  const shown =
    f.id === "model_weekly" && !(faceLabelOf(f, s) || "").trim() && apiLabel
      ? apiLabel.toUpperCase()
      : label;
  const note = pct == null ? "n/a here" : untilText(resetsAt);
  // Family tone while healthy; semantic amber/red once past the thresholds.
  const col = pct != null && pct >= warn ? color(pct, warn, crit) : pal.pctCol;
  await act.setImage(
    toDataUri(
      svgBig({
        label: shown, pct, note, col, stale: !!stale, bg: bgOf(s),
        face, faces, accent: pal.accent, icon: f.icon, noteCol: pal.noteCol,
      }),
    ),
  );
}

async function drawGauge(act: any, s: Settings, metric: string): Promise<void> {
  const ua = (s.userAgent && s.userAgent.trim()) || DEFAULT_UA;
  const { data, error, stale } = await fetchUsage(ua, false, profileFor(s) ?? undefined); // per-profile cache
  const warn = num(s.warn, 50);
  const crit = num(s.crit, 80);
  const title = (s.title || "").trim(); // custom label; empty = use the metric default

  if (!data) {
    const note =
      error === "no-token" || error === "token-expired"
        ? "open Claude"
        : error === "network"
          ? "offline"
          : "…";
    await act.setImage(
      toDataUri(svgKey({ label: title || "Claude", pct: null, note, col: color(null, warn, crit), stale: true, ...themeOf(s) })),
    );
    return;
  }

  const { label, pct, resetsAt } = pickMetric(data, metric);
  maybeAlert(act, s, metric, pct, crit);
  const note = pct == null ? "n/a here" : untilText(resetsAt);
  // stale comes from fetchUsage: cached data older than its debounce window,
  // not merely "the latest refresh failed" — a single blip stays bright.
  await act.setImage(
    toDataUri(svgKey({ label: title || label, pct, note, col: color(pct, warn, crit), stale: !!stale, ...themeOf(s) })),
  );
}

async function drawStat(act: any, s: Settings, metric: string): Promise<void> {
  const stats = await getLogStats(false, profileFor(s)?.configDir); // per-profile 30s cache
  const title = (s.title || "").trim(); // custom label; empty = use the metric default
  if (!stats.ok) {
    await act.setImage(
      toDataUri(svgStat({ label: title || "Claude", value: "--", sub: "no logs", accent: hexOf(s.accentColor) || ACCENT, stale: true, ...themeOf(s) })),
    );
    return;
  }

  let label = "Tokens";
  let value = "--";
  let sub = "today";
  if (metric === "tokens_today") {
    label = "Tokens"; value = fmtTokens(stats.todayTokens); sub = "today";
  } else if (metric === "cost_today") {
    label = "Cost"; value = fmtCost(stats.todayCost); sub = "today";
  } else if (metric === "tokens_week") {
    label = "Tokens"; value = fmtTokens(stats.weekTokens); sub = "7 days";
  } else if (metric === "cost_week") {
    label = "Cost"; value = fmtCost(stats.weekCost); sub = "7 days";
  } else if (metric === "tokens_session") {
    label = "Tokens"; value = fmtTokens(stats.sessionTokens); sub = "session";
  } else if (metric === "cost_session") {
    label = "Cost"; value = fmtCost(stats.sessionCost); sub = "session";
  }
  const subtitle = (s.subtitle || "").trim(); // custom scope line; empty = default
  await act.setImage(
    toDataUri(svgStat({ label: title || label, value, sub: subtitle || sub, accent: hexOf(s.accentColor) || ACCENT, stale: false, ...themeOf(s) })),
  );
}

async function refreshAll(force: boolean): Promise<void> {
  // Refresh each data source once per *distinct profile* in play, then repaint
  // every visible key from cache. Four keys on one account still make one call;
  // two accounts make two.
  const pending: [any, Settings][] = [];
  const profiles = new Map<string, { p: Profile | null; ua: string }>();

  for (const act of visible) {
    try {
      const s = (await act.getSettings()) as Settings;
      pending.push([act, s]);
      const p = profileFor(s);
      const key = p?.configDir ?? "";
      // Poll with the profile's custom User-Agent (first key that sets one
      // wins). Priming the cache with DEFAULT_UA here would mean a per-key UA
      // never reaches the network — the draw path always hits this cache.
      const ua = (s.userAgent || "").trim();
      const cur = profiles.get(key);
      if (!cur) profiles.set(key, { p, ua: ua || DEFAULT_UA });
      else if (cur.ua === DEFAULT_UA && ua) cur.ua = ua;
    } catch {
      /* ignore a single bad key */
    }
  }

  await Promise.allSettled(
    [...profiles.values()].flatMap(({ p, ua }) => [
      fetchUsage(ua, force, p ?? undefined),
      getLogStats(force, p?.configDir),
    ]),
  );

  // Everything the keys know, exported for scripts/overlays. Cache hits only —
  // the fetches above already populated every profile's caches.
  try {
    const entries = [];
    for (const { p, ua } of profiles.values()) {
      const dir = p?.configDir ?? defaultConfigDir();
      const u = await fetchUsage(ua, false, p ?? undefined);
      const st = await getLogStats(false, dir);
      entries.push({
        profile: dir,
        displayName: p?.displayName,
        usage: u.data,
        stats: st.ok ? st : null,
        burnRatePerHour: burnRate(dir),
      });
    }
    writeStatsExport(entries);
  } catch {
    /* export is best-effort */
  }

  for (const [act, s] of pending) {
    try {
      await draw(act, s);
    } catch {
      /* ignore a single bad key */
    }
  }
}

/** The property inspector is a sandboxed webview with no filesystem access,
 *  so the profile dropdown can't enumerate config dirs itself. sdpi-components
 *  asks for its options over this channel (`datasource="profiles"`). */
function sendProfiles(ev: any): void {
  if (ev?.payload?.event !== "profiles") return;
  const items = discoverProfiles().map((p) => ({
    label: p.plan ? `${p.displayName} (${p.plan})` : p.displayName,
    value: p.configDir,
  }));
  streamDeck.ui.sendToPropertyInspector({
    event: "profiles",
    // An empty list would leave the dropdown blank with no explanation.
    items: items.length ? items : [{ label: "No Claude data found", value: "" }],
  });
}

@action({ UUID: "com.saeedkolivand.claude-usage.meter" })
class UsageMeter extends SingletonAction<Settings> {
  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    visible.add(ev.action);
    syncCarousel(ev.action, ev.payload.settings);
    await draw(ev.action, ev.payload.settings);
  }

  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    visible.delete(ev.action);
    const st = carousel.get(ev.action.id);
    if (st?.timer) clearTimeout(st.timer);
    carousel.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
    syncCarousel(ev.action, ev.payload.settings);
    await draw(ev.action, ev.payload.settings);
  }

  override onSendToPlugin(ev: any): void {
    sendProfiles(ev);
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const s = ev.payload.settings;
    if ((s.metric || "session") === "carousel") {
      // Tap = flip to the other face right away (from cache, so it's instant)
      // and restart the auto timer so it doesn't flip again a moment later.
      const st = carousel.get(ev.action.id) ?? { face: startFace(s), start: s.carouselStart };
      st.face = (st.face + 1) % faceCount(s);
      carousel.set(ev.action.id, st);
      syncCarousel(ev.action, s);
      await draw(ev.action, s);
      return;
    }
    await refreshAll(true); // tap any other key = force-refresh all keys
  }
}

// Stream Deck + dial: the touch strip shows the metric, turning cycles
// through them, pressing forces a refresh of every key.
const DIAL_METRICS = ["session", "weekly", "model_weekly", "burn", "tokens_today", "cost_today"];

@action({ UUID: "com.saeedkolivand.claude-usage.dial" })
class UsageDial extends SingletonAction<Settings> {
  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    visible.add(ev.action);
    await draw(ev.action, ev.payload.settings);
  }

  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    visible.delete(ev.action);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
    await draw(ev.action, ev.payload.settings);
  }

  override onSendToPlugin(ev: any): void {
    sendProfiles(ev);
  }

  override async onDialRotate(ev: any): Promise<void> {
    const s = (ev.payload?.settings ?? {}) as Settings;
    const cur = Math.max(0, DIAL_METRICS.indexOf(s.metric || "session"));
    const step = (ev.payload?.ticks ?? 1) > 0 ? 1 : DIAL_METRICS.length - 1;
    const next = { ...s, metric: DIAL_METRICS[(cur + step) % DIAL_METRICS.length] };
    await ev.action.setSettings(next);
    await draw(ev.action, next);
  }

  override async onDialDown(): Promise<void> {
    await refreshAll(true);
  }

  override async onTouchTap(): Promise<void> {
    await refreshAll(true);
  }
}

streamDeck.actions.registerAction(new UsageMeter());
streamDeck.actions.registerAction(new UsageDial());
streamDeck.connect();

// Populate shortly after connect, then poll once a minute.
setTimeout(() => refreshAll(false).catch(() => {}), 1500);
setInterval(() => refreshAll(false).catch(() => {}), 60_000);
