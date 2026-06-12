# ccverdict Agent Map

This file governs the whole repository.

## Product Compass

- `ccverdict` is a small Claude Code statusline companion.
- Core question: "What is the agent doing right now, and does its behavior look healthy?"
- The statusline is a behavioral gauge with four lights: `green` (progressing), `blue` (drifting), `red` (intervene), `gray` (ccverdict cannot see). No imperatives on the line, ever.
- The CLI must work without Envoy, Docker, Prometheus, a dashboard, a LiteLLM gateway, or extra credentials.
- LiteLLM is pricing-data only in v1; do not add proxy/gateway/message-routing behavior.
- The final confidence gate is real Claude Code behavior, not fixture tests alone.

## Command Map

- `ccverdict install [--scope local|project|user] [--replace] [--hooks] [--no-learn]`
- `ccverdict audit [--project <path>] [--all-projects] [--transcript <path>] [--recent <count>] [--global] [--apply] [--cleanup] [--json]`
- `ccverdict statusline`
- `ccverdict doctor [--scope local|project|user] [--transcript <path>] [--refresh-pricing] [--baseline] [--build-baseline] [--replay-baseline] [--clear-baseline]`
- `ccverdict uninstall [--scope local|project|user] [--purge]`
- Deprecated pointers (one minor version): `why`, `improve`, `learn` -> `audit`; `unlearn` -> `uninstall --purge`.

## Source Map

- `src/cli.ts`: command dispatch and top-level CLI behavior.
- `src/settings.ts`: Claude Code install/uninstall, backups, hooks, scope handling.
- `src/statusline.ts`: statusline orchestration.
- `src/status-input.ts`: Claude Code statusline stdin parsing.
- `src/transcript.ts`, `src/transcript-reader.ts`: bounded JSONL transcript parsing.
- `src/failure-episodes.ts`: safe failure episode extraction and blind retry summaries.
- `src/recovery-stats.ts`: aggregate recovery statistics, confidence gates, and plain-English insights.
- `src/historical-replay.ts`: aggregate-only holdout replay for baseline QA.
- `src/gauge.ts`, `src/findings.ts`, `src/gauge-renderer.ts`: the only decision engine — gauge build, finding detectors/resolver, and width-aware one-line rendering with ANSI color.
- `src/signals.ts`: shared signal helpers the gauge consumes (budget thresholds, cost formatting, cache-efficiency regression, edit-validation lag). The legacy `decide()` waterfall was removed in 0.4.0.
- `src/legacy-state.ts`: the one place the retired Healthy/Careful/Stop vocabulary may appear, mapping gauge light + finding category for coach/guard feedback and audit section 2 reading historical records.
- `src/audit-report.ts`: `audit` orchestrator (current session, recent patterns, instruction report) plus the `--apply`/`--cleanup` write path.
- `src/instruction-correlator.ts`: coarse keyword-to-finding-category matching for the instruction report (isolated, derived-only).
- `src/instruction-block.ts`: marked CLAUDE.md block convention, backup, and scope routing.
- `src/feedback-ledger.ts`: coach/guard feedback-outcome ledger rendering (audit section 1).
- `src/store.ts`: compatibility facade over event-store modules.
- `src/event-store-*.ts`: local derived event persistence and lookup.
- `src/hooks.ts`, `src/hook-*.ts`: optional Claude Code hook ingestion.
- `src/pricing.ts`: LiteLLM public pricing cache plus bundled fallback.
- `src/doctor.ts`: environment and install diagnostics.
- `src/session.ts`: raw Claude session id hashing.
- `src/types.ts`: shared domain types.

## Test Map

