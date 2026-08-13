// plugin.ts — Stream Deck wiring around usage-core.
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
  discoverProfiles,
  resolveProfile,
  type Profile,
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
  svgBig,
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
  labelSession?: string; // carousel face label override (default "5 HOURS")
  labelWeekly?: string; // carousel face label override (default "WEEKLY")
  colorSession?: string; // carousel face base color override (default fuchsia)
  colorWeekly?: string; // carousel face base color override (default sky)
};

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
const FACES: {
  metric: string;
  label: string;
  accent: string;
  pctCol: string;
  noteCol: string;
  icon: "clock" | "calendar";
}[] = [
  // Fuchsia vs sky: ~100° of hue apart so the two windows never blur together
  // on the small LCD (violet vs sky proved too close side by side).
  { metric: "session", label: "5 HOURS", accent: "#e879f9", pctCol: "#f0abfc", noteCol: "#f5d0fe", icon: "clock" }, // fuchsia family
  { metric: "weekly", label: "WEEKLY", accent: "#38bdf8", pctCol: "#7dd3fc", noteCol: "#bae6fd", icon: "calendar" }, // sky family
];

// Blend a #rrggbb toward white by t (0..1) — derives the lighter family
// shades (% / countdown) from a user-picked base color.
function tint(hex: string, t: number): string {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return "#" + ch.map((v) => Math.round(v + (255 - v) * t).toString(16).padStart(2, "0")).join("");
}

// The face's palette: the preset family, or one derived from the per-key
// custom base color (tint ratios matched to the preset 400→300→200 steps).
function facePalette(f: (typeof FACES)[number], s: Settings): { accent: string; pctCol: string; noteCol: string } {
  const custom = ((f.metric === "session" ? s.colorSession : s.colorWeekly) || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(custom)) {
    return { accent: custom, pctCol: tint(custom, 0.38), noteCol: tint(custom, 0.65) };
  }
  return { accent: f.accent, pctCol: f.pctCol, noteCol: f.noteCol };
}

// Per-key carousel state (current face + auto-rotate timer), keyed by action id.
const carousel = new Map<string, { face: number; timer?: ReturnType<typeof setInterval> }>();

function carouselAuto(s: Settings): boolean {
  return String(s.carouselAuto) !== "false"; // default on; sdpi may store bool or string
}

// (Re)arm the auto-rotate timer to match the key's settings; tears everything
// down when the key is no longer a carousel.
function syncCarousel(act: any, s: Settings): void {
  const isCarousel = (s.metric || "session") === "carousel";
  const st = carousel.get(act.id);
  if (st?.timer) clearInterval(st.timer);
  if (!isCarousel) {
    carousel.delete(act.id);
    return;
  }
  const cur = st ?? { face: 0 };
  cur.timer = undefined;
  if (carouselAuto(s)) {
    const sec = Math.min(3600, Math.max(2, num(s.carouselSec, 10)));
    cur.timer = setInterval(() => {
      cur.face = (cur.face + 1) % FACES.length;
      draw(act, s).catch(() => {});
    }, sec * 1000);
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
  const metric = s.metric || "session";
  if (metric === "carousel") return drawCarousel(act, s);
  if (LOG_METRICS.has(metric)) return drawStat(act, s, metric);
  return drawGauge(act, s, metric);
}

async function drawCarousel(act: any, s: Settings): Promise<void> {
  const ua = (s.userAgent && s.userAgent.trim()) || DEFAULT_UA;
  const { data, error, stale } = await fetchUsage(ua, false, profileFor(s)); // per-profile cache
  const warn = num(s.warn, 50);
  const crit = num(s.crit, 80);
  const face = carousel.get(act.id)?.face ?? 0;
  const f = FACES[face % FACES.length];
  // Per-key label and color overrides for each face; empty = built-in default.
  const override = f.metric === "session" ? s.labelSession : s.labelWeekly;
  const label = (override || "").trim() || f.label;
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
          label, pct: null, note, col: color(null, warn, crit), stale: true,
          face, faces: FACES.length, accent: pal.accent, icon: f.icon, noteCol: pal.noteCol,
        }),
      ),
    );
    return;
  }

  const { pct, resetsAt } = pickMetric(data, f.metric);
  const note = pct == null ? "n/a here" : untilText(resetsAt);
  // Family tone while healthy; semantic amber/red once past the thresholds.
  const col = pct != null && pct >= warn ? color(pct, warn, crit) : pal.pctCol;
  await act.setImage(
    toDataUri(
      svgBig({
        label, pct, note, col, stale: !!stale,
        face, faces: FACES.length, accent: pal.accent, icon: f.icon, noteCol: pal.noteCol,
      }),
    ),
  );
}

