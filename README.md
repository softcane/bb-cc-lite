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

For faster tool-loop detection:

```bash
npx bb-cc-lite install --scope local --hooks
```

Hooks are optional. They run in the background and skip `UserPromptSubmit`.

## The Line

```text
bb: Healthy | ctx 42% | $0.18 | cache warm | continue normally
bb: Careful | ctx 82% | Context is getting tight | ask Claude for a 6-bullet handoff before more work
bb: Stop | why: Bash failed 3x running tests | do: fix the test setup manually, then ask Claude to rerun only that test
```

`Healthy` means keep going. `Careful` means slow down. `Stop` means take over before Claude burns more turns.

## Why

```bash
bb-cc-lite why
```

```text
Last decision: Stop.
Reason: Bash failed 3x running tests. Claude is retrying a broken test loop.
Next action: fix the test setup manually, then ask Claude to rerun only that test.
```

By default, `why` explains the latest recorded decision. To inspect a specific Claude Code session, pass its session id:

```bash
bb-cc-lite why --session <session-id>
```

## Privacy

By default, `bb-cc-lite` does not upload transcripts, store raw prompts, store raw tool output, store file contents, or print raw prompt/tool text.

It reads Claude Code status JSON from stdin, tails the local transcript defensively, and stores derived metadata only: counts, reason codes, token totals, costs, and hashed session ids.

## Undo

```bash
bb-cc-lite doctor
bb-cc-lite uninstall --scope local
```

Install preserves an existing Claude Code `statusLine` unless you pass `--replace`.
