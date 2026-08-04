// Run with: npm test
//
// Covers profile discovery and the three-branch global-config lookup, which is
// the part that fails silently: pick the wrong branch and a profile shows the
// wrong account's email, with nothing to indicate it.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverProfiles,
  globalConfigPath,
  isProfileDir,
  planLabel,
  projectsDir,
  credentialsPath,
} from "../src/usage-core";

let home: string;

function makeProfile(name: string): string {
  const dir = join(home, name);
  mkdirSync(join(dir, "projects"), { recursive: true });
  return dir;
}

function writeConfig(path: string, account: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({ oauthAccount: account }));
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "claude-usage-"));
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("what counts as a profile", () => {
  test("needs a projects directory", () => {
    const dir = makeProfile(".claude");
    assert.equal(isProfileDir(dir), true);

    const bare = join(home, ".claude-flow");
    mkdirSync(bare, { recursive: true });
    assert.equal(isProfileDir(bare), false);
    rmSync(bare, { recursive: true, force: true });
  });

  test("credentials are not required", () => {
    // They can be relocated, or live in the Keychain / Credential Manager with
    // no file at all — requiring one would hide real profiles.
    assert.equal(isProfileDir(join(home, ".claude")), true);
  });

  test("finds the default and its siblings, default first", () => {
    makeProfile(".claude");
    makeProfile(".claude-work");

    const found = discoverProfiles([], home);
    assert.deepEqual(
      found.map((p) => p.configDir.split(/[\\/]/).pop()).sort(),
      [".claude", ".claude-work"],
    );
    assert.equal(found[0].isDefault, true);
  });

  test("no duplicates when sources overlap", () => {
    const dir = makeProfile(".claude");
    const found = discoverProfiles([dir], home);
    assert.equal(found.filter((p) => p.configDir === dir).length, 1);
  });
});

describe("where identity comes from", () => {
  test("the default profile reads its SIBLING global config", () => {
    // ~/.claude.json sits next to ~/.claude, not inside it.
    const dir = makeProfile(".claude");
    writeConfig(join(home, ".claude.json"), {
      emailAddress: "me@example.com",
      organizationName: "Acme",
      organizationRateLimitTier: "default_claude_max_20x",
    });

    const found = discoverProfiles([], home).find((p) => p.isDefault);
    assert.equal(found?.email, "me@example.com");
    assert.equal(found?.organization, "Acme");
    assert.equal(found?.plan, "Max");
    assert.equal(globalConfigPath(dir, true), join(home, ".claude.json"));
  });

  test("a relocated profile reads the config INSIDE itself", () => {
    const dir = makeProfile(".claude-work");
    writeConfig(join(dir, ".claude.json"), { emailAddress: "work@example.com" });

    const found = discoverProfiles([], home).find((p) => !p.isDefault);
    assert.equal(found?.email, "work@example.com");
  });

  test("a relocated profile never inherits the default account's identity", () => {
    // ~/.claude-work's parent is also ~, so an ungated sibling lookup would
    // stamp the default account's email onto every relocated profile.
    makeProfile(".claude");
    writeConfig(join(home, ".claude.json"), { emailAddress: "personal@example.com" });
    const dir = makeProfile(".claude-solo");

    assert.equal(globalConfigPath(dir, false), null);
    const found = discoverProfiles([], home).find(
      (p) => p.configDir.endsWith(".claude-solo"),
    );
    assert.equal(found?.email, undefined);
  });

  test(".config.json wins over .claude.json", () => {
    const dir = makeProfile(".claude-newer");
    writeConfig(join(dir, ".claude.json"), { emailAddress: "old@example.com" });
    writeConfig(join(dir, ".config.json"), { emailAddress: "new@example.com" });

    const found = discoverProfiles([], home).find((p) =>
      p.configDir.endsWith(".claude-newer"),
    );
    assert.equal(found?.email, "new@example.com");
  });

  test("a corrupt global config still yields a usable profile", () => {
    const dir = makeProfile(".claude-broken");
    writeFileSync(join(dir, ".claude.json"), "not json");

    const found = discoverProfiles([], home).find((p) =>
      p.configDir.endsWith(".claude-broken"),
    );
    assert.ok(found);
    assert.equal(found?.email, undefined);
    assert.equal(found?.displayName, ".claude-broken");
  });
});

describe("paths", () => {
  test("derive from the config dir, not the home dir", () => {
    assert.equal(projectsDir("/x/.claude-work"), join("/x/.claude-work", "projects"));
    assert.equal(
      credentialsPath("/x/.claude-work"),
      join("/x/.claude-work", ".credentials.json"),
    );
  });

  test("plan labels", () => {
    assert.equal(planLabel("default_claude_max_20x"), "Max");
    assert.equal(planLabel("claude_pro"), "Pro");
    assert.equal(planLabel("something_else"), undefined);
    assert.equal(planLabel(undefined), undefined);
  });
});
