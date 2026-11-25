# Configuration

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

## Multiple Claude accounts

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
