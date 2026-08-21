# Claude Usage — Stream Deck plugin

Stream Deck keys that show your **live Claude usage limits** and your **local
token / cost totals**. One configurable action — drop it on as many keys as you
like and pick a metric per key. Tap any key to force a refresh.

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)
![Platforms](https://img.shields.io/badge/run%20on-macOS%20%7C%20Windows-blue.svg)
![Stream Deck](https://img.shields.io/badge/Stream%20Deck-6.9%2B-black.svg)
![Node](https://img.shields.io/badge/build%20with-Node%2020%2B-339933.svg)
[![Elgato Marketplace](https://img.shields.io/badge/Elgato%20Marketplace-Available-d97757.svg)](https://marketplace.elgato.com/product/ai-coding-usage-meter-f4aa1012-a57b-4a02-9b90-a37004678ee7)

![Claude Usage keys on a Stream Deck: Session and Weekly limit gauges, then Tokens and Cost tiles](docs/preview.png)

---

## Contents

- [What it shows](#what-it-shows)
- [Requirements](#requirements)
- [Install](#install)
- [Configure](#configure)
- [Verify the data layer first (optional but handy)](#verify-the-data-layer-first-optional-but-handy)
  - [macOS](#macos)
  - [Linux](#linux)
- [Notes & gotchas](#notes--gotchas)
- [Rebuild from source](#rebuild-from-source)
- [Project structure](#project-structure)
- [License](#license)

---

## What it shows

Place the action on several keys, each set to a different metric, to see them all
at once. Two families:

| Metric | Family | Source | Shown as |
| --- | --- | --- | --- |
| **Session (5h)** | Limit (live) | `oauth/usage` endpoint (same as Claude Code's `/usage`) | big % + ring gauge + reset countdown |
| **Weekly (7d)** | Limit (live) | same endpoint | big % + ring gauge + reset countdown |
| **Carousel** | Limit (live) | same endpoint | one key rotating through the faces you pick, in the order you set: the 5-hour, weekly and per-model windows (big %, progress bar, reset countdown, page dots) plus an optional picture-only **Badge** face — auto-rotates on a timer and/or switches on key press |
| **Model weekly (7d)** | Limit (live) | same endpoint (`limits[]`, `weekly_scoped`) | the per-model weekly cap some plans report; `--` on plans without one |
| **Burn rate** | Limit (live) | same endpoint, measured across polls | `%/h` on the 5h window + `full ~2h 10m` projection; `--` while idle |
| **Tokens** | Local logs | Claude Code JSONL transcripts on disk | big value (e.g. `1.2M`) + `today` / `7 days` / `session` |
| **Cost** | Local logs | Claude Code JSONL transcripts on disk | big value (e.g. `$8.40`) + `today` / `7 days` / `session` |
| **Tokens / Cost — 7-day chart** | Local logs + history | daily totals persisted in `~/.claude-usage/` (survive Claude Code pruning old transcripts) | today's value + a 7-bar week sparkline |

Live limits are color-coded green → amber → red, and a key **flashes once**
when a limit climbs past the Red threshold (re-armed when the window resets;
toggle per key). Updates run every 60s, and **tapping any key forces a refresh
now**.

On a **Stream Deck +**, the separate **Usage Dial** action puts a metric on the
touch strip: turn the dial to cycle metrics, press it (or tap the strip) to
force a refresh.

Every poll also writes `~/.claude-usage/stats.json` — all profiles' live
limits, token/cost totals and burn rate in one machine-readable file, for OBS
overlays and scripts.

## Requirements

**To run:** the official [Elgato Stream Deck app](https://www.elgato.com/downloads)
**6.9 or newer** — it ships the Node runtime the plugin uses, so you do **not**
need Node.js installed separately. Runs on **Windows 10+** and **macOS 12+**, and
on both **Pro and Max** (metrics a plan doesn't report show `--`).

> **Log in to Claude Code at least once** on this machine first, so the token
> exists. The plugin reads it from `%USERPROFILE%\.claude\.credentials.json` on
> Windows, or the **login Keychain** (`Claude Code-credentials`) on macOS, and
> never sends it anywhere except Anthropic's own usage endpoint. Token/cost
> metrics additionally read the local transcripts under `~/.claude/projects/`.

> **Linux:** not supported for running. There is no official Stream Deck app for
> Linux, so the `.streamDeckPlugin` can't be installed there — but the data layer
> is plain Node and works on Linux (token from `~/.claude/.credentials.json`,
> logs from `~/.claude/projects/`), so the verify command below and the source
> build both run fine on Linux.

**To build from source:** [Node.js 20+](https://nodejs.org) (any OS).

## Install

**From the [Elgato Marketplace](https://marketplace.elgato.com/product/ai-coding-usage-meter-f4aa1012-a57b-4a02-9b90-a37004678ee7)** — open the link and click **Get**; it installs straight into the Stream Deck app. Easiest path, and you get updates automatically.

Or install the packaged file manually:

1. **Stream Deck app 6.9+** installed (see [Requirements](#requirements)).
2. Download `com.saeedkolivand.claude-usage.streamDeckPlugin` from the
   [latest release](https://github.com/saeedkolivand/claude-usage-streamdeck-plugin/releases/latest)
   and double-click it → **Install**.
3. In Stream Deck, open the **AI Coding Usage Meter** category in the actions list
   and drag **Usage Meter** onto a key.
4. Select the key and pick a **Metric** in its settings (see [Configure](#configure)).
   Repeat on more keys for the others.

That's it. Keys populate within a second or two of being placed.

## Configure

Select the key, then open its property inspector (panel below the canvas):

| Field | What it does |
| --- | --- |
| **Profile** | Which Claude account this key reads. One account? Leave it. Several — kept apart with `CLAUDE_CONFIG_DIR` — set it per key so work and personal sit side by side. |
| **Custom folder** | A config folder discovery can't see. Only shown when no profile is picked. |
| **Metric** | Which value the key shows: Carousel / Session / Weekly (live limits), or Tokens / Cost for today / 7 days / session. |
| **Faces** (Carousel) | Which faces this key rotates through, and in what order — tick to include, arrows to reorder. Every face keeps its row whether ticked or not, so ticking one adds it to the rotation without shuffling the list. The **Badge** sits at the top, unticked by default: switch it on and the key opens with it, like a splash before the numbers. |
| **Starts on** (Carousel) | Which of those faces the key shows when it loads. With **Auto-rotate** off the key stays on it, so two carousel keys side by side can each hold one window permanently — no second action type needed. |
| **Auto-rotate & Interval** (Carousel) | Whether the carousel flips between the 5-hour and weekly faces on its own, and every how many seconds (default `10`). Dragging the interval to `0` ("never") also pins the face. Pressing the key always flips immediately. |
| **5h / Weekly / Model label & color** (Carousel) | Per-face label (defaults `5 HOURS` / `WEEKLY`, and the model's own name for the model face — localize freely) and base color; the % / bar / countdown tints derive from the base color. |
| **Badge** (Carousel) | A picture-only face: a gauge mark by default, or any image you point **Badge image** at (PNG/JPG/GIF/WebP/SVG, up to 256 KB, fitted whole). **Badge for** sets how long it holds, overriding the carousel interval, and **Badge caption** adds a word under it. |
| **Subtitle** (Tokens / Cost) | Overrides the scope line under the value (`today` / `7 days` / `session`) — handy for localization. |
| **Amber threshold** | % where a live limit metric turns amber (default `50`). |
| **Red threshold** | % where a live limit metric turns red (default `80`). |
| **User-Agent** (Advanced) | Sent to the usage endpoint; must start with `claude-code/` (default `claude-code/2.0.31`). Bump it if Anthropic ever tightens the check. |

### Multiple Claude accounts

A "profile" is a Claude Code config folder — one logged-in account. Relocating it
with `CLAUDE_CONFIG_DIR` is the only way Claude Code supports more than one, so
that is what the dropdown lists: `~/.claude`, anything beside it whose name
starts with `.claude`, and whatever you type under **Custom folder**. A folder
counts as a profile when it contains a `projects` directory.

Each profile caches independently, so a key on one account can never serve
another's numbers.

**macOS caveat.** Claude Code keeps its token in the login Keychain under a
single name with no per-account variant, so only the default profile can read a
token from there. A second profile needs its own `.credentials.json` inside its
config folder. Without one, its limit gauges show `open Claude` — deliberately,
rather than silently borrowing the default account's token and showing you the
wrong percentages. Tokens and cost still work either way, since those come from
the transcripts on disk.

## Verify the data layer first (optional but handy)

Before (or instead of) debugging the plugin, confirm the endpoint works for your
account. Paste this into **PowerShell**:

```powershell
$cred  = Get-Content "$env:USERPROFILE\.claude\.credentials.json" -Raw | ConvertFrom-Json
$token = $cred.claudeAiOauth.accessToken
Invoke-RestMethod -Uri "https://api.anthropic.com/api/oauth/usage" -Headers @{
  "Authorization"  = "Bearer $token"
  "anthropic-beta" = "oauth-2025-04-20"
  "User-Agent"     = "claude-code/2.0.31"
} | ConvertTo-Json -Depth 5
```

You should get JSON like:

```json
{
  "five_hour": { "utilization": 33.0, "resets_at": "2026-..." },
  "seven_day": { "utilization": 13.0, "resets_at": "2026-..." }
}
```

`utilization` is the percentage each key shows. If a field comes back `null`
the key displays `--`, which is expected.

### macOS

The equivalent test (token comes from the Keychain):

```bash
TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w | python3 -c 'import sys,json;print(json.load(sys.stdin)["claudeAiOauth"]["accessToken"])')
curl -s https://api.anthropic.com/api/oauth/usage \
  -H "Authorization: Bearer $TOKEN" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -H "User-Agent: claude-code/2.0.31" | python3 -m json.tool
```

### Linux

Token comes from the file, same as Windows:

```bash
TOKEN=$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.claude/.credentials.json")))["claudeAiOauth"]["accessToken"])')
curl -s https://api.anthropic.com/api/oauth/usage \
  -H "Authorization: Bearer $TOKEN" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -H "User-Agent: claude-code/2.0.31" | python3 -m json.tool
```

## Notes & gotchas

- **Unofficial endpoint.** `api.anthropic.com/api/oauth/usage` is undocumented and
  community-discovered. It could change or disappear without notice. If it does,
  keys show `offline`/`--` and keep the last good value — nothing breaks.
- **The `User-Agent` matters.** It must start with `claude-code/`. Without it the
  endpoint serves an aggressively rate-limited bucket (constant 429s). The plugin
  sends `claude-code/2.0.31` by default; if Anthropic ever tightens the check,
  bump the version string in the key's **Advanced → User-Agent** field.
- **Token refresh.** The plugin refreshes the OAuth token itself (same flow as
  the CLI) and writes the rotated token back to `.credentials.json`, so the CLI
  stays logged in and the keys keep updating even if you haven't opened Claude
  Code in days. `open Claude` now only means the refresh token itself is
  dead/expired — launch Claude Code once to log in again.
- **One network call, not four.** All your Claude Usage keys share a single
  cached fetch per minute, so adding more keys doesn't multiply API calls.
- **Pro vs Max.** Works on both — Session and Weekly limits report on either plan.
- **macOS.** Supported. The token is read from the login Keychain
  (`security find-generic-password -s "Claude Code-credentials"`), and the
  transcripts from `~/.claude/projects/`. If a key shows `open Claude`, macOS may
  be prompting for Keychain access — approve it (or run Claude Code once).
  Keychain-only setups aren't auto-refreshed (there's no file to persist the
  rotated token to safely), so an expired token there still needs a one-off
  Claude Code launch.
- **Tokens & cost are best-effort.** They're parsed from Claude Code's local
  JSONL logs, which have two known quirks:
  - Claude Code currently under-records `input`/`output` tokens in the logs
    (cache tokens are accurate), so token totals lean low and pure-compute cost
    is a **lower bound**. To minimize this, cost prefers the per-message `costUSD`
    Claude Code writes and only computes from tokens when that's missing.
  - On **Pro/Max you don't pay per token** — the cost shown is *notional
    "equivalent API spend"*, useful for relative sense, not a real charge.
  - "Session" = your most-recently-active Claude Code conversation; "today" is by
    local calendar day. Entries are de-duplicated by request id.
  - **Model pricing is version-proof.** The model is read per message from your
    own logs (`message.model`) and reduced to a family — `opus`, `sonnet`, or
    `haiku` — not a hardcoded model id, so new releases (e.g. a future
    `opus-4-9`) map to the right rate automatically. Only the per-family rates in
    `PRICING` (`src/usage-core.ts`) need editing if Anthropic changes prices; an
    unrecognized family falls back to Sonnet-class pricing.

## Rebuild from source

The source is included so you can tweak colors, labels, thresholds, or layout.

```bash
npm install
npm run typecheck  # tsc over src/, test/ and scripts/ (no emit)
npm test           # node:test over the pure logic in src/usage-core.ts
npm run build      # bundles src/plugin.ts -> com.saeedkolivand.claude-usage.sdPlugin/bin/plugin.js
npm run preview    # regenerate docs/preview.png (README banner) from the real key faces
npx streamdeck validate com.saeedkolivand.claude-usage.sdPlugin
npx streamdeck pack com.saeedkolivand.claude-usage.sdPlugin --output dist --force
python3 make_icons.py   # only if you change the icon art
```

To tweak the gauge look edit `svgKey`, the token/cost tiles edit `svgStat`, the
metric definitions edit `METRICS` / the `LOG_METRICS` set in `plugin.ts`, and the
cost fallback rates edit `PRICING` — all in `src/usage-core.ts`.

The build commands above are identical on Windows (PowerShell), macOS, and Linux
— only `make_icons.py` needs Python with Pillow (`pip install pillow`).

## Project structure

```
src/usage-core.ts   token read (file + macOS Keychain), API fetch (cached),
                    metric/threshold logic, JSONL token/cost parser, SVG renderers
src/plugin.ts       Stream Deck wiring (action, 60s refresh loop, force-on-press)
scripts/
  make-preview.ts   renders docs/preview.png (README banner) from the real key faces
com.saeedkolivand.claude-usage.sdPlugin/
  manifest.json     plugin + action definition (Node 20 runtime, Windows + macOS)
  bin/plugin.js     bundled output (regenerated by `npm run build`)
  ui/inspector.html settings panel (metric, thresholds, User-Agent)
  imgs/             icons
docs/
  preview.png       readme banner (generated by `npm run preview`)
```

## License

MIT.
