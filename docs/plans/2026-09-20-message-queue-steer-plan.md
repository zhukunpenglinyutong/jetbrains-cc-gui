# Message Queue Steer Plan

**Date**: 2026-09-20
**Status**: Ready to implement
**Scope**: Claude provider first; queue UX stays unchanged for unsupported providers
**Out of scope**: Codex / Grok / ZCode / Marker CLI native steer; `SdkDefinition` minRequiredVersion bump; interrupt+resubmit as a steer substitute

This plan is the single source of truth for the feature. Implement only what is listed here.

---

## Locked decisions

| # | Decision |
|---|---|
| 1 | Enter still queues. Original send/stop/reorder/remove interaction does not change. |
| 2 | Steer is a per-row button on the queue, to the left of the delete button. Icon: `codicon-run-above`. |
| 3 | Do not raise `SdkDefinition.CLAUDE_SDK.minRequiredVersion`. Gate the button at runtime from `claude_code_version` (CLI >= 2.1.220) plus `query.cancelAsyncMessage`. |
| 4 | If the CLI ends the turn before folding the steer, cancel it and return the item to the frontend queue so the existing auto-send path delivers it as a normal `send_message`. |
| 5 | Attachments are supported on steer. One event covers both: `steer_message`. |
| 6 | Provider-agnostic protocol (`<provider>.steer`, `[CAPABILITIES]`, steer receipts). Claude is the first `STEER_HANDLERS` / `SteerCapableBridge` implementation. |
| 7 | After a successful fold, split the assistant transcript at the fold boundary so live view matches history. |
| 7b | **Superseded 2026-09-24**: the steered user bubble is inserted optimistically the moment steer is clicked, not at the fold. The queue row disappears at the same time (it stays in queue state and `steeringItemsRef` so `rejected`/`undelivered` can restore it). Until the fold receipt, the bubble carries a `steerPending` marker (run-above badge + spinner) so the UI never claims the model has read a message it has not seen yet. |
| 8 | Unsupported providers: hide the button. Queue keeps today's "send after this turn" behavior. No interrupt+resend fallback. |

---

## Current behavior (baseline)

The queue is frontend-only. While `loading === true`, `handleSubmit` calls `enqueue`. When loading flips to false, `useMessageQueue` dequeues index 0 and calls `executeMessage`, which starts a new `send_message` turn.

Three layers treat one user message as one full turn:

- Java `SessionHandler` → `ClaudeSession.send()` → `ClaudeSDKBridge.sendMessage`
- `ai-bridge/daemon.js` serializes `claude.send` on `commandQueue` (one `activeRequestId`)
- `executeTurn` enqueues one user message and breaks on the first `result`

That is CLI `priority: 'later'`, not steer.

---

## Target behavior

### Queue row

Supported (Claude, CLI >= 2.1.220, turn in progress):

```text
[drag] [n] [preview] [run-above] [close]
```

Unsupported (other providers, Claude CLI too old, no live turn):

```text
[drag] [n] [preview] [close]
```

- Icon: `codicon-run-above` (play triangle + "above", matches "inject into the turn above").
- Tooltip: `chat.queue.steerNow` — EN "Send now (steer the current turn)" / ZH "立即发送（插入当前回合）".
- Steered user bubble in the transcript uses the same small `codicon-run-above` badge so the button and the inserted message match.

### Transcript

Clicking steer puts the bubble in the transcript immediately (decision 7b), so there is no waiting for the fold to see it.

```text
User: refactor this module
Assistant (segment 1): thinking / tools / partial answer for the original prompt
Assistant (segment 1 continues streaming above the bubble)
User (steered, badge + spinner): do not touch file B
Assistant (segment 2, after the fold): continues with the steer applied
```

The row leaves the queue at the same moment. Until the fold receipt, the bubble keeps a `steerPending` marker (spinner inside the badge, tooltip `chat.queue.steering`), because the CLI only picks the command up after a tool batch and the message must not look delivered before then.

The split point is still the CLI fold point (after a tool batch, before the next model call), the same place JSONL records `queued_command` parented to the tool_result: on `[STEER_FOLDED]` segment 1 is settled and segment 2 gets a fresh streaming placeholder.

