# bb-cc-lite

[![CI](https://github.com/softcane/bb-cc-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/softcane/bb-cc-lite/actions/workflows/ci.yml)

Claude Code can look busy while it is stuck retrying the same command, burning context, or spending money after the useful work is already over.

`bb-cc-lite` is **Black Box Claude Code Lite**. It puts one decision line inside Claude Code:

![bb-cc-lite statusline examples](./assets/statusline-demo.gif)

## Install

```bash
npx bb-cc-lite install --scope local
```

That is enough. Restart Claude Code in the project and the status line appears.

For faster tool-failure signals, opt in to Claude Code event hooks:

```bash
npx bb-cc-lite install --scope local --hooks
```

Hooks are optional, async, and derived-only. `bb-cc-lite` does not install `UserPromptSubmit`.

## What It Tells You

```text
bb: Healthy | ctx 42% | $0.18 | cache warm | continue normally
bb: Careful | ctx 82% | cache writes high | ask Claude for a 6-bullet handoff before more work
bb: Stop | Bash failed 3x running tests | fix the test setup manually, then ask Claude to rerun only that test
```

The line is deliberately concrete: evidence first, next action last.

## Why Did It Say That?

```bash
bb-cc-lite why
```

Example:

```text
Last decision: Stop.
Reason: Bash failed 3x running tests. Claude is retrying a broken test loop.
Next action: fix the test setup manually, then ask Claude to rerun only that test.
```

## Privacy

By default, `bb-cc-lite`:

- does not upload transcripts
- does not store raw prompts
- does not store raw tool output
- does not store file contents
- does not print raw prompts or raw tool output

It reads Claude Code status JSON from stdin, tails the local transcript defensively, and stores only derived metadata such as counts, state, reason codes, token totals, costs, and hashed session ids.

## Existing Setup

`install` preserves an existing Claude Code `statusLine` by default. To replace one intentionally:

```bash
npx bb-cc-lite install --scope local --replace
```

Check your setup:

```bash
bb-cc-lite doctor
```

Uninstall cleanly:

```bash
bb-cc-lite uninstall --scope local
```

## Cost Signals

If Claude Code provides cost, `bb-cc-lite` uses it. Otherwise it estimates from token fields using bundled pricing fallbacks.

To refresh public LiteLLM pricing data:

```bash
bb-cc-lite doctor --refresh-pricing
```

No LiteLLM token, gateway, Python service, or proxy is required.
