/**
 * Syncs a semantic-release version into both version sources.
 * Usage: node scripts/sync-version.mjs <semver>   (e.g. 1.3.0)
 *
 * - package.json "version"  -> the bare semver (1.3.0)
 * - manifest.json "Version" -> Stream Deck's required 4-part numeric (1.3.0.0)
 *
 * Run by semantic-release's prepare step before build + pack.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const semver = process.argv[2];
if (!semver || !/^\d+\.\d+\.\d+$/.test(semver)) {
  console.error(`sync-version: expected a semver like 1.3.0, got "${semver}"`);
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");
const manifestPath = join(
  root,
  "com.saeedkolivand.claude-usage.sdPlugin",
  "manifest.json"
);

/** Update a single top-level string field, preserving 2-space formatting + trailing newline. */
function patch(path, key, value) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  json[key] = value;
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  console.log(`sync-version: ${path} ${key} -> ${value}`);
}

patch(pkgPath, "version", semver);
patch(manifestPath, "Version", `${semver}.0`);