If the CLI never folds, nothing is left stranded in the transcript: `rejected` retracts the bubble and returns the row in place, `undelivered` retracts it and requeues the item at the head.

Steered user messages are not rewind targets (CLI does not persist a uuid-stamped user row for a fold). Hide rewind on those bubbles.

### Receipts

| Status | When | Frontend |
|---|---|---|
| `accepted` | Daemon found a live turn and enqueued with `priority: 'next'` | No-op: the row was already hidden and the bubble already shows `steering` |
| `folded` | CLI folded the command into the running turn | Dequeue the row, clear `steerPending` on the existing bubble, start assistant segment 2 |
| `rejected` | No live turn / version too old / session mismatch / unsupported provider / timeout | Retract the bubble, restore item in place, toast by reason |
| `undelivered` | Turn ended before fold, or abort destroyed the runtime, and `cancelAsyncMessage` succeeded | Retract the bubble, requeue at head; existing idle effect sends as `send_message` |

### Unsupported providers

1. UI: do not render the steer button (`canSteer = loading && capabilities.steer`).
2. Capabilities default to `{ steer: false }` on session switch. Only a live `[CAPABILITIES] {"steer":true}` turns the button on.
3. Backend: if `steer_message` still arrives, reject with `unsupported_provider`. Do not mutate busy/loading. Do not append a transcript row.

---

## Architecture

```text
webview                         Java                                ai-bridge
─────────────                   ──────────────────────              ────────────────────────
steer_message  ──────────────►  SessionHandler
                                └► ClaudeSession.steer
                                   └► SessionSteerService
                                      └► SteerCapableBridge         method "<provider>.steer"
                                         (ClaudeSDKBridge)          (bypasses commandQueue)
                                                                    STEER_HANDLERS.claude
                                                                    = steerMessagePersistent

onProviderCapabilities ◄──────  SessionState.capabilities ◄──────  [CAPABILITIES] in turn stream
onSteerResult          ◄──────  notifySteerResult          ◄──────  steer command receipt
onSteerFolded          ◄──────  notifySteerFolded          ◄──────  [STEER_FOLDED] in turn stream
onSteerResult(undelivered) ◄──  notifySteerResult          ◄──────  [STEER_UNDELIVERED]
```

Extensibility: a later provider only needs (a) a `STEER_HANDLERS` entry, (b) a `SteerCapableBridge` implementation, (c) the same `[CAPABILITIES]` / fold / undelivered tags. Queue UI does not change.

---

## Layer design

### 1. Daemon (`ai-bridge`)

New file `ai-bridge/services/claude/steer-service.js` so `persistent-query-service.js` does not keep growing.

**Capability**

- Record `runtime.claudeCodeVersion` from `system/init.claude_code_version`.
- `steer` is true when version >= `2.1.220` **and** `typeof runtime.query.cancelAsyncMessage === 'function'`.
- Emit `[CAPABILITIES] {"steer":boolean}` when init is seen, and again at the start of each `executeTurn` if the version is already known (so every turn stream carries the flag).

**`steerMessagePersistent(params)`**

- Resolve runtime via `getActiveTurnRuntime()`. Reject unless `sessionId` / `runtimeSessionEpoch` match, `runtime.turnSink` exists, capability is true.
- Reject reasons: `no_active_turn | session_mismatch | unsupported_cli_version | runtime_closed | unsupported_provider`.
- Build the user message with existing `buildUserMessage(params, hasAttachments)`, then set `priority: 'next'` and `uuid: crypto.randomUUID()`.
- Track `runtime.pendingSteers.set(uuid, { steerId, enqueuedAt })`.
- `runtime.inputStream.enqueue(msg)`.
- Reply on the steer request id (`writeRawLine`), not the in-flight send's `activeRequestId`.

**`executeTurn` hooks**

