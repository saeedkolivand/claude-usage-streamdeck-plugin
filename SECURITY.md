# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for them.

- Preferred: GitHub's [private vulnerability reporting](https://github.com/saeedkolivand/claude-usage-streamdeck-plugin/security/advisories/new)
  (the **Security** tab → *Report a vulnerability*).
- Or email **saeedkolivand1997@gmail.com** with details and steps to reproduce.

You can expect an acknowledgement within a few days. Please give a reasonable
window to release a fix before any public disclosure. This is a small
community project maintained on a best-effort basis.

## Supported versions

Only the latest released version receives fixes. Please confirm a report against
the current `main` / latest release before filing.

## What this plugin accesses, and where data goes

By design, the plugin runs locally and is intentionally narrow in what it touches:

- It reads your existing Claude Code sign-in info from where Claude Code already
  stores it on this machine (a file under your home `.claude` folder on Windows,
  or the login Keychain on macOS). It does not create, move, or copy that data
  elsewhere.
- It reads Claude Code's local conversation logs under `~/.claude/projects/` to
  total up tokens and cost.
- The only network request it makes is a read of **your own** usage from
  Anthropic's API (`api.anthropic.com`). Nothing is sent to any third party, and
  the plugin has no analytics or telemetry.

If you believe any of the above is not true in practice (e.g. data leaving the
machine to anywhere other than Anthropic's API), that's a security issue — please
report it using the private channels above.

## Out of scope

These are known characteristics, not vulnerabilities:

- **The usage endpoint is undocumented.** `api.anthropic.com/api/oauth/usage` is
  community-discovered and may change or stop working at any time. When it does,
  keys simply show `offline`/`--`.
- **Cost figures are estimates.** They're parsed from local logs and are notional
  "equivalent API spend" on Pro/Max plans, not a real charge.
- A key showing `open Claude`, `offline`, or `--` is expected behavior, not a
  security flaw — see the README *Notes & gotchas*.
