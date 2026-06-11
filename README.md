# bb-cc-lite

[![CI](https://github.com/softcane/bb-cc-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/softcane/bb-cc-lite/actions/workflows/ci.yml)

A local statusline for Claude Code sessions.

Claude Code can look busy while it drifts. It can retry the same failed check, edit files without validation, reread a file it already saw, or push the context window too high.

`bb-cc-lite` watches derived local metadata and prints one gauge line:

> What is the agent doing right now, and does its behavior look healthy?

```text
<dot> · <verb> · <evidence> · <files> · <ctx> · <cost>
```

```text
● editing · 1 file, 1 unchecked (auth.ts…) · ctx 42% · $0.18
◐ editing · 3 files, 2 unchecked (auth.ts…) · ctx 42%
■ retrying tests · 3 fails, no fix between runs
■ exploring · reread config.ts 3x
○ no signal · transcript unreadable
● idle · no activity yet
```

bb prints no instructions on the line. It shows the dot, the current activity, and the evidence behind the dot.

The file segment shows counts plus one basename hint: the latest unchecked file. It does not list every file.

![bb-cc-lite statusline examples](./assets/statusline-demo.gif)

_The demo cycles through example statusline states: healthy editing, unchecked-edit drift, repeated validation failure, repeated file reads, high context, and unreadable evidence._

## Dot Legend

The dot has both a color and a shape, so it still works with `NO_COLOR`.

| Dot | Light | Meaning |
| --- | --- | --- |
| `●` green | progressing | the behavior looks healthy |
| `◐` blue | drifting | check the session when you have a moment |
| `■` red | intervene | retry loop, repeated failure, or critical context pressure |
| `○` gray | no signal | bb cannot read the evidence |

Activity verbs use this priority when several apply:

```text
retrying > testing > editing > exploring > idle
```

Context and cost are facts. They do not change the dot by themselves. The exception is context at `92%` or higher, which turns red because the session is close to full.

At `80%` through `91%`, bb highlights only the `ctx` segment. With color disabled, it uses a marker:

```text
● exploring · ctx 85%!
```

## What It Catches

- The same validation check failing again without a fix.
- Test, lint, typecheck, or build failures that repeat.
- Edits that pile up without a passing check.
- Read-heavy sessions with no recovery signal.
- The same unchanged file being read again.
- A large tool result that adds many input tokens.
- Prompt-cache reuse dropping after it was working.
- Context pressure before the session gets too full.
- Cost or time climbing while validation still fails.
- Compaction boundaries that need a fresh goal check.

Permission prompts are separate. If you deny a tool permission prompt, bb does not count that as a command failure or retry loop.

## Install

Requirements:

- Node.js 20 or newer
- Claude Code with status line support

```bash
npx --yes bb-cc-lite install --scope local
```

Restart Claude Code in the project. The statusline appears at the bottom.

Default install uses `coach` mode and builds a small local baseline when it can. It preserves an existing Claude Code `statusLine` unless you pass `--replace`.

```bash
npx --yes bb-cc-lite install --scope local --replace
```

Use `observe-only` when you only want the gauge and local history:

```bash
npx --yes bb-cc-lite install --scope local --observe-only
```

Use `guard` when you want coach feedback plus strict denial of high-confidence repeated validation retries:

```bash
npx --yes bb-cc-lite install --scope local --guard
```

Skip baseline creation and lesson memory:

```bash
npx --yes bb-cc-lite install --scope local --no-learn
```

Uninstall:

```bash
npx --yes bb-cc-lite uninstall --scope local
```

Supported scopes are `local`, `project`, and `user`. Use `local` for one repo unless you need to edit project-level or user-level Claude settings.

Prefer a global install?

```bash
npm install -g bb-cc-lite
bb-cc-lite install --scope local
```

## Feedback Modes

`observe-only` keeps the statusline and local derived event data. It sends no feedback to Claude.

`coach` is the default. It can send short Claude-facing notes when bb sees a risky pattern, such as unchecked edits, repeated validation failure, or unresolved validation risk at finish.

`guard` includes coach feedback. It can deny a high-confidence repeated Bash validation retry, such as rerunning the same test, lint, typecheck, or build category after repeated failures without an edit or passing check. It does not block normal reads, edits, or arbitrary commands.

bb also records safe feedback outcomes. If coach feedback asks for validation and Claude later runs a passing test, `audit` can show that the loop resolved:

```text
Recent bb loop:
1. Coach feedback: edits needed validation.
2. Claude ran tests.
3. Tests passed.
4. Outcome: resolved.
```

## Try Before Installing

Run an audit against recent local Claude Code history:

```bash
npx --yes bb-cc-lite audit --project .
npx --yes bb-cc-lite audit --all-projects --recent 200
```

`audit` does not install a statusline or hooks. Use `--all-projects` only when you want to inspect the newest transcripts across local Claude projects.

## Audit

`audit` is the offline view of the gauge. It prints three sections.

**[1] Current session**

Shows the latest bb decision for the current project only: dot, light, age, all findings, edit ledger, and coach or guard feedback outcomes. If the project has no bb history, audit says so. It does not show another repo's session.

**[2] Recent patterns**

Reports aggregate local patterns: blind retries, unchecked-edit streaks, repeated reads, recovery after change, compaction risk, and session-end risk.

**[3] Instruction report**

Reads `CLAUDE.md` and compares instruction lines against recent finding categories. It prints only non-empty subsections:

- **Candidates for removal**: lines that matched no recent finding category.
- **Apparently followed**: lines whose category already has high compliance.
- **Gaps**: recurring finding categories that no instruction line addresses.

The report uses "matched" and "didn't match" language. It does not claim that an instruction caused an outcome.

### Audit Writes

Plain `audit` writes nothing outside bb's own store.

`audit --apply` prints a unified diff, then writes only inside bb's marked `CLAUDE.md` block. It backs up first. It adds at most two generic lines per run, and it never writes raw prompts, commands, paths, or tool output.

bb does not delete or edit user-written `CLAUDE.md` lines. Removal suggestions appear as commented proposals in the diff. `audit --cleanup` removes the marked block after a backup.

Project-specific lessons route to `./CLAUDE.md`. Cross-project habits route to `~/.claude/CLAUDE.md` when you use `--global` or `--all-projects`. `audit` does not edit `AGENTS.md`.

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

`audit --json` returns machine-readable output for all three audit sections.

`doctor` checks Node, Claude settings, optional hooks, transcript access, pricing cache, store version, and baseline diagnostics.

`doctor --baseline` shows safe aggregate baseline facts.

`uninstall` removes bb-owned statusline and hooks. When a valid backup exists, it restores the previous Claude Code statusline. `uninstall --purge` also deletes learned baselines, lesson memory, and the derived event store.

Deprecated commands still print one-line pointers:

- `why` points to `audit`.
- `improve` points to `audit`.
- `learn` is automatic on install and refresh.
- `unlearn` points to `uninstall --purge`.

## Validation Signals

`bb-cc-lite` observes checks Claude Code runs. It does not run tests, lint, typecheck, or build commands by itself.

It recognizes common Bash validation commands and groups them into safe categories:

- tests
- lint
- typecheck
- build

bb uses those categories for retry-loop detection, recovery baselines, coach feedback, and guard-mode retry denial.

If your project uses custom validation commands, add `.bb-cc-lite.json`:

```json
{
  "validationCommands": {
    "tests": ["make test"],
    "lint": ["make lint"],
    "build": ["make build"]
  }
}
```

This file is optional. bb uses it for classification, but it does not copy those raw commands into event history.

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

On narrow terminals the line shrinks to compact counts:

```text
◐ editing · 3✎? · 44%
◐ 3✎? 44%
```

The dot stays visible.

## Privacy

`bb-cc-lite` is local-first. It has no cloud backend, SaaS dashboard, transcript upload, proxy, gateway, or message router.

Current gauge records use derived metadata only: light, activity, finding categories, confidence labels, counts, rates, percentiles, feedback outcomes such as `resolved` or `ignored`, safe validation categories such as `tests`, token and cost fields, context fields, timestamps, hashed file identities, hashed session keys, and hashed project keys.

The event store does not store prompts, assistant text, tool output, shell output, command arguments, file contents, transcript paths, workspace paths, API keys, raw Claude session ids, or raw MCP names.

For repeated-read warnings, bb may show a basename hint such as `auth.ts`. It does not store or print the full local path.

Local files live under `~/.claude/bb-cc-lite` by default, unless you set `BB_CC_LITE_HOME` or another override:

- `events.json` stores derived local decisions, hook events, and feedback outcomes.
- `baseline.json` stores the personal aggregate baseline.
- `project-baselines/<hashed-project>.json` stores aggregate project baselines.
- `project-lessons/<hashed-project>.json` stores decaying project lesson memory.
- `litellm-pricing.json` caches public pricing data when refreshed.
- `backups/` stores Claude settings backups used by uninstall.

Install backups are local settings snapshots. They may contain whatever statusline, hook commands, or paths already existed in those Claude settings. `bb-cc-lite` does not upload them.

LiteLLM is used only as public pricing data for cost estimates. `bb-cc-lite` does not run a LiteLLM proxy or route messages.

Set budget thresholds with environment variables:

```bash
BB_CC_LITE_BUDGET_COST_USD=1.25
BB_CC_LITE_BUDGET_COST_DELTA_USD=0.25
BB_CC_LITE_BUDGET_DURATION_MINUTES=30
```