- `test/settings.test.ts`: install, replace, hooks, uninstall, backup restore.
- `test/cli-characterization.test.ts`: CLI behavior, privacy, statusline/audit integration, deprecation pointers.
- `test/audit-report.test.ts`: audit sections, two-project isolation, zero-write, apply/cleanup, --json.
- `test/instruction-correlator.test.ts`: keyword/category matching and the three instruction subsections.
- `test/feedback-ledger.test.ts`: coach/guard feedback-outcome ledger rendering.
- `test/gauge.test.ts`: gauge build, finding detectors/resolver, width-aware rendering, file hints, ctx highlight, permission-gate declines.
- `test/transcript.test.ts`: JSONL transcript parsing and failure detection.
- `test/failure-episodes.test.ts`: safe failure episodes and blind retry behavior.
- `test/recovery-stats.test.ts`: recovery aggregates, confidence gates, and insight wording.
- `test/historical-replay.test.ts`: aggregate-only holdout replay metrics.
- `test/hooks.test.ts`: hook payload parsing, privacy, store merge.
- `test/store-pricing.test.ts`: event store privacy and pricing estimates.
- `test/doctor.test.ts`: doctor checks and warnings.
- `test/status-input.test.ts`: statusline stdin parsing.
- `test/performance.test.ts`: statusline performance budget.
- `test/fixtures/statusline/*`: fixture inputs for statusline behavior.

## Documentation Map

- `README.md`: user-facing install, usage, privacy, and commands.
- `assets/statusline-demo.gif`: README statusline demo.

## Build And Package Map

- Runtime target: Node `>=20`, ESM TypeScript.
- Run `npm run typecheck` after TypeScript changes.
- Run `npm run lint` after source or test changes.
- Run `npm test` after behavior changes.
- Run `npm run build` after source changes; `dist/` is the published CLI output.
- Run `npm run prepublishOnly` for the full release-style gate.
- Run `npm pack` when validating `npx --package <tarball> ccverdict`.

## Privacy Rules

- Never print or store raw prompt text.
- Never print or store raw tool output.
- Never print or store file contents.
- Never print or store API keys, tokens, or secrets.
- Never print or store full local transcript paths or full local workspace paths.
- Store only derived metadata: state, reason code, counts, costs, token fields, timestamps, and hashed session keys.
- `why` reads the local derived event store; it must not reopen transcripts to expose raw content.
- Hash raw Claude session ids before storing them.

## Statusline Rules

- `statusline` reads Claude Code JSON from stdin and prints exactly one short line.
- Keep statusline fast: bounded transcript tail, defensive parsing, no unbounded scans.
- Prefer concrete evidence plus concrete action on wide terminals.
- Degrade gracefully on narrow terminals.
- `Stop` should include short inline `why:` when space allows.
- ANSI color is allowed only where statusline supports it; respect `NO_COLOR` and `CCVERDICT_COLOR=0`.
- Do not let malformed JSON, missing transcript files, or unknown fields crash the statusline.

## Install And Uninstall Rules

- Existing Claude Code `statusLine` must be preserved by default.
- Only replace an existing statusline when the user passes `--replace`.
- Uninstall must restore the previous statusline when a valid backup exists.
- Uninstall must remove ccverdict-owned hooks without deleting unrelated hooks.
- Do not silently edit global/user Claude settings when local/project scope is enough.
- Tests should use temp `--project`, `--home`, and `CCVERDICT_HOME` paths.

## Claude Code QA Map

- Before real Claude QA, unset proxy variables that can route through unsupported gateways:
  `env -u ANTHROPIC_BASE_URL claude ...`
- Known bad local value: `ANTHROPIC_BASE_URL=http://127.0.0.1:10000`.
- Real QA path:
  install in disposable repo, start Claude Code, confirm statusline appears,
  run a simple read-only prompt for `Healthy`,
  create repeated failing command/test behavior for `Careful` then `Stop`,
  run `ccverdict why`,
  uninstall and confirm settings are restored.

## Change Discipline

- Prefer small, behavior-preserving changes.
- Add characterization tests before refactors that move CLI, statusline, transcript, store, or settings behavior.
- Keep source and `dist/` aligned when changing runtime code.
- Do not add new product scope unless the user explicitly asks.
- Do not commit secrets, local temp paths, Claude transcripts, or generated local stores.
- If a real Claude Code check is blocked by external state, document the blocker and complete all local checks.
