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
} from "./usage-core";

type Settings = {
  metric?: string;
  warn?: number;
  crit?: number;
  userAgent?: string;
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

async function draw(act: any, s: Settings): Promise<void> {
  const metric = s.metric || "session";
  if (LOG_METRICS.has(metric)) return drawStat(act, metric);
  return drawGauge(act, s, metric);
}

async function drawGauge(act: any, s: Settings, metric: string): Promise<void> {
  const ua = (s.userAgent && s.userAgent.trim()) || DEFAULT_UA;
  const { data, error } = await fetchUsage(ua, false); // honors the shared cache
  const warn = num(s.warn, 50);
  const crit = num(s.crit, 80);

  if (!data) {
    const note =
      error === "no-token" ? "open Claude" : error === "network" ? "offline" : "…";
    await act.setImage(
      toDataUri(svgKey({ label: "Claude", pct: null, note, col: color(null, warn, crit), stale: true })),
    );
    return;
  }

  const { label, pct, resetsAt } = pickMetric(data, metric);
  const stale = !!error; // we have cached data but the latest refresh failed
  const note = pct == null ? "n/a here" : untilText(resetsAt);
  await act.setImage(
    toDataUri(svgKey({ label, pct, note, col: color(pct, warn, crit), stale })),
  );
}

async function drawStat(act: any, metric: string): Promise<void> {
  const stats = await getLogStats(false); // honors its own 30s cache
  if (!stats.ok) {
    await act.setImage(
      toDataUri(svgStat({ label: "Claude", value: "--", sub: "no logs", accent: ACCENT, stale: true })),
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
  await act.setImage(
    toDataUri(svgStat({ label, value, sub, accent: ACCENT, stale: false })),
  );
}

async function refreshAll(force: boolean): Promise<void> {
  // Refresh both data sources once, then repaint every visible key from cache.
  await Promise.allSettled([fetchUsage(DEFAULT_UA, force), getLogStats(force)]);
  for (const act of visible) {
    try {
      const s = (await act.getSettings()) as Settings;
      await draw(act, s);
    } catch {
      /* ignore a single bad key */
    }
  }
}

@action({ UUID: "com.local.claude-usage.meter" })
class UsageMeter extends SingletonAction<Settings> {
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

  override async onKeyDown(_ev: KeyDownEvent<Settings>): Promise<void> {
    await refreshAll(true); // tap any key = force-refresh all keys
  }
}

streamDeck.actions.registerAction(new UsageMeter());
streamDeck.connect();

// Populate shortly after connect, then poll once a minute.
setTimeout(() => refreshAll(false).catch(() => {}), 1500);
setInterval(() => refreshAll(false).catch(() => {}), 60_000);
