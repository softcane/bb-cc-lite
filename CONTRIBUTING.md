# Contributing

Thanks for working on `bb-cc-lite`. Keep the project small: it should answer one question well.

> Should I let this Claude Code session keep going?

## Development Setup

Requirements:

- Node `>=20`
- npm
- Claude Code for real end-to-end QA

Install dependencies:

```bash
npm ci
```

Useful commands:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm pack
```

Run the full local gate before merging behavior changes:

```bash
npm run prepublishOnly
npm pack
```

## Product Boundaries

`bb-cc-lite` is a Claude Code statusline companion. It is not a proxy, dashboard, gateway, message router, or observability stack.

Keep v1 behavior focused on:

- `Healthy`, `Careful`, and `Stop` statusline states.
- Fast statusline rendering from Claude Code status JSON and bounded transcript tails.
- Local derived event storage for `why`.
- Optional hooks for faster local telemetry.
- A small local personal baseline.
- Safe install and uninstall of Claude Code settings.

LiteLLM is pricing data only. Do not add proxy or gateway behavior.

## Privacy Rules

Never store or print:

- Raw prompts or assistant text.
- Raw tool output or shell output.
- Raw shell commands or command arguments.
- File contents.
- Full local transcript paths or workspace paths.
- API keys, tokens, secrets, or raw Claude session ids.
- Per-session baseline rows.

Allowed data is derived metadata: states, reason codes, counts, token/cost fields, timestamps, weak aggregate pattern labels, and hashed session keys.

If a change touches transcripts, hooks, baseline building, event storage, `why`, or statusline rendering, add or update privacy tests.

## Install and Uninstall Rules

`install` replaces an existing Claude Code `statusLine` by default and must write a backup that `uninstall` can restore.

`uninstall` must:

- Restore the previous statusline when a valid backup exists.
- Remove bb-owned hooks.
- Preserve unrelated settings and unrelated hooks.
- Avoid touching user/global Claude settings when local/project scope is enough.

Tests should use temporary project, home, and `BB_CC_LITE_HOME` paths.

## Real Claude Code QA

Fixture tests are not enough for release confidence. Before declaring an install/statusline change done, verify with a real Claude Code session in a disposable project.

Use disposable paths and avoid unsupported local gateways:

```bash
env -u ANTHROPIC_BASE_URL claude ...
```

Minimum real check:

1. Install in a disposable project.
2. Confirm Claude Code renders the statusline.
3. Run a small read-only Claude prompt.
4. Confirm `why` explains the latest decision.
5. Uninstall and confirm settings are restored or removed as expected.

## README and CLI Tone

Keep user-facing text tight. Lead with the pain, show the install command, and avoid legalistic privacy walls in normal install output.

Detailed privacy and baseline information belongs in docs, tests, and `doctor --baseline`, not in the happy-path install flow.

## Release Checklist

1. Update `package.json` and `package-lock.json`.
2. Run:

```bash
npm run prepublishOnly
npm pack
```

3. Smoke-test the packed CLI:

```bash
npx --yes --package ./bb-cc-lite-<version>.tgz bb-cc-lite --help
```

4. Commit, tag, push, and wait for CI.
5. Publish:

```bash
npm publish --access public --otp <YOUR_6_DIGIT_NPM_OTP>
```

6. Verify:

```bash
npm view bb-cc-lite@<version> version
npm install -g bb-cc-lite@<version>
bb-cc-lite --help
```

Do not commit local Claude settings, local stores, generated baselines, npm tarballs, secrets, or disposable QA paths.
