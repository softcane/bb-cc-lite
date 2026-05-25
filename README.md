# bb-cc-lite

[![CI](https://github.com/softcane/bb-cc-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/softcane/bb-cc-lite/actions/workflows/ci.yml)

Claude Code can look busy while it is doing the wrong thing: retrying the same broken test, editing without checking, filling context, or spending money on a stuck loop.

`bb-cc-lite` is a small local Claude Code session supervisor. It adds a status line that answers one question:

> Should I let this Claude Code session keep going?

By default, it also gives Claude a short nudge when the pattern is clear. If the same test keeps failing without a fix, Claude can be told to inspect the first failure before retrying again. If Claude follows that feedback and recovers, `why` can show the loop. If you turn on guard mode, bb can deny the obvious repeated retry before it runs.

![bb-cc-lite statusline examples](./assets/statusline-demo.gif)

## Requirements

- Node.js 20 or newer
- Claude Code with status line support

## Install

```bash
npx --yes bb-cc-lite install --scope local
```

Restart Claude Code in the project. The status line appears at the bottom.

Default install uses coach mode. It keeps the status line for you and sends Claude short safe feedback when a risky loop is visible. Coach feedback can say things like: a validation check has failed repeatedly, inspect the failure pattern, make one targeted fix, then run one focused check.

Coach feedback does not include prompts, command text, tool output, file contents, raw paths, raw session ids, or raw MCP names.

Install preserves an existing Claude Code `statusLine` unless you pass `--replace`.

To uninstall:

```bash
npx --yes bb-cc-lite uninstall --scope local
```

Prefer a global install?

```bash
npm install -g bb-cc-lite
bb-cc-lite install --scope local
```

To replace an existing status line:

```bash
npx --yes bb-cc-lite install --scope local --replace
```

To observe only, without sending feedback to Claude:

```bash
npx --yes bb-cc-lite install --scope local --observe-only
```

To enable stricter guard behavior:

```bash
npx --yes bb-cc-lite install --scope local --guard
```

Guard mode includes coach feedback. It may deny a high-confidence repeated validation retry with a safe reason. It does not broadly block normal reads or edits.

To disable baseline learning and lesson memory:

```bash
npx --yes bb-cc-lite install --scope local --no-learn
```

## What It Catches

- Retry loops where the same command or test fails repeatedly without a fix.
- Long stretches of editing without a test, lint, typecheck, or build check.
- Busy sessions with many tool calls but no observed check or recovery.
- Context pressure before the session gets too full to reason clearly.
- Cost and time budget signals that make a stuck session easier to spot.
- Project baseline patterns, when there is enough local aggregate history.

## How It Helps Claude

In observe-only mode, bb records the pattern and updates the status line, but Claude does not receive feedback.

In coach mode, bb can send Claude a short note during the session. Claude can then inspect the failure, make a targeted fix, run a focused check, or summarize why retrying is not useful.

In guard mode, bb can deny a high-confidence repeated validation retry. The retry does not run, and Claude sees a safe reason.

bb also records safe feedback outcomes. For example, if bb asks Claude to validate after an edit and Claude runs a passing test, `bb-cc-lite why` can show that the feedback was resolved.

## What It Shows

```text
bb: Healthy | ctx 42% | $0.18 | cache warm | continue normally
bb: Healthy | validation resolved | continue normally
bb: Healthy | read-only exploration | continue normally
bb: Careful | edits have not been checked yet | ask Claude to run the smallest relevant check
bb: Careful | 9 non-read tool calls, no check or recovery seen | pause and ask Claude what changed
bb: Careful | session ran 1h plus 9 non-read tool calls, no check or recovery seen | pause and ask Claude what changed before continuing
bb: Careful | same test failed twice without a fix | inspect first failure
bb: Careful | tests failed twice; usually passes after one targeted fix | inspect first failure
bb: Careful | estimated cost $2.25 | ask Claude to summarize progress before continuing
bb: Stop | why: same failure retried 3x without a fix | do: stop and inspect first failure
bb: Stop | why: same test retried after feedback | do: inspect first failure
bb: Stop | why: test loop rarely recovered after 3 failures | do: stop retrying and inspect first failure
bb: Stop | why: high cost plus repeated failures | do: stop and inspect first failure
```

`Healthy` means keep going. `Careful` means slow down and verify. `Stop` means take over before Claude burns more turns.

When available, `why` includes the recent bb loop:

```text
Recent bb loop:
1. Coach feedback: edits needed validation.
2. Claude ran tests.
3. Tests passed.
4. Outcome: resolved.
```

## Useful Commands

```bash
bb-cc-lite why
bb-cc-lite doctor
bb-cc-lite unlearn
bb-cc-lite uninstall --scope local
```

`why` explains the latest statusline decision and recent feedback outcomes when available. Interactive `why` output is lightly colored; set `NO_COLOR=1` or `BB_CC_LITE_COLOR=0` for plain text. `doctor --baseline` shows safe aggregate baseline facts. `unlearn` clears learned personal baselines, project baselines, and lesson memory. `uninstall` restores the previous Claude Code status line when a backup exists.

Budget guard thresholds can be changed with environment variables:

```bash
BB_CC_LITE_BUDGET_COST_USD=1.25
BB_CC_LITE_BUDGET_COST_DELTA_USD=0.25
BB_CC_LITE_BUDGET_DURATION_MINUTES=30
```

## Project-Specific Checks

bb already recognizes common checks such as `npm test`, `pytest`, `cargo test`, `go test`, `npm run lint`, and `npm run build`.

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

## Privacy

Everything stays local. `bb-cc-lite` does not upload transcripts, prompts, tool output, shell output, file contents, API keys, raw commands, raw paths, raw Claude session ids, or raw MCP server or tool names.

It stores derived data only: counts, rates, percentiles, confidence labels, reason codes, feedback outcomes such as `resolved` or `ignored`, safe categories such as `tests`, cost/time/context numbers, weak pattern labels, hashed session keys, and hashed project keys.

Project baselines are stored under the bb app home, not inside the repo. They use only a hashed project key and safe summary data from that project. Sparse or corrupt project data falls back to the personal baseline or fixed rules.

Lesson memory is also stored under the bb app home by hashed project key. A lesson card contains only safe fields such as a reason code, safe category, confidence, counts, timestamps, and templated wording. Lesson cards decay and can be removed with `bb-cc-lite unlearn`.

LiteLLM is used only as public pricing data for cost estimates. `bb-cc-lite` does not run a proxy, gateway, dashboard, or message router.
