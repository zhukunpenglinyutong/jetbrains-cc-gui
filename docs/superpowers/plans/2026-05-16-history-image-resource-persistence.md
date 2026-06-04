# History Image Resource Persistence Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist uploaded chat images into plugin-managed local resources, render history from resource URLs instead of base64, and clean up unreferenced files when session history is deleted.

**Architecture:** Add a content-addressed attachment storage service under `~/.codemoss/attachments`, expose stored files through a JCEF resource handler, and record per-session attachment references. New sends persist images before provider handoff so both Claude and Codex histories point at stable local files. History deletion removes per-session references and deletes orphaned stored files.

**Tech Stack:** Java, JCEF resource handlers, Gson JSON index files, existing webview TypeScript renderer.

---

## Chunk 1: Storage And Resource URLs

### Task 1: Add attachment storage and resource URL services

**Files:**
- Create: `src/main/java/com/github/claudecodegui/util/AttachmentStorageService.java`
- Create: `src/main/java/com/github/claudecodegui/util/AttachmentResourceService.java`
- Create: `src/main/java/com/github/claudecodegui/ui/AttachmentResourceRequestHandler.java`
- Modify: `src/main/java/com/github/claudecodegui/ui/WebviewInitializer.java`

- [ ] Implement content-addressed image persistence under `~/.codemoss/attachments/store` plus per-session index files under `~/.codemoss/attachments/index`.
- [ ] Register stored image files behind opaque JCEF URLs and stream them through a dedicated request handler.

## Chunk 2: Send And History Pipelines

### Task 2: Persist image attachments before provider send

**Files:**
- Modify: `src/main/java/com/github/claudecodegui/session/ClaudeSession.java`
- Modify: `src/main/java/com/github/claudecodegui/handler/SessionHandler.java`
- Modify: `src/main/java/com/github/claudecodegui/session/SessionContextService.java`
- Modify: `src/main/java/com/github/claudecodegui/provider/claude/ClaudeRequestParamsBuilder.java`
- Modify: `src/main/java/com/github/claudecodegui/provider/claude/ClaudeCliBridge.java`
- Modify: `src/main/java/com/github/claudecodegui/provider/codex/CodexSDKBridge.java`

- [ ] Extend attachment metadata with persisted file paths.
- [ ] Persist image attachments on receipt from the webview and reuse the persisted path for provider send/history recording.
- [ ] Render live user messages with resource URLs instead of inline base64 when persisted files exist.

### Task 3: Use resource URLs when restoring history

**Files:**
- Modify: `src/main/java/com/github/claudecodegui/handler/history/HistoryMessageInjector.java`
- Modify: `src/main/java/com/github/claudecodegui/provider/claude/ClaudeSessionQueryService.java`

- [ ] Replace history-time file-to-base64 conversion with resource URL registration from persisted/local files.

## Chunk 3: Session Reference Management And Frontend Compatibility

### Task 4: Promote pending attachment indexes and clean on history deletion

**Files:**
- Modify: `src/main/java/com/github/claudecodegui/ui/toolwindow/ClaudeChatWindow.java`
- Modify: `src/main/java/com/github/claudecodegui/handler/history/HistoryDeleteService.java`

- [ ] Promote pending attachment indexes from runtime epoch keys to real session IDs when the SDK returns the session/thread ID.
- [ ] Delete per-session attachment references during history deletion and garbage-collect orphaned stored files.

### Task 5: Keep webview rendering compatible with resource URLs

**Files:**
- Modify: `webview/src/types/index.ts`
- Modify: `webview/src/utils/contentBlockNormalize.ts`
- Modify: `webview/src/components/MessageItem/ContentBlockRenderer.tsx`

- [ ] Support history image blocks that include thumbnail and preview URLs while preserving base64 compatibility.

## Chunk 4: Verification

### Task 6: Run focused validation

**Files:**
- Test: `webview/src/...` existing tests if touched

- [ ] Run targeted frontend tests if affected.
- [ ] Run compile or targeted Gradle tests for new Java code if feasible.
- [ ] Manually sanity-check the image send -> history restore -> delete history cleanup flow through logs and code paths.
