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
  credentialsPath,
  fetchUsage,
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
