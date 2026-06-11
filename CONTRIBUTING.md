# Contributing

Thanks for your interest in improving the Claude Usage Stream Deck plugin!
This is a small, focused project, so the workflow is light.

## Ways to help

- **Report a bug** or **request a metric/feature** via the issue templates.
- **Improve the docs** (README, this file).
- **Send a pull request** for a fix or a new metric.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Project layout

```
src/usage-core.ts   data + rendering logic (no Stream Deck SDK dependency):
                    API fetch (cached), metric/threshold logic, the local-log
                    token/cost parser, and the SVG renderers
src/plugin.ts       Stream Deck wiring: the action, the 60s refresh loop, and
                    force-refresh-on-press
com.saeedkolivand.claude-usage.sdPlugin/
  manifest.json     plugin + action definition (Node 20 runtime, Windows + macOS)
  bin/plugin.js     bundled output — generated, committed, do not hand-edit
  ui/inspector.html the settings panel (metric, thresholds, advanced)
  imgs/             icons
```

Keep logic in `usage-core.ts` and Stream Deck glue in `plugin.ts`. `usage-core.ts`
has no SDK import on purpose, which keeps it easy to unit-test in plain Node.

## Development setup

Requires Node 20+.

```bash
npm install
npm run build      # esbuild bundles src/plugin.ts -> bin/plugin.js
```

`bin/plugin.js` is the artifact the Stream Deck app actually runs, and it **is
committed**. Always edit the TypeScript in `src/`, then re-run `npm run build` so
the bundle stays in sync. PRs that change `src/` but not the rebuilt `bin/plugin.js`
will be asked to rebuild.

Validate and (optionally) package the plugin:

```bash
npx streamdeck validate com.saeedkolivand.claude-usage.sdPlugin
npx streamdeck pack com.saeedkolivand.claude-usage.sdPlugin --output dist --force
```

## Adding a new metric

A metric usually touches four places — keep them consistent:

1. `src/usage-core.ts` — add the data (a `METRICS` entry for a live limit, or a
   field on `LogStats` for a local-log stat).
2. `src/plugin.ts` — add it to `LOG_METRICS` (if it's a local-log stat) and to the
   `drawStat`/`drawGauge` branch.
3. `com.saeedkolivand.claude-usage.sdPlugin/ui/inspector.html` — add the `<option>`.
4. `README.md` — add it to the metric list.

## Testing

There's no formal test runner, but `usage-core.ts` is written to be testable:
`getLogStats(force, baseDir)` takes an optional `baseDir`, so you can point it at a
temporary folder of synthetic `.jsonl` transcripts and assert the totals. A quick
smoke test that builds the core to CJS and feeds it fixtures is the easiest way to
verify parser/aggregation changes. Please sanity-check rendering changes against an
actual key when you can.

## Style

- Match the surrounding code: small focused functions, explanatory comments where
  the *why* isn't obvious, no new dependencies unless necessary.
- TypeScript, ES modules, 2-space indent.

## Pull requests

- Branch off `main`, keep PRs focused.
- Fill in the PR template checklist (rebuilt bundle, `validate` clean, platforms
  tested).
- Note which OS you tested on — ideally both **Windows** and **macOS**, since the
  plugin supports both.
