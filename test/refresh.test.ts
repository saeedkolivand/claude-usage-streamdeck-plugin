// Run with: npm test
//
// Covers the OAuth refresh path: an expired access token is refreshed with
// the rotating refresh token, and the rotation is written back so the CLI
// stays logged in. Refreshing without writing back is the failure mode that
// silently logs the CLI out — the write-back assertions are the point.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ENDPOINT,
  TOKEN_ENDPOINT,
  burnNote,
  burnRate,
  computeCost,
  credentialsPath,
  dayKey,
  fetchUsage,
  lastDays,
  mergeHistory,
  pickMetric,
  recordBurnSample,
  refreshCredentials,
  type Profile,
} from "../src/usage-core";

let home: string;
const realFetch = globalThis.fetch;

// Fresh config dir per profile: every cache in usage-core is keyed by
// configDir, so distinct dirs give test isolation for free.
let n = 0;
function makeProfile(creds: Record<string, unknown>): Profile {
  const dir = join(home, `p${n++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(credentialsPath(dir), JSON.stringify({ claudeAiOauth: creds }));
  return { configDir: dir, isDefault: false, displayName: "test" };
}

function readCreds(p: Profile): Record<string, any> {
  return JSON.parse(readFileSync(credentialsPath(p.configDir), "utf8")).claudeAiOauth;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const USAGE = { five_hour: { utilization: 42, resets_at: null } };

type Router = (url: string, init?: RequestInit) => Response;
let route: Router;

before(() => {
  home = mkdtempSync(join(tmpdir(), "claude-usage-refresh-"));
  globalThis.fetch = ((url: unknown, init?: RequestInit) =>
    Promise.resolve(route(String(url), init))) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  rmSync(home, { recursive: true, force: true });
});

describe("token refresh", () => {
  test("an expired token is refreshed and the rotation persisted", async () => {
    const p = makeProfile({
      accessToken: "at-old",
      refreshToken: "rt-old",
      expiresAt: Date.now() - 1000,
      subscriptionType: "max",
    });
    let refreshBody: any;
    route = (url, init) => {
      if (url === TOKEN_ENDPOINT) {
        refreshBody = JSON.parse(String(init?.body));
        return json(200, { access_token: "at-new", refresh_token: "rt-new", expires_in: 28800 });
      }
      assert.equal(url, ENDPOINT);
      assert.equal((init?.headers as any).Authorization, "Bearer at-new");
      return json(200, USAGE);
    };

    const res = await fetchUsage("", true, p);
    assert.equal(res.error, undefined);
    assert.equal(res.data?.five_hour?.utilization, 42);
    assert.equal(refreshBody.grant_type, "refresh_token");
    assert.equal(refreshBody.refresh_token, "rt-old");

    const o = readCreds(p);
    assert.equal(o.accessToken, "at-new");
    assert.equal(o.refreshToken, "rt-new");
    assert.ok(o.expiresAt > Date.now());
    assert.equal(o.subscriptionType, "max"); // fields we don't own survive
  });

  test("a failed refresh backs off, force bypasses the cooldown", async () => {
    const p = makeProfile({
      accessToken: "at-old",
      refreshToken: "rt-dead",
      expiresAt: Date.now() - 1000,
    });
    let posts = 0;
    route = (url) => {
      assert.equal(url, TOKEN_ENDPOINT);
      posts++;
      return json(400, { error: "invalid_grant" });
    };

    const res = await fetchUsage("", true, p);
    assert.equal(res.error, "token-expired");
    assert.equal(res.data, null);
    assert.equal(posts, 1);

    assert.equal(await refreshCredentials(p, false), null); // cooldown holds
    assert.equal(posts, 1);
    assert.equal(await refreshCredentials(p, true), null); // key tap retries
    assert.equal(posts, 2);
  });

  test("a 401 despite a valid-looking token refreshes once and retries", async () => {
    const p = makeProfile({
      accessToken: "at-stale",
      refreshToken: "rt-old",
      expiresAt: Date.now() + 3_600_000,
    });
    route = (url, init) => {
      if (url === TOKEN_ENDPOINT) {
        return json(200, { access_token: "at-new", refresh_token: "rt-new", expires_in: 28800 });
      }
      const auth = (init?.headers as any).Authorization;
      return auth === "Bearer at-new" ? json(200, USAGE) : json(401, {});
    };

    const res = await fetchUsage("", true, p);
    assert.equal(res.data?.five_hour?.utilization, 42);
    assert.equal(readCreds(p).accessToken, "at-new");
  });
});

describe("pricing and metrics", () => {
  test("1h cache writes bill at 2x input, 5m at 1.25x", () => {
    const u = {
      cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_1h_input_tokens: 600, ephemeral_5m_input_tokens: 400 },
    };
    const expected = 400 * (3.75 / 1e6) + 600 * (6 / 1e6); // sonnet rates
    assert.ok(Math.abs(computeCost(u, "claude-sonnet-5") - expected) < 1e-12);
    // Older entries without the breakdown: the whole total prices at 5m.
    assert.equal(
      computeCost({ cache_creation_input_tokens: 1000 }, "claude-sonnet-5"),
      1000 * (3.75 / 1e6),
    );
  });

  test("burn rate needs a rising window and a real gap", () => {
    const k = "burn-test";
    const t0 = 1_000_000_000;
    recordBurnSample(k, 10, t0);
    assert.equal(burnRate(k, t0), null); // one sample is no slope
    recordBurnSample(k, 14, t0 + 180_000);
    assert.equal(burnRate(k, t0 + 180_000), 80); // 4 points over 3 min
    recordBurnSample(k, 14, t0 + 240_000);
    assert.equal(burnRate(k, t0 + 240_000), null); // flat since last poll = idle
    recordBurnSample(k, 2, t0 + 300_000); // window turned over — history resets
    recordBurnSample(k, 3, t0 + 360_000);
    assert.equal(burnRate(k, t0 + 360_000), null); // gap after reset still too short
    assert.equal(burnNote(50, 25), "full ~2h 0m");
    assert.equal(burnNote(null, 25), "");
  });

  test("history merge: window days overwrite, older days never shrink", () => {
    const merged = mergeHistory(
      { "2026-08-01": { tokens: 100, cost: 1 }, "2026-08-10": { tokens: 50, cost: 0.5 } },
      { "2026-08-01": { tokens: 5, cost: 0.1 }, "2026-08-10": { tokens: 80, cost: 0.9 } },
      "2026-08-06",
    );
    assert.deepEqual(merged["2026-08-01"], { tokens: 100, cost: 1 }); // partial re-read ignored
    assert.deepEqual(merged["2026-08-10"], { tokens: 80, cost: 0.9 }); // in-window is authoritative
    const days = lastDays({ [dayKey(Date.now())]: { tokens: 7, cost: 0.2 } }, 3);
    assert.equal(days.length, 3);
    assert.deepEqual(days[2], { tokens: 7, cost: 0.2 }); // today last
    assert.deepEqual(days[0], { tokens: 0, cost: 0 }); // missing days are zero
  });

  test("model_weekly reads the weekly_scoped limit", () => {
    const data = {
      limits: [
        { kind: "weekly_all", percent: 70 },
        {
          kind: "weekly_scoped",
          percent: 60,
          resets_at: "2026-08-17T16:00:00Z",
          scope: { model: { display_name: "Fable" } },
        },
      ],
    };
    assert.deepEqual(pickMetric(data as any, "model_weekly"), {
      label: "Fable",
      pct: 60,
      resetsAt: "2026-08-17T16:00:00Z",
    });
    assert.equal(pickMetric({} as any, "model_weekly").pct, null);
  });
});