1. On `attachment.type === 'queued_command'` with `commandMode` in `{prompt, user-prompt}`: treat the oldest pending steer as folded, move it to `runtime.foldedSteers`, emit `[STEER_FOLDED] {"steerId","uuid","prompt"}` **on the current request stdout** (must stay ordered in the turn stream; do not use `_originalStdoutWrite`).
2. On `result`:
   - `undelivered = pendingSteers - foldedSteers - (result.user_message_uuids ∩ pendingSteers)`.
   - For each undelivered uuid call `query.cancelAsyncMessage(uuid)`:
     - `cancelled: true` → `[STEER_UNDELIVERED] {"steerId"}`, drop from pending.
     - `cancelled: false` (CLI already dequeued it for the next top-level turn — documented race) → **do not break**. Keep reading `turnSink` until a later `result.user_message_uuids` covers that uuid or `queued_turn_count === 0`, so those frames stay on the current request instead of being eaten inter-turn.
   - Then break as today.
3. `abortCurrentTurn`: before `disposeRuntime`, emit `[STEER_UNDELIVERED]` for every pending-not-folded uuid (destroying the subprocess drops the CLI queue).

**`daemon.js`**

Next to the `claude.setPermissionMode` bypass, dispatch `<provider>.steer` through `STEER_HANDLERS[provider]`. Missing handler → `{ delivered: false, reason: 'unsupported_provider' }`.

**Optional but recommended**

Enable `extraArgs: { 'replay-user-messages': null }` only if tests show it does not duplicate the folded user row. Folded rows are inserted by Java from `[STEER_FOLDED]`, not from replay.

### 2. History

`session-service.js` already rewrites `queued_command` attachments with `commandMode === 'task-notification'` into user messages. Extend that rewrite:

- `commandMode` in `{prompt, user-prompt}` → `{ type: 'user', message: { role: 'user', content: attachment.prompt }, steered: true }`
- `prompt` may be a string or a content-block array; pass it through.

Flip the existing test `leaves a non-task-notification queued_command attachment untouched`.

Audit Java history readers (`HistoryLoadService`, `SessionConversionService`, `HistoryExportService`, `HistoryMessageInjector`). If any of them parse JSONL without going through `session-service.js`, apply the same rewrite.

### 3. Java

- `SessionHandler`: add `steer_message`. Parse the same fields as `send_message` plus `steerId` and optional `attachments`. Call `ClaudeSession.steer(...)`, not `send(...)`.
- `ClaudeSession.steer(...)`:
  - Do **not** set busy/loading/summary.
  - Do **not** append the user message yet (that happens on fold).
  - Call `SessionSteerService.steer(provider, ...)`.
  - Rejected → `notifySteerResult(steerId, 'rejected', reason)`.
  - Accepted → `notifySteerResult(steerId, 'accepted')`.
- New `SteerCapableBridge` + `SessionSteerService`. `ClaudeSDKBridge` implements it via `steerLive(...)` copied from `setPermissionModeLive` (10s timeout → `rejected/timeout`).
- `ClaudeStreamAdapter`: parse `[CAPABILITIES]`, `[STEER_FOLDED]`, `[STEER_UNDELIVERED]`.
- `ClaudeMessageHandler.handleSteerFolded(payload)` **in this order**:
  1. Append USER message with `raw.steerId` and `raw.steered = true`.
  2. Split: `currentAssistantMessage = null; assistantContent.setLength(0); resetSegmentState();` (reset `replayDedup` too). Later deltas create segment 2 via `ensureCurrentAssistantMessageExists()`.
  3. `notifyMessageUpdate` + `notifySteerFolded(steerId, message)`.
- `[STEER_UNDELIVERED]`: `notifySteerResult(steerId, 'undelivered')`. Transcript has no row to remove if fold never happened.
- `SessionCallback` new defaults: `onSteerResult`, `onSteerFolded`, `onProviderCapabilities`. Adapter forwards to `window.onSteerResult`, `window.onSteerFolded`, `window.onProviderCapabilities`.
- Session switch resets capabilities to `{steer:false}`.

### 4. Frontend

