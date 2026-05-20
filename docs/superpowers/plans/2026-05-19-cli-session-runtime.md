# CLI Session Runtime Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tab-owned CLI runtime boundary for Claude CLI and Codex CLI while keeping the existing SDK/daemon path available.

**Architecture:** Add runtime model classes and a `SessionRuntimeRouter` between `SessionSendService` and provider bridges. CLI sends go through `CliSessionRuntime` and provider-specific adapters; SDK/daemon sends remain behind `SdkSessionRuntime`. Process lifecycle gains `RuntimeKey` methods while preserving current `channelId` APIs.

**Tech Stack:** IntelliJ Platform Java plugin, Gson, existing provider bridge classes, React/Vite webview tests.

---

## Chunk 1: Backend Runtime Boundary

### Task 1: Runtime Model And Process Isolation

**Files:**
- Create: `src/main/java/com/github/claudecodegui/session/runtime/RuntimeKey.java`
- Create: `src/main/java/com/github/claudecodegui/session/runtime/CliRequest.java`
- Create: `src/main/java/com/github/claudecodegui/session/runtime/CliAdapter.java`
- Modify: `src/main/java/com/github/claudecodegui/bridge/ProcessManager.java`
- Test: `src/test/java/com/github/claudecodegui/bridge/ProcessManagerRuntimeKeyTest.java`

- [ ] Add immutable runtime key and CLI request types.
- [ ] Add `ProcessManager` overloads for `RuntimeKey`.
- [ ] Add `interruptRuntime`, provider/channel/tab interrupt, `cleanupRuntime`, and `cleanupTab`.
- [ ] Keep existing raw `channelId` methods unchanged for SDK migration compatibility.
- [ ] Add focused unit tests for registration, interrupt, cleanup, and tab isolation.

### Task 2: Runtime Router

**Files:**
- Create: `src/main/java/com/github/claudecodegui/session/runtime/SessionRuntimeRouter.java`
- Create: `src/main/java/com/github/claudecodegui/session/runtime/SdkSessionRuntime.java`
- Create: `src/main/java/com/github/claudecodegui/session/runtime/CliSessionRuntime.java`
- Modify: `src/main/java/com/github/claudecodegui/session/SessionSendService.java`
- Test: `src/test/java/com/github/claudecodegui/session/runtime/SessionRuntimeRouterTest.java`

- [ ] Add router selection for Claude SDK, Claude CLI, Codex SDK/daemon, and Codex CLI access mode.
- [ ] Build a `CliRequest` in `SessionSendService` for CLI paths.
- [ ] Preserve current SDK calls through `SdkSessionRuntime`.
- [ ] Add stale epoch callback filtering for CLI runtime events.

## Chunk 2: CLI Adapters

### Task 3: Claude CLI Adapter

**Files:**
- Create: `src/main/java/com/github/claudecodegui/session/runtime/ClaudeCliAdapter.java`
- Modify: `src/main/java/com/github/claudecodegui/provider/claude/ClaudeCliBridge.java`
- Modify: `src/main/java/com/github/claudecodegui/provider/claude/ClaudeCliStreamParser.java`
- Test: `src/test/java/com/github/claudecodegui/provider/claude/ClaudeCliStreamParserTest.java`

- [ ] Wrap existing Claude CLI bridge behind `CliAdapter`.
- [ ] Fix parser mapping so assistant `tool_use` emits `tool_use`.
- [ ] Keep local attachment path preference and one-turn temp file cleanup.

### Task 4: Codex CLI Adapter

**Files:**
- Create: `src/main/java/com/github/claudecodegui/session/runtime/CodexCliAdapter.java`
- Modify: `src/main/java/com/github/claudecodegui/provider/codex/CodexSDKBridge.java`
- Test: `src/test/java/com/github/claudecodegui/session/runtime/CodexCliAdapterTest.java`

- [ ] Add direct Codex CLI command builder and fallback text line parser.
- [ ] Map CC GUI permission mode to Codex approval/sandbox environment.
- [ ] Preserve protected env keys and skip API overrides in CLI-login mode.
- [ ] Prefer local image paths; temp files are deleted only if created by this turn.

## Chunk 3: Frontend Scope Metadata

### Task 5: Scoped Streaming State

**Files:**
- Create: `webview/src/hooks/windowCallbacks/streamScopeState.ts`
- Modify: `webview/src/hooks/windowCallbacks/registerCallbacks/messageCallbacks.ts`
- Modify: `webview/src/hooks/windowCallbacks/registerCallbacks/streamingCallbacks.ts`
- Modify: `webview/src/global.d.ts`
- Test: `webview/src/hooks/windowCallbacks/streamScopeState.test.ts`

- [ ] Add per-scope state keyed by `provider:tabId:turnId`.
- [ ] Move pending update coalescing out of `window.__pendingUpdateJson` globals for scoped events.
- [ ] Keep legacy fallback for unscoped backend events.
- [ ] Drop events that target a different active visible scope.

## Chunk 4: Verification

### Task 6: Build And Tests

**Files:**
- Modify only tests needed for the changes above.

- [ ] Run focused Gradle tests for backend runtime/process/parser changes.
- [ ] Run focused webview tests for scoped streaming state.
- [ ] Run compile/build checks where feasible.
