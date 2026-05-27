# bb-cc-lite

[![CI](https://github.com/softcane/bb-cc-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/softcane/bb-cc-lite/actions/workflows/ci.yml)

Behavioral health monitoring for Claude Code sessions.

Claude Code can look busy while doing the wrong thing. It can retry the same failed test, edit without verification, burn tokens, fill the context window, thrash across files, and keep going long after a human should stop it.

The small local status line answers one question:

> Should I let this Claude Code session keep going?

Token spend tells you what it cost. `bb-cc-lite` tries to show whether the session behavior still looks healthy: continue, verify, or stop before more turns are burned.

It is local. It is not a cloud dashboard, telemetry service, proxy, gateway, or message router.

```text
bb: Healthy | ctx 42% | $0.18 | continue normally
bb: Healthy | validation resolved | continue normally
bb: Careful | edits have not been checked yet | run the smallest relevant check
bb: Careful | same test failed twice without a fix | inspect first failure
bb: Careful | 9 non-read tool calls, no check or recovery seen | pause and ask what changed
bb: Stop | why: same failure retried 3x without a fix | do: stop and inspect first failure
```

![bb-cc-lite statusline examples](./assets/statusline-demo.gif)

_The demo shows the difference between healthy progress, unchecked edits, repeated validation failures, and Stop-level retry loops._

## Why This Exists

Activity is not progress.

The hard part is not seeing that Claude Code is active. The hard part is knowing whether its activity is still useful. Busy output, tool calls, and token spend can hide negative progress.

Humans usually notice too late: after the same check has failed three times, after a broad edit streak was never verified, or after the context window is already under pressure.

`bb-cc-lite` watches local derived signals from the Claude Code status input, transcript tail, and optional hooks. It classifies the current session as `Healthy`, `Careful`, or `Stop`.

## What It Catches

- Retry loops where the same validation check or tool fails repeatedly without a fix.
- Repeated test, lint, typecheck, or build failures.
- Long edit streaks without a test, lint, typecheck, or build check.
- Busy sessions with many tool calls but no observed check or recovery.
- Context pressure before the session gets too full to reason clearly.
- Cost and time budget warnings that make a stuck session easier to spot.
- Local baseline patterns, when there is enough aggregate local history.

## Healthy / Careful / Stop

`Healthy` means the session still looks safe to continue.

`Careful` means slow down. Ask for verification, inspect the pattern, or make the next step smaller.

`Stop` does not mean the project failed. It means the session pattern is no longer worth blindly continuing. Take over, redirect Claude, or inspect the first failure before spending more turns.

## How It Helps Claude

`bb-cc-lite` can run in three install modes.

`observe-only` keeps the status line and local derived event data, but does not send feedback to Claude.

`coach` is the default. It keeps the status line and can send short, safe Claude-facing notes when a risky pattern is visible, such as repeated validation failure, unchecked edits, high budget with no progress signal, or unresolved validation risk at finish.

`guard` includes coach feedback. It may deny a high-confidence repeated Bash validation retry, such as rerunning the same test/lint/typecheck/build category after repeated failures without an edit or passing check. It does not broadly block normal reads, edits, or arbitrary commands.

`bb-cc-lite` also records safe feedback outcomes. For example, if bb asks Claude to validate after an edit and Claude runs a passing test, `bb-cc-lite why` can show that the feedback was resolved.

When available, `why` includes the recent bb loop:

```text
Recent bb loop:
1. Coach feedback: edits needed validation.
2. Claude ran tests.
3. Tests passed.
4. Outcome: resolved.
```

## Install

Requirements:

- Node.js 20 or newer
- Claude Code with status line support

```bash
npx --yes bb-cc-lite install --scope local
```

Restart Claude Code in the project. The status line appears at the bottom.

Default install uses coach mode and builds a small local baseline when possible. It preserves an existing Claude Code `statusLine` unless you pass `--replace`.

To replace an existing status line:

```bash
npx --yes bb-cc-lite install --scope local --replace
```

To observe only, without sending feedback to Claude:

```bash
npx --yes bb-cc-lite install --scope local --observe-only
```

To enable stricter repeated-validation retry denial:

```bash
npx --yes bb-cc-lite install --scope local --guard
```

To disable baseline learning and lesson memory:

```bash
npx --yes bb-cc-lite install --scope local --no-learn
```

To uninstall:

```bash
npx --yes bb-cc-lite uninstall --scope local
```

Prefer a global install?

```bash
npm install -g bb-cc-lite
bb-cc-lite install --scope local
```

Supported install scopes are `local`, `project`, and `user`. Use `local` for the current repo unless you have a specific reason to edit project or user Claude settings.

## Try Before Installing

Run a retrospective audit against recent local Claude Code history:

```bash
npx --yes bb-cc-lite audit --project .
npx --yes bb-cc-lite audit --all-projects --recent 200
```

`audit` scans recent local Claude Code JSONL history and reports where `bb-cc-lite` would have warned. It highlights repeated retries and risky session patterns; it only shows duplicate retry cost/time when the transcript contains usable measured metadata. It does not install a status line or hooks. Use `--all-projects` only when you want to inspect newest transcripts across local Claude projects.

## Useful Commands

```bash
bb-cc-lite audit --project .
bb-cc-lite audit --all-projects --recent 200
bb-cc-lite why
bb-cc-lite doctor
bb-cc-lite doctor --baseline
bb-cc-lite unlearn
bb-cc-lite uninstall --scope local
```

`audit` scans recent history without installing.

`why` explains the latest stored status line decision and recent feedback outcomes when available. It reads the local derived event store; it does not reopen transcripts to expose raw content. Interactive `why` output is lightly colored; set `NO_COLOR=1` or `BB_CC_LITE_COLOR=0` for plain text.

`doctor` checks Node, Claude settings, optional hooks, transcript access, pricing cache, and related diagnostics.

`doctor --baseline` shows safe aggregate baseline facts.

`unlearn` clears learned personal baselines, project baselines, and lesson memory.

`uninstall` removes bb-owned status line and hooks. When a valid backup exists, it restores the previous Claude Code status line.

Budget thresholds can be changed with environment variables:

```bash
BB_CC_LITE_BUDGET_COST_USD=1.25
BB_CC_LITE_BUDGET_COST_DELTA_USD=0.25
BB_CC_LITE_BUDGET_DURATION_MINUTES=30
```

## Validation Signals

`bb-cc-lite` observes checks Claude Code runs. It does not run tests, lint, typecheck, or build commands by itself.

It recognizes common Bash validation commands and groups them into safe categories:

- tests
- lint
- typecheck
- build

Those categories are used for retry-loop detection, recovery baselines, coach feedback, and guard-mode retry denial.

## Project-Specific Checks

If your project uses custom validation commands, you can add an optional `.bb-cc-lite.json`:

```json
{
  "validationCommands": {
    "tests": ["make test"],
    "lint": ["make lint"],
    "build": ["make build"]
  }
}
```

This file is not generated automatically. It is only needed when you want to teach bb what your project's test, lint, typecheck, or build commands look like. bb uses it for classification, but does not copy those raw commands into its event history.

## When This Is Useful

- Claude keeps retrying the same failing test.
- Claude edits many files without running checks.
- Context is getting high and reasoning quality may drop.
- Cost or time is climbing but validation is not improving.
- A session has many tool calls but no clear recovery signal.
- You want a quick signal before deciding to continue or intervene.
- You want local feedback without adding a dashboard or service.

## Privacy

`bb-cc-lite` is local-first. There is no cloud backend, SaaS dashboard, transcript upload, proxy, gateway, or message router.

The health event store and baselines use derived metadata only: state, reason code, counts, rates, percentiles, confidence labels, feedback outcomes such as `resolved` or `ignored`, safe categories such as `tests`, token/cost/context fields, timestamps, weak pattern labels, hashed session keys, and hashed project keys.

The health data is designed not to store prompts, assistant text, tool output, shell output, command arguments, file contents, transcript paths, workspace paths, API keys, raw Claude session ids, or raw MCP names.

Local files live under `~/.claude/bb-cc-lite` by default, unless `BB_CC_LITE_HOME` or other override environment variables are set. This includes:

- `events.json` for derived local decisions and hook events.
- `baseline.json` for the personal aggregate baseline.
- `project-baselines/<hashed-project>.json` for aggregate project baselines.
- `project-lessons/<hashed-project>.json` for decaying project lesson memory.
- `litellm-pricing.json` for cached public pricing data when refreshed.
- `backups/` for Claude settings backups used by uninstall.

Install backups are local settings snapshots so uninstall can restore prior Claude settings. They may contain whatever status line, hook commands, or paths existed in those Claude settings. They are not uploaded by `bb-cc-lite`.

LiteLLM is used only as public pricing data for cost estimates. `bb-cc-lite` does not run a LiteLLM proxy or route messages.

## More Examples

```text
bb: Healthy | read-only exploration | continue normally
bb: Careful | estimated cost $2.25 | ask Claude to summarize progress before continuing
bb: Careful | session ran 1h plus 9 non-read tool calls, no check or recovery seen | pause and ask what changed before continuing
bb: Careful | ctx 83% | ask Claude for a 6-bullet handoff before more work
bb: Careful | compaction event seen | ask Claude to restate current goal and next 3 steps
bb: Careful | tests failed twice; usually passes after one targeted fix | inspect first failure
bb: Stop | why: same test retried after feedback | do: inspect first failure
bb: Stop | why: test loop rarely recovered after 3 failures | do: stop retrying and inspect first failure
```
