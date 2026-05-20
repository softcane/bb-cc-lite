# bb-cc-lite

[![CI](https://github.com/softcane/bb-cc-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/softcane/bb-cc-lite/actions/workflows/ci.yml)

Claude Code can look busy while it is doing the wrong thing: retrying the same broken test, editing without checking, filling context, or spending money on a stuck loop.

`bb-cc-lite` adds a small status line that answers one question:

> Should I let this Claude Code session keep going?

![bb-cc-lite statusline examples](./assets/statusline-demo.gif)

## Install

```bash
npm install -g bb-cc-lite
bb-cc-lite install --scope local --hooks
```

Restart Claude Code in the project. The status line appears at the bottom.

Install replaces the current Claude Code `statusLine` and saves a backup for uninstall. `--hooks` is optional, but gives faster loop detection.

Prefer not to install globally? Prefix commands with `npx --yes bb-cc-lite`.

## What It Shows

```text
bb: Healthy | ctx 42% | $0.18 | cache warm | continue normally
bb: Careful | edits not checked yet | run focused check
bb: Careful | retry looks blind: same test failed twice | inspect first failure
bb: Careful | tests failed twice; usually recovers after one fix | inspect first failure
bb: Stop | why: blind retry loop: same failure 3x without fix evidence | do: stop and inspect first failure
bb: Stop | why: test loop rarely recovered after 3 failures | do: stop retrying and inspect first failure
```

`Healthy` means keep going. `Careful` means slow down and verify. `Stop` means take over before Claude burns more turns.

## Useful Commands

```bash
bb-cc-lite why
bb-cc-lite doctor
bb-cc-lite doctor --baseline
bb-cc-lite doctor --replay-baseline
bb-cc-lite unlearn
bb-cc-lite uninstall --scope local
```

`why` explains the latest statusline decision. `doctor` checks the install. `unlearn` removes the personal baseline. `uninstall` restores the previous Claude Code status line when a backup exists.

## Personal Baseline

By default, install builds a small local baseline from your Claude Code history. It helps the line tell the difference between normal research, recoverable failures, and patterns that usually waste time for you.

Hard `Stop` rules still win. The baseline only changes wording, priority, and confidence.

Skip it:

```bash
bb-cc-lite install --scope local --no-learn
```

Rebuild or inspect it:

```bash
bb-cc-lite doctor --build-baseline
bb-cc-lite doctor --baseline
bb-cc-lite doctor --replay-baseline
```

`doctor --replay-baseline` builds a baseline from older local sessions, replays newer holdout sessions, and prints aggregate-only QA metrics such as Stop precision, false Stops, missed unrecovered loops, blind retry precision, low-sample suppressions, and category coverage.

## Privacy

Everything stays local. `bb-cc-lite` does not upload transcripts, prompts, tool output, shell output, file contents, API keys, or raw Claude session ids.

It stores derived data only: counts, rates, percentiles, confidence labels, reason codes, cost/context numbers, weak pattern labels, and hashed session keys.

LiteLLM is used only as public pricing data for cost estimates. `bb-cc-lite` does not run a proxy, gateway, dashboard, or message router.