- `QueuedMessage` adds `status: 'queued' | 'steering'`.
- `useMessageQueue`: `markSteering(id)`, `restore(id)`, `requeueAtHead(item)`. Auto-execute only takes the first `status === 'queued'` item.
- `useMessageSender.steerMessage(item)`: reuse payload construction from `sendMessageToBackend` (agent, fileTags, reasoningEffort, attachments). Inserts the optimistic bubble via `utils/steerMessages.buildSteeredUserMessage` and returns whether it dispatched. Do not `setLoading`. Do not reset streaming refs. Send `steer_message` with `steerId`.
- `useAppChatController.handleSteerFromQueue`: `markSteering(id)` only after `steerMessage` reports it dispatched, so the queue row and the bubble change together.
- New `useProviderCapabilities`: listen to `onProviderCapabilities`; reset in `beginSessionTransition`.
- `canSteer = loading && capabilities.steer`.
- `MessageQueue`: `canSteer` + `onSteer(id)`. Button only when `canSteer && item.status === 'queued'`. `status === 'steering'` rows are filtered out of the rendered list (and out of drag/keyboard reorder), since the message now lives in the transcript.
- Callbacks:
  - `accepted` → no-op (the row is already hidden).
  - `folded` → dequeue; `clearSteerPending` on the bubble that is already there (insert it only when a snapshot dropped it); append empty assistant placeholder; point `streamingMessageIndexRef` at the placeholder; clear `streamingContentRef` / `streamingThinkingRef`; bump `__turnId`.
  - `rejected` → `removeSteeredMessage` + `restore(id)` + toast.
  - `undelivered` → `removeSteeredMessage` + `requeueAtHead` from `steeringItemsRef`.
- `utils/steerMessages.ts` holds the pure helpers (`buildSteeredUserMessage`, `getSteerIdOf`, `isSteerPending`, `removeSteeredMessage`, `clearSteerPending`); `ClaudeMessage` gains `steered` / `steerId` / `steerPending`. The bubble is built with `isOptimistic: true` so the existing snapshot guards (`appendOptimisticMessageIfMissing`) keep it alive while the backend has no copy of it yet.
- Guard `messageSync.ts` `preserveLastAssistantIdentity` / streaming patch: when prev last-assistant is segment 1 and next last-assistant is segment 2, do not copy segment 1 identity/content onto segment 2 (`__turnId` or `steerId` boundary).
- Insert the empty assistant placeholder in the same `setMessages` transaction as the steered user message so `findLastAssistantIndex` cannot briefly target segment 1.
- Local slash commands (`/new`, `/plan`, `/context`, …) never steer.
- Interrupt keeps the queue (existing comment). Undelivered items then auto-send when loading becomes false. Session switch still `clearQueuedMessages`.

### 5. i18n and changelog

Keys (all 10 locale files):

- `chat.queue.steerNow`
- `chat.queue.steering`
- `chat.steerRejected.no_active_turn`
- `chat.steerRejected.session_mismatch`
- `chat.steerRejected.unsupported_cli_version`
- `chat.steerRejected.runtime_closed`
- `chat.steerRejected.unsupported_provider`
- `chat.steerRejected.timeout`

Update `webview/src/version/changelog.ts` and `CHANGELOG.md`.

---

## Flows

1. **Happy path**: click run-above → bubble appears in the transcript as pending, queue row hidden → daemon `accepted` → CLI folds at next tool boundary → `[STEER_FOLDED]` → pending badge cleared + assistant split → turn `result`.
2. **Turn ends before fold**: `result` → `cancelAsyncMessage` true → `[STEER_UNDELIVERED]` → requeue at head → loading false → normal `send_message`.
3. **Immediate reject**: no live turn / old CLI / wrong session → `rejected` → bubble retracted, row restored in place + toast.
4. **User interrupt**: abort emits `[STEER_UNDELIVERED]` for pending-not-folded items, then same as flow 2.
5. **Attachments**: same as happy path; `buildUserMessage(params, true)`.
6. **`cancelAsyncMessage` false**: keep reading the extra turn on the current request (protocol race, not a fallback invention).

---

## Risks and checks during P4

These depend on "one turn, one assistant" today. After the split, verify they still aggregate by turn, not by assistant bubble:

- `rewindableMessages` (hide rewind on steered user rows)
- `globalTodos`
- `fileChanges` / `useFileChangesManagement`
- `preserveLastAssistantIdentity` / `appendOptimisticMessageIfMissing`
- non-streaming mode: `handleAssistantMessage` rebuilds `content` from aggregated text; clearing `assistantContent` on fold is enough

Steered messages cannot be rewind targets.

