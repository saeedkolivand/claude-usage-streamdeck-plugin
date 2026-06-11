# Privacy Policy — AI Coding Usage Meter (Stream Deck plugin)

**Last updated:** 2026-06-11
**Maker:** Saeed Kolivand
**Contact:** https://github.com/saeedkolivand/claude-usage-streamdeck-plugin/issues

## Summary

This plugin runs entirely on your own computer. It reads data that already exists on
your machine to display usage figures on your Stream Deck keys. It has **no servers, no
analytics, no telemetry, and no third-party tracking**. The only network request it ever
makes goes directly to Anthropic's own usage endpoint, using your own credentials, to
fetch your own usage — nothing is sent anywhere else.

## What the plugin accesses (locally, on your device)

- **Your Claude credential token.** To read your live usage limits, the plugin reads the
  access token that Claude Code already stores on your machine:
  - **Windows:** `%USERPROFILE%\.claude\.credentials.json`
  - **macOS:** the login Keychain item `Claude Code-credentials`
  - **Linux (source build only):** `~/.claude/.credentials.json`
- **Your local Claude Code transcripts.** For the Tokens and Cost metrics, the plugin
  reads the local JSONL conversation logs under `~/.claude/projects/` to total token
  counts and cost figures. It parses these files read-only.
- **Your key settings.** The metric, thresholds, and optional User-Agent you choose are
  stored by the Stream Deck application in its own local plugin settings.

## What the plugin transmits

- **One request, to Anthropic only.** The plugin sends your access token in an
  `Authorization: Bearer` header to Anthropic's usage endpoint
  (`https://api.anthropic.com/api/oauth/usage`) to retrieve your session and weekly usage
  percentages. This is the same endpoint Claude Code's own `/usage` command uses. The
  request is made directly from your machine to Anthropic; it does not pass through any
  server operated by the plugin or its maker.
- **Nothing else leaves your device.** Token counts, cost figures, and the contents of
  your transcripts are computed locally and displayed on your keys only. They are never
  uploaded or transmitted anywhere.

## What the plugin stores

- The plugin does **not** store, copy, cache, or retain your credential token. It reads
  the token from its existing on-device location at request time and uses it only for the
  request above.
- The plugin does **not** store the contents of your transcripts. It reads them, computes
  totals, and discards the parsed data.
- Only your chosen display preferences (metric, thresholds, User-Agent) are persisted,
  and only within Stream Deck's own local settings on your computer.

## Data sharing

The plugin shares **no data** with the maker or any third party. There is no account, no
sign-in to any service operated by the plugin, and no collection of personal information.
Your interaction with Anthropic's endpoint is governed by
[Anthropic's own privacy policy and terms](https://www.anthropic.com/legal/privacy).

## Third-party note

This plugin is an independent, unofficial tool. It is not affiliated with, endorsed by, or
sponsored by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic and are
used here only to describe compatibility. The Anthropic usage endpoint it queries is
undocumented; if Anthropic changes or removes it, the affected keys simply show `offline`
or `--` and no data is lost.

## Children

The plugin is a developer productivity tool and is not directed to children under 13.

## Changes to this policy

If this policy changes, the updated version will be published in this repository with a new
"Last updated" date.

## Contact

Questions or concerns: open an issue at
https://github.com/saeedkolivand/claude-usage-streamdeck-plugin/issues
