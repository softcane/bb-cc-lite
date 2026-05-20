# Security Policy

`bb-cc-lite` is a local Claude Code statusline tool. The highest-risk areas are local data handling, Claude settings edits, install/uninstall behavior, and anything that could expose prompts, transcripts, file paths, shell output, or API keys.

## Supported Versions

Security fixes target the latest npm release only. Early preview versions before the current `latest` tag are not supported.

Check the current version:

```bash
npm view bb-cc-lite version
```

## Reporting a Vulnerability

Do not paste secrets, transcripts, prompts, tool output, local file contents, or exploit details into a public issue.

Preferred path:

1. Use GitHub private vulnerability reporting for this repository if it is available.
2. If private reporting is not available, open a public issue with only a short summary and ask for a private contact path. Do not include sensitive details.

Useful report details:

- `bb-cc-lite` version and install method.
- Node version and OS.
- Whether the issue affects `install`, `statusline`, `why`, `doctor`, hooks, or uninstall.
- A minimal reproduction that uses dummy paths and dummy data.
- Whether any raw prompt, transcript, shell output, file content, path, API key, or raw Claude session id was exposed.

## Security-Sensitive Behavior

Please treat these as security-relevant:

- Raw prompts, assistant text, tool output, shell commands, command arguments, file contents, local paths, transcript paths, workspace paths, API keys, or raw Claude session ids are printed or stored.
- `install` overwrites Claude Code settings without a restorable backup.
- `uninstall` removes unrelated Claude settings or hooks.
- Baseline, event store, backup, or launcher files are created with overly broad permissions.
- Statusline rendering crashes Claude Code or blocks for unbounded work.
- Shell command construction can be influenced by project paths or settings in a way that changes execution.

These are usually not `bb-cc-lite` security bugs:

- Claude Code model behavior.
- Claude Code authentication or billing behavior.
- A local user intentionally reading files from their own account.
- Public LiteLLM pricing data being unavailable.

## Project Privacy Invariants

`bb-cc-lite` should store derived metadata only: state, reason code, counts, token/cost fields, timestamps, weak aggregate pattern labels, and hashed session keys.

It must not store or print raw prompts, assistant text, tool output, shell output, command arguments, file contents, transcript paths, workspace paths, API keys, or raw Claude session ids.
