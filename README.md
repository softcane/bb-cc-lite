# bb-cc-lite

[![CI](https://github.com/softcane/bb-cc-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/softcane/bb-cc-lite/actions/workflows/ci.yml)

Claude Code does not always fail loudly. Sometimes it loops, fills context, spends money, and still looks productive.

`bb-cc-lite` is **Black Box Claude Code Lite**: a small traffic light for your Claude Code status line.

![bb-cc-lite statusline examples](./assets/statusline-demo.gif)

## Install

```bash
npx bb-cc-lite install --scope local
```

Restart Claude Code in the project. The line appears at the bottom.

The statusline runtime is installed into Claude settings; the `npx` install does not add a global `bb-cc-lite` command to your shell. Run later CLI commands through `npx bb-cc-lite ...`, or install globally with `npm install -g bb-cc-lite` if you want bare `bb-cc-lite ...` commands.

Install replaces any existing Claude Code `statusLine` by default and stores a backup so `uninstall` can restore it. It also builds a local personal baseline by default after it installs the statusline. It reads bounded local Claude Code JSONL once, newest eligible files first, extracts aggregate patterns from past sessions, and stores a small `baseline.json` under the `bb-cc-lite` app home. Use `--no-learn` to install the statusline without scanning old JSONL:

```bash
npx bb-cc-lite install --scope local --no-learn
```

For faster tool-loop detection:

```bash
npx bb-cc-lite install --scope local --hooks
```

Hooks are optional. They run in the background and skip `UserPromptSubmit`.

## The Line

```text
bb: Healthy | ctx 42% | $0.18 | cache warm | continue normally
bb: Healthy | research phase: usually normal for you | continue
bb: Careful | edits not checked yet | run focused check
bb: Careful | tests failed twice; usually recovers after one fix | inspect first failure
bb: Careful | edit lag unusual for you | run focused check
bb: Careful | ctx 82% | Context is getting tight | ask Claude for a 6-bullet handoff before more work
bb: Stop | why: test loop: usually unrecovered after 3x | do: inspect first failure
```

`Healthy` means keep going. `Careful` means slow down. `Stop` means take over before Claude burns more turns.

## Why

```bash
npx bb-cc-lite why
```

```text
Last decision: Stop.
Reason: Bash failed 3x running tests. Claude is retrying a broken test loop.
Next action: inspect first failure.
```

By default, `why` explains the latest recorded decision. To inspect a specific Claude Code session, pass its session id:

```bash
npx bb-cc-lite why --session <session-id>
```

`why` may mention when the personal baseline influenced wording or priority, including safe recovery and edit-lag explanations recorded by the statusline. It reads only the derived local event store; it does not reopen old transcripts to expose raw content.

## Personal Baseline

`bb-cc-lite` learns weak Healthy-like, Careful-like, and Stop-like outcome patterns from your own past Claude Code sessions. It scans newest JSONL candidates first, applies the file and byte caps before summarizing, and reads transcript tails with bounded parallelism. Those weak labels can affect footer wording, priority, and confidence, but hard global `Stop` rules still win.

Refresh, inspect, or clear the baseline:

```bash
npx bb-cc-lite doctor --build-baseline
npx bb-cc-lite doctor --baseline
npx bb-cc-lite doctor --clear-baseline
npx bb-cc-lite unlearn
```

`doctor --baseline` prints a safe aggregate summary, including recent window, validation category, and safe tool category names when present. `doctor --clear-baseline` and `unlearn` remove only `baseline.json`.

## Privacy

By default, `bb-cc-lite` does not upload transcripts, store raw prompts, store raw tool output, store raw shell commands, store file contents, store raw paths, or print raw prompt/tool text.

For learning, it reads bounded local Claude Code JSONL history and stores only derived aggregate data: counts, rates, scenario counts, weak outcome-label counts, confidence buckets, recovery rates, validation categories, edit-to-validation lag buckets, safe tool category names, scan timestamps, and privacy flags. It uses file mtimes and raw shell commands only transiently for sorting and categorization. It never stores prompts, assistant text, commands, command arguments, tool output, file contents, transcript paths, scanned-file lists, per-file mtimes, workspace paths, raw session ids, API keys, or per-session transcript rows.

For live rendering, statusline reads Claude Code status JSON from stdin, tails only the current transcript defensively, and may read the small `baseline.json`. It stores derived metadata only: counts, reason codes, token totals, costs, and hashed session ids.

LiteLLM is used only as public pricing data for cost estimates. `bb-cc-lite` does not run a LiteLLM proxy, gateway, or message router.

## Undo

```bash
npx bb-cc-lite doctor
npx bb-cc-lite doctor --clear-baseline
npx bb-cc-lite unlearn
npx bb-cc-lite uninstall --scope local
```

Install backs up the previous Claude Code `statusLine` before replacing it.
