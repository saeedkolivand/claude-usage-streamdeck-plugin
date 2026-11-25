# Troubleshooting

- [Verify the data layer first](#verify-the-data-layer-first)
- [Notes & gotchas](#notes--gotchas)

## Verify the data layer first

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