---

## Implementation tasks

Check a box only after the code and the listed tests/compile for that task exist.

### P1 — Daemon steer core

- [ ] **P1.1** Add `ai-bridge/services/claude/steer-service.js`: capability helper (`claude_code_version` >= 2.1.220 and `cancelAsyncMessage`), `steerMessagePersistent`, pending/folded maps, reject-reason enum.
- [ ] **P1.2** Record `runtime.claudeCodeVersion` from `system/init`. Emit `[CAPABILITIES]` on init and at `executeTurn` start.
- [ ] **P1.3** Hook `executeTurn`: fold detection → `[STEER_FOLDED]` on the **current** request stream; `result` undelivered path with `cancelAsyncMessage`; `cancelled:false` keep-reading; abort dumps pending as `[STEER_UNDELIVERED]`.
- [ ] **P1.4** `daemon.js`: bypass `commandQueue` for `<provider>.steer` via `STEER_HANDLERS`; unknown provider returns `unsupported_provider`.
- [ ] **P1.5** Tests in `persistent-query-service.test.js` / new `steer-service.test.js` with scripted query:
  - fold at tool boundary
  - turn ends before fold → undelivered + cancel
  - `cancelAsyncMessage` false → second result stays on the same request
  - abort dumps pending
  - capability false on CLI 2.1.182
  - no active turn → `no_active_turn`

**P1 done when**: scripted tests pass; no Java/webview change required yet.

### P2 — History rewrite

- [ ] **P2.1** Rewrite user-prompt `queued_command` attachments to user messages (`steered: true`) in `session-service.js`.
- [ ] **P2.2** Update `session-service.test.mjs`: reverse "untouched" assertion; add prompt-array and task-notification coexistence cases.
- [ ] **P2.3** Audit Java history load/export/convert/inject. Change only paths that read JSONL without `session-service.js`.

**P2 done when**: reloading a session that was steered in CLI/TUI shows the inserted user row between assistant segments.

### P3 — Java channel

- [ ] **P3.1** Add `SteerCapableBridge` and `SessionSteerService`. Route by provider; missing implementation → `unsupported_provider`.
- [ ] **P3.2** `ClaudeSDKBridge.steerLive` → `claude.steer` (mirror `setPermissionModeLive`, 10s timeout).
- [ ] **P3.3** `SessionHandler` + `ClaudeSession.steer`: parse `steer_message` (text, agent, fileTags, attachments, steerId); do not toggle busy/loading; do not append transcript on accept.
- [ ] **P3.4** `ClaudeStreamAdapter` + `ClaudeMessageHandler`: `[CAPABILITIES]`, `[STEER_FOLDED]` (append user, split assistant, notify), `[STEER_UNDELIVERED]`.
- [ ] **P3.5** `SessionCallback` / `CallbackHandler` / `SessionCallbackAdapter` / `SessionCallbackFacade`: `onSteerResult`, `onSteerFolded`, `onProviderCapabilities`. Reset capabilities on session switch.
- [ ] **P3.6** Java tests: fold splits `currentAssistantMessage`; reject does not set loading; undelivered does not require a transcript remove; capabilities persist on `SessionState`.

**P3 done when**: `gradle test` covering the new classes/handlers is green.

### P4 — Webview

- [ ] **P4.1** `useMessageQueue`: `status`, `markSteering`, `restore`, `requeueAtHead`; auto-execute skips `steering` items. Update `useMessageQueue.test.ts`.
- [ ] **P4.2** `useProviderCapabilities` + reset in session transition. `canSteer = loading && capabilities.steer`.
- [ ] **P4.3** `useMessageSender.steerMessage` + `useAppChatController` wiring. Extract optimistic-user builder only if fold path needs a local copy; default is: no transcript row until `onSteerFolded`.
- [ ] **P4.4** `MessageQueue.tsx` + `banners.css`: `codicon-run-above` left of delete; spinner while steering; hide button when `!canSteer`.
- [ ] **P4.5** Window callbacks: `onSteerResult` / `onSteerFolded` / `onProviderCapabilities`. Fold: dequeue, append steered user, append assistant placeholder, retarget streaming refs, new `__turnId`.
- [ ] **P4.6** Guard `messageSync.ts` so segment 1 is not patched onto segment 2. Hide rewind on `raw.steered` user rows. Badge `codicon-run-above` on steered user bubbles.
- [ ] **P4.7** Check `rewindableMessages`, todos, file-changes still group by turn.

