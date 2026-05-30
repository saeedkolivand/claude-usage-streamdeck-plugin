# Claude Usage — Stream Deck plugin

Shows your Claude usage on Stream Deck keys. One configurable action; drop it on
as many keys as you like and pick a metric per key. Two families of metrics:

- **Limits (live)** — Session (5h), Weekly (7d), Weekly Opus, Weekly Sonnet.
  Pulled from the same endpoint Claude Code's `/usage` uses. Shown as a big %
  with a ring gauge and reset countdown, color-coded green → amber → red.
- **Tokens & cost (local logs)** — Tokens today, Cost today, Tokens session,
  Cost session. Parsed from Claude Code's JSONL transcripts on disk. Shown as a
  big value (e.g. `1.2M`, `$8.40`) with a `today`/`session` subtitle.

Updates every 60s; **tap any key to force a refresh now**. Works on **Windows and
macOS**, and on both **Pro and Max** (metrics a plan doesn't report show `--`).

---

## Install

1. **Stream Deck app 6.5+** (it ships the Node runtime the plugin uses — you do
   **not** need Node.js installed separately).
2. Double-click **`com.local.claude-usage.streamDeckPlugin`** and click **Install**.
3. In Stream Deck, open the **Claude Usage** category in the actions list and drag
   **Claude Usage** onto a key.
4. Select the key, open its settings (panel below the canvas), and pick a
   **Metric**. Repeat on more keys for the others. The **amber/red** thresholds
   (default 50/80) color the live limit gauges.

That's it. Keys populate within a second or two of being placed.

> **Log in to Claude Code at least once** on this machine first, so the token
> exists. The plugin reads it from `%USERPROFILE%\.claude\.credentials.json` on
> Windows, or the **login Keychain** (`Claude Code-credentials`) on macOS, and
> never sends it anywhere except Anthropic's own usage endpoint. Token/cost
> metrics additionally read the local transcripts under `~/.claude/projects/`.

---

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
  "five_hour":       { "utilization": 33.0, "resets_at": "2026-..." },
  "seven_day":       { "utilization": 13.0, "resets_at": "2026-..." },
  "seven_day_opus":  { "utilization": 12.0, "resets_at": "2026-..." },
  "seven_day_sonnet":{ "utilization": 1.0,  "resets_at": "2026-..." }
}
```

`utilization` is the percentage each key shows. On some plans `seven_day_opus`
(or others) come back `null` — those keys will display `--`, which is expected.

On **macOS**, the equivalent test (token comes from the Keychain):

```bash
TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w | python3 -c 'import sys,json;print(json.load(sys.stdin)["claudeAiOauth"]["accessToken"])')
curl -s https://api.anthropic.com/api/oauth/usage \
  -H "Authorization: Bearer $TOKEN" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -H "User-Agent: claude-code/2.0.31" | python3 -m json.tool
```

---

## Notes & gotchas

- **Unofficial endpoint.** `api.anthropic.com/api/oauth/usage` is undocumented and
  community-discovered. It could change or disappear without notice. If it does,
  keys show `offline`/`--` and keep the last good value — nothing breaks.
- **The `User-Agent` matters.** It must start with `claude-code/`. Without it the
  endpoint serves an aggressively rate-limited bucket (constant 429s). The plugin
  sends `claude-code/2.0.31` by default; if Anthropic ever tightens the check,
  bump the version string in the key's **Advanced → User-Agent** field.
- **Token refresh.** Claude Code refreshes the token in `.credentials.json`
  automatically while you use it. If the plugin shows `open Claude`, just launch
  Claude Code once to refresh, and the keys recover on the next tick.
- **One network call, not four.** All your Claude Usage keys share a single
  cached fetch per minute, so adding more keys doesn't multiply API calls.
- **Pro vs Max.** Works on both. Max reports the Opus/Sonnet weekly breakdowns;
  Pro may not, in which case those keys read `--`.
- **macOS.** Supported. The token is read from the login Keychain
  (`security find-generic-password -s "Claude Code-credentials"`), and the
  transcripts from `~/.claude/projects/`. If a key shows `open Claude`, macOS may
  be prompting for Keychain access — approve it (or run Claude Code once).
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
  - Pricing for the compute fallback lives in `PRICING` in `src/usage-core.ts` —
    edit it if Anthropic changes rates.

---

## Rebuild from source

The source is included so you can tweak colors, labels, thresholds, or layout.

```bash
npm install
npm run build      # bundles src/plugin.ts -> com.local.claude-usage.sdPlugin/bin/plugin.js
npx streamdeck validate com.local.claude-usage.sdPlugin
npx streamdeck pack com.local.claude-usage.sdPlugin --output dist --force
python3 make_icons.py   # only if you change the icon art
```

Layout:

```
src/usage-core.ts   token read (file + macOS Keychain), API fetch (cached),
                    metric/threshold logic, JSONL token/cost parser, SVG renderers
src/plugin.ts       Stream Deck wiring (action, 60s refresh loop, force-on-press)
com.local.claude-usage.sdPlugin/
  manifest.json     plugin + action definition (Node 20 runtime, Windows + macOS)
  bin/plugin.js     bundled output (regenerated by `npm run build`)
  ui/inspector.html settings panel (metric, thresholds, User-Agent)
  imgs/             icons
```

To tweak the gauge look edit `svgKey`, the token/cost tiles edit `svgStat`, the
metric definitions edit `METRICS` / the `LOG_METRICS` set in `plugin.ts`, and the
cost fallback rates edit `PRICING` — all in `src/usage-core.ts`.
