// Run with: npm test
//
// Covers the incremental transcript parser behind getLogStats: later ticks
// read only appended bytes, so the totals must stay exactly what a full
// re-read would produce — across appends, a trailing line without "\n",
// duplicate request ids and a transcript rewritten from scratch.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getLogStats } from "../src/usage-core";

// Keep history persistence out of the real per-user data dir.
const dataDir = mkdtempSync(join(tmpdir(), "cu-logstats-data-"));
process.env.CLAUDE_USAGE_DATA_DIR = dataDir;

function line(id: string, tokens: number): string {
  return (
    JSON.stringify({
      type: "assistant",
      requestId: id,
      timestamp: new Date().toISOString(),
      costUSD: tokens / 1000,
      message: { model: "claude-sonnet-4-5", usage: { input_tokens: tokens, output_tokens: 0 } },
    }) + "\n"
  );
}

describe("getLogStats incremental parsing", () => {
  let configDir: string;
  let file: string;

  before(() => {
    configDir = mkdtempSync(join(tmpdir(), "cu-logstats-"));
    mkdirSync(join(configDir, "projects", "p"), { recursive: true });
    file = join(configDir, "projects", "p", "session.jsonl");
  });

  after(() => {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("counts the initial transcript and skips non-usage lines", async () => {
    writeFileSync(file, line("r1", 10) + line("r2", 20) + "not json\n");
    const s = await getLogStats(true, configDir);
    assert.equal(s.todayTokens, 30);
    assert.equal(s.sessionTokens, 30);
  });

  test("adds lines appended after the last pass", async () => {
    appendFileSync(file, line("r3", 30));
    const s = await getLogStats(true, configDir);
    assert.equal(s.todayTokens, 60);
  });

  test("counts a trailing line without newline exactly once", async () => {
    appendFileSync(file, line("r4", 40).trimEnd());
    assert.equal((await getLogStats(true, configDir)).todayTokens, 100);
    // The newline arrives later; the entry must not be counted twice.
    appendFileSync(file, "\n");
    assert.equal((await getLogStats(true, configDir)).todayTokens, 100);
  });

  test("dedupes a repeated request id across passes", async () => {
    appendFileSync(file, line("r4", 40));
    assert.equal((await getLogStats(true, configDir)).todayTokens, 100);
  });

  test("re-parses a transcript that was rewritten shorter", async () => {
    writeFileSync(file, line("x1", 5));
    const s = await getLogStats(true, configDir);
    assert.equal(s.todayTokens, 5);
    assert.equal(s.weekTokens, 5);
  });
});
