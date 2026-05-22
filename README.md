# bb-cc-lite

[![CI](https://github.com/softcane/bb-cc-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/softcane/bb-cc-lite/actions/workflows/ci.yml)

Claude Code can look busy while it is doing the wrong thing: retrying the same broken test, editing without checking, filling context, or spending money on a stuck loop.

`bb-cc-lite` adds a small status line that answers one question:

> Should I let this Claude Code session keep going?

![bb-cc-lite statusline examples](./assets/statusline-demo.gif)

## Requirements

- Node.js 20 or newer
- Claude Code with status line support

## Install

```bash
npx --yes bb-cc-lite install --scope local --hooks
```

Restart Claude Code in the project. The status line appears at the bottom.

Install preserves an existing Claude Code `statusLine` unless you pass `--replace`. `--hooks` is optional, but gives faster loop detection.

To uninstall:

```bash
npx --yes bb-cc-lite uninstall --scope local
```

Prefer a global install?

```bash
npm install -g bb-cc-lite
bb-cc-lite install --scope local --hooks
```

To replace an existing status line:

```bash
npx --yes bb-cc-lite install --scope local --replace --hooks
```

## What It Catches

- Retry loops where the same command or test fails repeatedly without a fix.
- Long stretches of editing without a test, lint, typecheck, or build check.
- Busy sessions with many tool calls but no observed check or recovery.
- Context pressure before the session gets too full to reason clearly.
- Cost and time budget signals that make a stuck session easier to spot.
- Project baseline patterns, when there is enough local aggregate history.

## What It Shows

```text
bb: Healthy | ctx 42% | $0.18 | cache warm | continue normally
bb: Careful | edits have not been checked yet | ask Claude to run the smallest relevant check
bb: Careful | 9 tool calls, no check or recovery seen | pause and ask Claude what changed
bb: Careful | session ran 1h plus 9 tool calls, no check or recovery seen | pause and ask Claude what changed before continuing
bb: Careful | same test failed twice without a fix | inspect first failure
bb: Careful | tests failed twice; usually passes after one targeted fix | inspect first failure
bb: Careful | estimated cost $2.25 | ask Claude to summarize progress before continuing
bb: Stop | why: same failure retried 3x without a fix | do: stop and inspect first failure
bb: Stop | why: test loop rarely recovered after 3 failures | do: stop retrying and inspect first failure
bb: Stop | why: high cost plus repeated failures | do: stop and inspect first failure
```

`Healthy` means keep going. `Careful` means slow down and verify. `Stop` means take over before Claude burns more turns.

## Useful Commands

```bash
bb-cc-lite why
bb-cc-lite doctor
bb-cc-lite unlearn
bb-cc-lite uninstall --scope local
```

`why` explains the latest statusline decision. `doctor --baseline` shows safe aggregate baseline facts. `unlearn` clears learned personal and project baselines. `uninstall` restores the previous Claude Code status line when a backup exists.

Budget guard thresholds can be changed with environment variables:

```bash
BB_CC_LITE_BUDGET_COST_USD=1.25
BB_CC_LITE_BUDGET_COST_DELTA_USD=0.25
BB_CC_LITE_BUDGET_DURATION_MINUTES=30
```

## Privacy

Everything stays local. `bb-cc-lite` does not upload transcripts, prompts, tool output, shell output, file contents, API keys, raw commands, raw paths, raw Claude session ids, or raw MCP server or tool names.

It stores derived data only: counts, rates, percentiles, confidence labels, reason codes, cost/time/context numbers, weak pattern labels, hashed session keys, and hashed project keys.

Project baselines are stored under the bb app home, not inside the repo. They use only a hashed project key and safe summary data from that project. Sparse or corrupt project data falls back to the personal baseline or fixed rules.

LiteLLM is used only as public pricing data for cost estimates. `bb-cc-lite` does not run a proxy, gateway, dashboard, or message router.
