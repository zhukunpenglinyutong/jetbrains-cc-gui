# PR: Add CLI Invocation Mode for Claude

## Summary

This PR introduces a new **CLI invocation mode** for Claude alongside the existing SDK mode, allowing users to choose between SDK and CLI on a per-request basis. It also extends image attachment handling, improves stream/queue stability, and adds related UI, i18n, and tests.

## New Features

1. **CLI Invocation Mode for Claude** — Added a complete CLI execution path (`ClaudeCliBridge` + `ClaudeCliDetector` + handler) as an alternative to the SDK invocation path.
2. **Per-Request Invocation Mode** — Each request can independently select SDK or CLI mode, with tab-level broadcasting and persistence across sessions.
3. **Invocation Mode Settings UI** — New settings panel to configure default invocation mode.
4. **CLI Model Mapping** — Added model alias/mapping logic dedicated to the CLI runtime so model selections route correctly under CLI mode.
5. **Frontend Invocation Mode Cache + `/context` Gating** — The frontend caches the active invocation mode and gates the `/context` slash command based on what the current mode supports.
6. **CLI Thinking Suppression** — Suppresses thinking-block output when running under CLI mode where it is not supported.
7. **Epoch-Based Send Guard** — Added an epoch guard for invocation routing to invalidate stale send operations after mode switches.
8. **File-Path Based Image Attachments** — Bridge and daemon now accept image attachments by file path instead of inline base64, reducing payload size.
9. **Multi-Turn Image / Attachment Handling** — Properly handles multi-turn `message_start` events and extends session attachment fields to persist image references across turns.
10. **Image Preview Source (`previewSrc`)** — Added preview source field so the UI can render attachment thumbnails consistently in both modes.
11. **Frontend Image Dedup & Optimistic Merge** — Deduplicates images on the frontend and merges optimistic UI state with streaming responses; invocation mode is passed through end-to-end.
12. **Route Image Tool Output to Thinking** — Image-generating tool results are routed into the thinking channel and streaming message snapshots are reduced for performance.

## Fixes

1. **`tool_result` Status** — Fixed incorrect tool result status rendering under CLI mode.
2. **Image Recognition** — Fixed an issue where images were not recognized correctly in CLI mode.
3. **Invocation Mode i18n** — Invocation mode labels/descriptions now support multiple languages.
4. **Codex / Claude Mode Description** — Corrected the displayed mode descriptions.
5. **Codex Queue Stuck Bug** — Resolved a deadlock where the Codex queue could stall by introducing an abort-flush promise.
6. **Code Style** — Misc code-style cleanups.

## Refactoring

1. **`AttachmentStorageService`** — Extracted a shared service so SDK and CLI paths build image blocks through the same code.
2. **`ClaudeCliBridge` / `ClaudeCliDetector` Cleanup** — Simplified and tightened the CLI bridge/detector implementation.

## Tests

1. Rewrote `ClaudeSDKBridge` tests to cover invocation-mode routing.
2. Added tests for the epoch guard, invocation mode gating, and attachment fallback.
3. Updated existing tests to match the refactored attachment and session code.
