# Real-Shape Sanitized JSONL Fixtures

These fixtures are not real Claude Code transcripts. They are fake, sanitized scenarios with transcript envelopes shaped from public Claude Code transcript evidence.

Structural references used:

- Official Claude Code statusline docs: `session_id`, `transcript_path`, `cwd`, `model`, and `context_window` input fields.
- Official Claude Code hooks docs: `tool_use_id`, `tool_name`, `tool_input`, `tool_response`, and transcript path linkage.
- Public transcript/parser documentation from `claude-devtools`, `claude-code-transcripts`, `tokenuse`, and other public examples for `uuid`, `parentUuid`, `sessionId`, `gitBranch`, assistant `message.content[]`, `tool_use`, `tool_result`, `toolUseResult`, `requestId`, and `message.usage`.

Privacy rules:

- Do not add real prompts, tool output, file contents, workspace paths, transcript paths, secrets, raw session ids, or raw MCP names.
- Use fake UUIDs, fake request/message ids, and safe fixture paths only.
- Keep deliberate `BB_CC_LITE_*_SENTINEL` strings only to prove derived decisions and outputs do not leak raw material.