**P4 done when**: webview unit tests pass; Claude shows the button, Codex does not.

### P5 — i18n, changelog, packaging notes

- [ ] **P5.1** Add the i18n keys listed above to all 10 `webview/src/i18n/locales/*.json` files.
- [ ] **P5.2** `CHANGELOG.md` + `webview/src/version/changelog.ts` (EN + ZH).
- [ ] **P5.3** Self-check: no new fallback timers; comments in Chinese with UTF-8; no emoji in code (codicon class names only); existing queue/send/interrupt paths unchanged for non-Claude.

**P5 done when**: changelog and locales are in the same change as the feature.

---

## Task graph

```text
P1.1 ─┬─► P1.2 ─► P1.3 ─► P1.4 ─► P1.5
      │
P2.1 ─┴─► P2.2 ─► P2.3          (P2 can start after P1.1 types exist; parallel with P1.3+)

P1.5 ─► P3.1 ─► P3.2 ─► P3.3 ─► P3.4 ─► P3.5 ─► P3.6
                                    │
P3.4 ─► P4.1 ─► P4.2 ─► P4.3 ─► P4.4 ─► P4.5 ─► P4.6 ─► P4.7
                                                              │
                                              P5.1 ─► P5.2 ─► P5.3
```

Do not start P4 until P3 can emit the three window callbacks. Do not start P3 until P1 tags and the steer method are stable.

---

## Files (expected)

**New**

- `ai-bridge/services/claude/steer-service.js`
- `ai-bridge/services/claude/steer-service.test.js` (or extend existing persistent-query tests)
- `src/main/java/com/github/claudecodegui/session/SessionSteerService.java`
- `src/main/java/com/github/claudecodegui/provider/common/SteerCapableBridge.java`
- `webview/src/hooks/useProviderCapabilities.ts`

**Primary edits**

- `ai-bridge/daemon.js`
- `ai-bridge/services/claude/persistent-query-service.js`
- `ai-bridge/services/claude/runtime-lifecycle.js` (runtime fields only)
- `ai-bridge/services/claude/session-service.js`
- `src/main/java/com/github/claudecodegui/handler/SessionHandler.java`
- `src/main/java/com/github/claudecodegui/session/ClaudeSession.java`
- `src/main/java/com/github/claudecodegui/session/ClaudeMessageHandler.java`
- `src/main/java/com/github/claudecodegui/session/SessionCallback*.java` / `CallbackHandler.java`
- `src/main/java/com/github/claudecodegui/provider/claude/ClaudeSDKBridge.java`
- `src/main/java/com/github/claudecodegui/provider/claude/ClaudeStreamAdapter.java`
- `webview/src/hooks/useMessageQueue.ts`
- `webview/src/hooks/useMessageSender.ts`
- `webview/src/useAppChatController.ts`
- `webview/src/components/ChatInputBox/MessageQueue.tsx`
- `webview/src/components/ChatInputBox/styles/banners.css`
- `webview/src/hooks/windowCallbacks/*`
- `webview/src/i18n/locales/*.json`

Do not modify Codex/Grok/ZCode send paths except to reject `steer` if a shared dispatcher is used.

---

## Acceptance

- Claude + CLI >= 2.1.220: queue row shows `codicon-run-above` left of delete while loading.
- Claude + older CLI, or any other provider: queue row unchanged, no steer button.
- Clicking steer shows the message in the conversation immediately, with a pending badge, and leaves the queue row gone.
- The pending badge clears when the CLI folds the steer at the next tool boundary; the injection does not stop the in-flight tool.
- After fold, chat shows two assistant segments split by the steered user message, live and after history reload.
- If the model finishes before fold, the item returns to the head of the queue and sends as a normal follow-up turn.
- Attachments survive steer.
- Enter, stop, drag-reorder, delete, interrupt, and session-switch queue clearing behave as before.
- `SdkDefinition` floor stays `0.3.182`.