async function drawGauge(act: any, s: Settings, metric: string): Promise<void> {
  const ua = (s.userAgent && s.userAgent.trim()) || DEFAULT_UA;
  const { data, error, stale } = await fetchUsage(ua, false, profileFor(s)); // per-profile cache
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
      toDataUri(svgKey({ label: title || "Claude", pct: null, note, col: color(null, warn, crit), stale: true })),
    );
    return;
  }

  const { label, pct, resetsAt } = pickMetric(data, metric);
  const note = pct == null ? "n/a here" : untilText(resetsAt);
  // stale comes from fetchUsage: cached data older than its debounce window,
  // not merely "the latest refresh failed" — a single blip stays bright.
  await act.setImage(
    toDataUri(svgKey({ label: title || label, pct, note, col: color(pct, warn, crit), stale: !!stale })),
  );
}

async function drawStat(act: any, s: Settings, metric: string): Promise<void> {
  const stats = await getLogStats(false, profileFor(s)?.configDir); // per-profile 30s cache
  const title = (s.title || "").trim(); // custom label; empty = use the metric default
  if (!stats.ok) {
    await act.setImage(
      toDataUri(svgStat({ label: title || "Claude", value: "--", sub: "no logs", accent: ACCENT, stale: true })),
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
    toDataUri(svgStat({ label: title || label, value, sub: subtitle || sub, accent: ACCENT, stale: false })),
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

  for (const [act, s] of pending) {
    try {
      await draw(act, s);
    } catch {
      /* ignore a single bad key */
    }
  }
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
    if (st?.timer) clearInterval(st.timer);
    carousel.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
    syncCarousel(ev.action, ev.payload.settings);
    await draw(ev.action, ev.payload.settings);
  }

  /** The property inspector is a sandboxed webview with no filesystem access,
   *  so the profile dropdown can't enumerate config dirs itself. sdpi-components
   *  asks for its options over this channel (`datasource="profiles"`). */
  override onSendToPlugin(ev: any): void {
    if (ev?.payload?.event !== "profiles") return;
    const items = discoverProfiles().map((p) => ({
      label: p.plan ? `${p.displayName} (${p.plan})` : p.displayName,
      value: p.configDir,
    }));
    streamDeck.ui.current?.sendToPropertyInspector({
      event: "profiles",
      // An empty list would leave the dropdown blank with no explanation.
      items: items.length ? items : [{ label: "No Claude data found", value: "" }],
    });
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const s = ev.payload.settings;
    if ((s.metric || "session") === "carousel") {
      // Tap = flip to the other face right away (from cache, so it's instant)
      // and restart the auto timer so it doesn't flip again a moment later.
      const st = carousel.get(ev.action.id) ?? { face: 0 };
      st.face = (st.face + 1) % FACES.length;
      carousel.set(ev.action.id, st);
      syncCarousel(ev.action, s);
      await draw(ev.action, s);
      return;
    }
    await refreshAll(true); // tap any other key = force-refresh all keys
  }
}

streamDeck.actions.registerAction(new UsageMeter());
streamDeck.connect();

// Populate shortly after connect, then poll once a minute.
setTimeout(() => refreshAll(false).catch(() => {}), 1500);
setInterval(() => refreshAll(false).catch(() => {}), 60_000);
