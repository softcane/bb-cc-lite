# bb-cc-lite

[![CI](https://github.com/softcane/bb-cc-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/softcane/bb-cc-lite/actions/workflows/ci.yml)

Behavioral health monitoring for Claude Code sessions.

Claude Code can look busy while doing the wrong thing. It can retry the same failed test, edit without checking its work, burn tokens, fill the context window, reread files, and keep going after a human should stop it.

The small local status line is a behavioral gauge. It answers one question at a glance:

> What is the agent doing right now, and does its behavior look healthy?

Token spend tells you what it cost. `bb-cc-lite` shows a colored state dot, what the agent is doing, and declarative evidence — no instructions, ever. The line grammar is:

```text
<dot> · <verb> · <evidence> · <files> · <ctx> · <cost>
```

```text
● editing · 3 files, 2 unchecked (auth.ts…) · ctx 42% · $0.18
◐ editing · 3 files, 2 unchecked (auth.ts…) · ctx 42%
■ retrying tests · 3 fails, no fix between runs
○ no signal · transcript unreadable
● idle · no activity yet
```

It runs locally. It is not a cloud dashboard, telemetry service, proxy, gateway, or message router.

### Legend

State dots (a distinct shape per state, so the gauge survives `NO_COLOR`):

| Dot | State | Meaning |
| --- | --- | --- |
| `●` green | progressing | behavior looks healthy |
| `◐` blue | drifting | glance when convenient |
| `■` red | intervene | act before more turns burn |
| `○` gray | no signal | bb cannot read the evidence (never a warning) |

Activity verbs, in priority order when several apply: `retrying` > `testing` > `editing` > `exploring` > `idle`.

Context and cost are passive facts. They never change the dot by themselves; only behavior does (the one exception is context `≥92%`, which is red because reasoning degrades).

![bb-cc-lite statusline examples](./assets/statusline-demo.gif)

_The demo shows healthy editing, unchecked-edit drift, repeated validation retries, and a no-signal line._

## Why This Exists

Activity is not progress.

Busy output, tool calls, and token spend can hide negative progress. The hard part is knowing whether Claude Code's activity still helps.

Humans usually notice too late: after the same check failed three times, after a broad edit streak went unchecked, or after the context window is already under pressure.

`bb-cc-lite` watches derived local signals from the Claude Code status input, transcript tail, and optional hooks. It renders a behavioral gauge: a green/blue/red/gray state dot with declarative evidence, never advice.

## What It Catches

- Retry loops where the same validation check or tool fails repeatedly without a fix.
- Repeated test, lint, typecheck, or build failures.
- Long edit streaks without a test, lint, typecheck, or build check.
- Busy sessions with many tool calls but no observed check or recovery.
- Repeated full-file reads of the same unchanged file.
- Large tool results that suddenly add thousands of input tokens.
- Cache reuse dropping after it was working well.
- Context pressure before the session gets too full to reason clearly.
- Compaction boundaries where Claude should restate the goal before continuing.
- Cost and time budget warnings that make a stuck session easier to spot.
- Local baseline patterns, when there is enough aggregate local history.

## What The Dot Means

`●` green (progressing) means the session still looks healthy to continue.

`◐` blue (drifting) means glance when convenient: edits are accumulating without a check, a failure has repeated once, or cache reuse slipped.

`■` red (intervene) means the behavior is no longer worth continuing blindly: a retry loop, a repeated failure, or critical context pressure. Take over or redirect Claude before more turns burn.

`○` gray (no signal) means bb itself cannot read the evidence (bad input, missing or unreadable transcript, session mismatch). It is never a warning about the agent.

## How It Helps Claude

`bb-cc-lite` can run in three install modes.

`observe-only` keeps the status line and local derived event data. It does not send feedback to Claude.

`coach` is the default. It keeps the status line and can send short, safe Claude-facing notes when a risky pattern appears. Examples include repeated validation failure, unchecked edits, high budget with no progress signal, and unresolved validation risk at finish.

`guard` includes coach feedback. It may deny a high-confidence repeated Bash validation retry, such as rerunning the same test/lint/typecheck/build category after repeated failures without an edit or passing check. It does not broadly block normal reads, edits, or arbitrary commands.

`bb-cc-lite` also records safe feedback outcomes. For example, if bb asks Claude to validate after an edit and Claude runs a passing test, the current-session view of `bb-cc-lite audit` can show that the feedback was resolved.

When available, the current-session view includes the recent bb loop:

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

Run an audit against recent local Claude Code history:

```bash
npx --yes bb-cc-lite audit --project .
npx --yes bb-cc-lite audit --all-projects --recent 200
```

`audit` reads local history and prints three sections. It does not install a status line or hooks. Use `--all-projects` only when you want to inspect newest transcripts across local Claude projects.

## Audit

`audit` is the offline gauge: the status line is *now*, audit is *the story*. It prints three sections.

**[1] Current session** — the current project's latest decision: its dot, age (`12s ago`), every finding behind the dot with confidence, the edit ledger (file, edit count, unchecked/cleared), and the coach/guard feedback-outcome ledger. It is scoped to *this* project: if a repo has no bb history, audit says so rather than showing another repo's session.

**[2] Recent patterns** — aggregated behavioral patterns across recent local history: blind retries, unchecked-edit streaks, repeated reads, recovery after change, compaction and session-end risk, with counts and the worst sessions.

**[3] Instruction report** — your `CLAUDE.md` lines correlated against recent finding categories. It reports, in order and only when non-empty:

- **Candidates for removal** — lines that matched no recent finding category, cited by file and line number.
- **Apparently followed** — lines whose category shows high compliance (possibly redundant).
- **Gaps** — recurring finding categories (seen at least three times) that no instruction line addresses.

Every claim is phrased as "matched / didn't match", never as causality. bb reads your `CLAUDE.md` locally to quote lines with line numbers; that content is never written into bb's store.

### Writing changes

Plain `audit` never writes anything outside bb's own store. `audit --apply` first prints a unified diff, then writes only inside a marked `bb-cc-lite` block (backup first). Additions are stingy: a pattern seen at least three times, one generic line per pattern, at most two per apply, never raw commands, paths, or prompts. bb never modifies or deletes a line you wrote — removal suggestions appear in the diff as commented proposals only, and a re-run with unchanged evidence is a no-op. `audit --cleanup` removes the marked block after a backup.

Project-specific lessons route to `./CLAUDE.md`; cross-project habits (with `--global` or `--all-projects`) route to `~/.claude/CLAUDE.md`. `audit` does not edit `AGENTS.md`.

## Useful Commands

```bash
bb-cc-lite audit --project .
bb-cc-lite audit --all-projects --recent 200
bb-cc-lite audit --apply --project .
bb-cc-lite audit --cleanup --project .
bb-cc-lite doctor
bb-cc-lite doctor --baseline
bb-cc-lite uninstall --scope local
bb-cc-lite uninstall --purge
```

`audit` scans recent history without installing. Its current-session view reads the local derived event store; it does not reopen transcripts to expose raw content. Interactive output is lightly colored; set `NO_COLOR=1` or `BB_CC_LITE_COLOR=0` for plain text.

`doctor` checks Node, Claude settings, optional hooks, transcript access, pricing cache, and related diagnostics.

`doctor --baseline` shows safe aggregate baseline facts.

`uninstall` removes bb-owned status line and hooks. When a valid backup exists, it restores the previous Claude Code status line. `uninstall --purge` also deletes learned baselines, lesson memory, and the derived event store.

The earlier `why`, `improve`, `learn`, and `unlearn` commands are deprecated. `why` and `improve` are folded into `audit`; `unlearn` is folded into `uninstall --purge`. Each prints a one-line pointer for one minor version.

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

Those categories support retry-loop detection, recovery baselines, coach feedback, and guard-mode retry denial.

## Session Signals

Some warnings are not about tests. They are about the session shape.

`bb-cc-lite` can notice when Claude rereads the same unchanged file, when one tool result makes the next turn much larger, when prompt-cache reuse drops, or when a compaction boundary needs a quick goal check.

These signals are intentionally simple. They do not inspect raw prompts, tool output, or file contents. They use derived metadata from the status input and transcript tail.

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
- Claude rereads the same file as if it forgot the current context.
- One tool response suddenly bloats the next turn.
- Cache reuse drops and the session starts getting more expensive per turn.
- Context is getting high and reasoning quality may drop.
- Cost or time is climbing but validation is not improving.
- A session has many tool calls but no clear recovery signal.
- You want a quick signal before deciding to continue or intervene.
- You want local feedback without adding a dashboard or service.

## Privacy

`bb-cc-lite` is local-first. There is no cloud backend, SaaS dashboard, transcript upload, proxy, gateway, or message router.

The health event store and baselines use derived metadata only: state, reason code, counts, rates, percentiles, confidence labels, feedback outcomes such as `resolved` or `ignored`, safe categories such as `tests`, token/cost/context fields, timestamps, weak pattern labels, hashed file identities, hashed session keys, and hashed project keys.

The health data does not store prompts, assistant text, tool output, shell output, command arguments, file contents, transcript paths, workspace paths, API keys, raw Claude session ids, or raw MCP names.

For repeated-read warnings, bb may show a short basename-style hint such as `auth.ts`. It does not store or print the full local path.

Local files live under `~/.claude/bb-cc-lite` by default, unless `BB_CC_LITE_HOME` or another override environment variable is set. This includes:

- `events.json` for derived local decisions and hook events.
- `baseline.json` for the personal aggregate baseline.
- `project-baselines/<hashed-project>.json` for aggregate project baselines.
- `project-lessons/<hashed-project>.json` for decaying project lesson memory.
- `litellm-pricing.json` for cached public pricing data when refreshed.
- `backups/` for Claude settings backups used by uninstall.

Install backups are local settings snapshots so uninstall can restore prior Claude settings. They may contain whatever status line, hook commands, or paths existed in those Claude settings. `bb-cc-lite` does not upload them.

LiteLLM is used only as public pricing data for cost estimates. `bb-cc-lite` does not run a LiteLLM proxy or route messages.

## More Examples

```text
● exploring · ctx 24% · $0.12
● editing · 2 files, 1 unchecked (router.ts…) · ctx 31%
◐ editing · 4 files, 3 unchecked (router.ts…) · ctx 44%
◐ testing · tests failed twice · ctx 52%
◐ exploring · cache reuse dropped from 68% to 29%
◐ idle · compaction boundary open
■ retrying tests · 3 fails, no fix between runs
■ exploring · reread config.ts 3x
■ exploring · ctx 93%, nearly full
○ no signal · transcript session mismatch
```

Each example is one line. The dot and verb are leftmost; passive facts (`ctx`, cost) are rightmost. On narrow terminals the line degrades to compact counts (`◐ editing · 3✎? · 44%`) and then to a minimal `◐ 3✎? 44%`, but the dot always survives.
