# Session Runtime State Authority Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement
> this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provider, model, and permission runtime state session-scoped and backend-authoritative for both Claude and Codex, so normal message
sends cannot overwrite an existing tab session with frontend defaults.

**Architecture:** New sessions initialize runtime state from backend settings; restored/existing sessions use persisted session state. Frontend
localStorage remains a UI preference cache only, while explicit user actions use dedicated backend commands to mutate the current session. Normal
`send_message` payloads carry message content, agent, file tags, attachments, and no provider/permission runtime defaults.

**Tech Stack:** Java 17 IntelliJ plugin backend, Gson bridge handlers, React 19 + TypeScript webview, Vitest, Gradle.

---

## Current Context

The Claude concurrency bug showed that frontend defaults can accidentally override backend session state. The same class of risk exists for generic
state:

- `webview/src/hooks/useMessageSender.ts` sends `permissionMode` in normal message payloads.
- `src/main/java/com/github/claudecodegui/session/SessionSendService.java` currently resolves permission as
  `requestedPermissionMode > sessionMode > default`.
- `webview/src/hooks/providers/useModelStatePersistence.ts` hydrates provider/model/mode from `localStorage` and sends `set_provider`, `set_model`,
  `set_mode` on mount.
- `webview/src/hooks/useModelProviderState.ts` uses `set_provider`, `set_model`, `set_mode` for explicit user changes.
- `src/main/java/com/github/claudecodegui/handler/PermissionModeHandler.java` currently writes `set_mode` into both session and persistent settings.
- `src/main/java/com/github/claudecodegui/session/SessionLifecycleManager.java` currently preserves old session provider/model/permission into some
  new-session paths. This must be reviewed against the new rule.

Target behavior:

- New session: initialize provider/model/permission from backend basic config/default settings.
- Existing session: use `SessionState` values; ordinary sends must not override them.
- Frontend: may request current session state and may send explicit user-change commands; normal send payload must not carry runtime defaults.
- Backend: validates and owns state transitions; Codex `plan` still downgrades to `default`.

## File Structure

- Modify `src/main/java/com/github/claudecodegui/session/SessionState.java`
    - Add provider validation and keep session-scoped provider/model/permission APIs strict.
- Modify `src/main/java/com/github/claudecodegui/session/SessionSendService.java`
    - Make permission resolution session-first for existing sessions.
- Modify `src/main/java/com/github/claudecodegui/session/SessionLifecycleManager.java`
    - Initialize new sessions from backend defaults instead of previous session runtime state.
    - Push current session runtime state to frontend after new-session/history-load bootstrap.
- Modify `src/main/java/com/github/claudecodegui/handler/PermissionModeHandler.java`
    - Split explicit session mode changes from persistent default changes if needed.
- Modify `src/main/java/com/github/claudecodegui/handler/provider/ModelProviderHandler.java`
    - Ensure `set_provider` and `set_model` are treated as explicit session changes only when fired from user interaction, not mount hydration.
- Modify `src/main/java/com/github/claudecodegui/handler/ProjectConfigHandler.java` or create `SessionRuntimeStateHandler.java`
    - Add `get_session_runtime_state` and optionally `set_session_runtime_state`.
- Modify `webview/src/hooks/useMessageSender.ts`
    - Remove `permissionMode` from normal message payload.
- Modify `webview/src/hooks/providers/useModelStatePersistence.ts`
    - Stop sending backend `set_provider`, `set_model`, `set_mode` during localStorage hydration.
- Modify `webview/src/hooks/useModelProviderState.ts`
    - Keep explicit user-change commands, possibly rename events to `set_session_provider`, `set_session_model`, `set_session_mode`.
- Modify `webview/src/hooks/windowCallbacks/registerCallbacks/usageModeCallbacks.ts`
    - Add session runtime state callback to hydrate UI from backend session state.
- Modify `webview/src/global.d.ts`
    - Add callback types for session runtime state.
- Tests:
    - `src/test/java/com/github/claudecodegui/session/SessionSendServiceTest.java`
    - `src/test/java/com/github/claudecodegui/session/SessionStateTest.java`
    - Existing or new Vitest tests near `webview/src/hooks/useMessageSender.context.test.ts`
    - New test for `useModelStatePersistence` if a harness already exists; otherwise create
      `webview/src/hooks/providers/useModelStatePersistence.test.ts`.

---

## Chunk 1: Backend Permission Resolution

### Task 1: Make Session Permission Mode Authoritative During Sends

**Files:**

- Modify: `src/test/java/com/github/claudecodegui/session/SessionSendServiceTest.java`
- Modify: `src/main/java/com/github/claudecodegui/session/SessionSendService.java`

- [ ] **Step 1: Write failing tests**

Add tests proving existing session mode wins over payload mode:

```java
@Test
public void resolveEffectivePermissionModeKeepsSessionModeWhenRequestedDiffers() {
    assertEquals(
            "default",
            SessionSendService.resolveEffectivePermissionMode("claude", "bypassPermissions", "default")
    );
    assertEquals(
            "acceptEdits",
            SessionSendService.resolveEffectivePermissionMode("codex", "bypassPermissions", "acceptEdits")
    );
}

@Test
public void resolveEffectivePermissionModeDowngradesCodexPlanAfterSessionResolution() {
    assertEquals(
            "default",
            SessionSendService.resolveEffectivePermissionMode("codex", null, "plan")
    );
}
```

- [ ] **Step 2: Run red test**

Run:

```bash
rtk .\gradlew.bat test --tests com.github.claudecodegui.session.SessionSendServiceTest
```

Expected: new `resolveEffectivePermissionModeKeepsSessionModeWhenRequestedDiffers` fails because requested mode currently wins.

- [ ] **Step 3: Implement minimal backend change**

Change `resolveEffectivePermissionMode` to:

```java
public static String resolveEffectivePermissionMode(String provider, String requestedMode, String sessionMode) {
    String resolvedMode = normalizeRequestedPermissionMode(sessionMode);
    if (resolvedMode == null) {
        resolvedMode = requestedMode;
    }
    if (resolvedMode == null) {
        resolvedMode = "default";
    }

    if ("codex".equals(provider) && "plan".equals(resolvedMode)) {
        return "default";
    }
    return resolvedMode;
}
```

Keep `requestedMode` fallback only for legacy callers where session has not been initialized.

- [ ] **Step 4: Run green test**

Run:

```bash
rtk .\gradlew.bat test --tests com.github.claudecodegui.session.SessionSendServiceTest
```

Expected: all tests in `SessionSendServiceTest` pass.

### Task 2: Validate Provider Values in Session State

**Files:**

- Modify: `src/test/java/com/github/claudecodegui/session/SessionStateTest.java`
- Modify: `src/main/java/com/github/claudecodegui/session/SessionState.java`

- [ ] **Step 1: Write failing tests**

Add provider validation tests:

```java
@Test
public void providerRejectsUnknownValues() {
    SessionState state = new SessionState();
    state.setProvider("codex");

    state.setProvider("bad-provider");

    assertEquals("codex", state.getProvider());
}

@Test
public void providerAcceptsKnownValues() {
    SessionState state = new SessionState();

    state.setProvider("codex");
    assertEquals("codex", state.getProvider());

    state.setProvider("claude");
    assertEquals("claude", state.getProvider());
}
```

- [ ] **Step 2: Run red test**

Run:

```bash
rtk .\gradlew.bat test --tests com.github.claudecodegui.session.SessionStateTest
```

Expected: provider reject test fails because `setProvider` currently accepts arbitrary strings.

- [ ] **Step 3: Implement validation**

Add `VALID_PROVIDERS = Set.of("claude", "codex")` and update `setProvider`:

```java
public void setProvider(String provider) {
    if (provider == null) {
        return;
    }
    String trimmed = provider.trim();
    if (VALID_PROVIDERS.contains(trimmed)) {
        this.provider = trimmed;
    }
}
```

- [ ] **Step 4: Run green test**

Run:

```bash
rtk .\gradlew.bat test --tests com.github.claudecodegui.session.SessionStateTest
```

Expected: `SessionStateTest` passes.

---

## Chunk 2: New Session Initialization From Backend Defaults

### Task 3: Define Backend Default Runtime State Reader

**Files:**

- Modify: `src/main/java/com/github/claudecodegui/session/SessionLifecycleManager.java`
- Optionally test via extracted static helper in `src/test/java/com/github/claudecodegui/session/SessionLifecycleManagerTest.java`

- [ ] **Step 1: Add a small helper design**

Add a private helper in `SessionLifecycleManager`:

```java
private void initializeSessionRuntimeDefaults(ClaudeSession session) {
    session.setProvider(readDefaultProvider());
    session.setPermissionMode(readDefaultPermissionMode(session.getProvider()));
    session.setModel(readDefaultModel(session.getProvider()));
    session.setClaudeInvocationMode(readClaudeInvocationMode());
}
```

Use existing settings sources where possible:

- provider: current active provider/default provider config if available, else `"claude"`.
- permission: `PropertiesComponent` permission key for now, with Codex `plan` downgrade.
- model: current configured model if existing code has a settings source, else existing defaults.
- Claude invocation mode: existing `readClaudeInvocationMode()`.

- [ ] **Step 2: Update `createDefaultSession()`**

Change:

```java
private ClaudeSession createDefaultSession() {
    ClaudeSession session = new ClaudeSession(host.getProject(), host.getClaudeSDKBridge(), host.getCodexSDKBridge());
    initializeSessionRuntimeDefaults(session);
    return session;
}
```

- [ ] **Step 3: Stop preserving previous runtime state for true new session**

In `createNewSession()`, stop carrying over:

- `previousProvider`
- `previousModel`
- `previousPermissionMode`

Only keep values that are not runtime authority, such as cwd if current behavior requires it.

New session should call `createDefaultSession()` and then bootstrap.

- [ ] **Step 4: Review template behavior**

For `createNewSessionFromTemplate(SessionTemplate template)`, keep template overrides because the template is an explicit user-selected source. Apply
defaults first, then template fields.

- [ ] **Step 5: Review history load behavior**

For `loadHistorySession`, continue restoring provider from history request/persisted provider where provided. If no provider is supplied, use current
session provider only if this is explicit history context; otherwise use backend default. Document the chosen behavior in a short code comment.

- [ ] **Step 6: Verify compile**

Run:

```bash
rtk .\gradlew.bat compileJava testClasses
```

Expected: build succeeds.

---

## Chunk 3: Session Runtime State Sync API

### Task 4: Add Session Runtime State Query

**Files:**

- Modify: `src/main/java/com/github/claudecodegui/handler/SettingsHandler.java`
- Modify: `src/main/java/com/github/claudecodegui/handler/ProjectConfigHandler.java` or create
  `src/main/java/com/github/claudecodegui/handler/SessionRuntimeStateHandler.java`
- Modify: `webview/src/global.d.ts`
- Modify: `webview/src/hooks/windowCallbacks/registerCallbacks/usageModeCallbacks.ts`
- Modify: `webview/src/hooks/windowCallbacks/settingsBootstrap.ts`
- Test: `webview/src/hooks/useWindowCallbacks.test.ts`

- [ ] **Step 1: Backend route**

Add supported type:

```java
"get_session_runtime_state"
```

Add handler response:

```json
{
  "provider": "claude",
  "model": "claude-sonnet-4-6",
  "permissionMode": "bypassPermissions",
  "claudeInvocationMode": "cli"
}
```

For Codex session, `claudeInvocationMode` can be omitted or null.

- [ ] **Step 2: Frontend callback type**

Add to `webview/src/global.d.ts`:

```ts
updateSessionRuntimeState?: (json: string) => void;
```

- [ ] **Step 3: Frontend callback implementation**

In `usageModeCallbacks.ts`, parse payload and update:

- `setPermissionMode`
- `setClaudePermissionMode` or `setCodexPermissionMode`
- `setSelectedClaudeModel` or `setSelectedCodexModel`
- `window.__CLAUDE_INVOCATION_MODE__` only from `claudeInvocationMode`

Provider state itself may need a setter in `UseWindowCallbacksOptions`; add it if not currently available.

- [ ] **Step 4: Request session state on mount**

In `settingsBootstrap.ts`, request:

```ts
sendBridgeEvent('get_session_runtime_state');
```

This should replace separate session-mode requests where possible.

- [ ] **Step 5: Test callback**

Update `useWindowCallbacks.test.ts` or add focused callback test:

```ts
act(() => {
  window.updateSessionRuntimeState?.(JSON.stringify({
    provider: 'codex',
    model: 'gpt-5-codex',
    permissionMode: 'default',
  }));
});

expect(opts.setPermissionMode).toHaveBeenCalledWith(expect.any(Function) or 'default');
expect(opts.setCodexPermissionMode).toHaveBeenCalled();
```

Keep this focused; do not fix unrelated unstable tests in this task.

---

## Chunk 4: Remove Runtime Defaults From Normal Sends

### Task 5: Remove `permissionMode` From Message Payload

**Files:**

- Modify: `webview/src/hooks/useMessageSender.ts`
- Modify: `webview/src/hooks/useMessageSender.context.test.ts`
- Modify: `src/main/java/com/github/claudecodegui/handler/SessionHandler.java` only if cleanup is needed after frontend removal.

- [ ] **Step 1: Write failing frontend test**

Add/modify a normal message test:

```ts
it('does not include permissionMode in normal send payload', () => {
  const opts = createOptions({ currentProvider: 'codex', permissionMode: 'bypassPermissions' });
  const { result } = renderHook(() => useMessageSender(opts));

  act(() => {
    result.current.handleSubmit('hello');
  });

  const calls = (window.sendToJava as any).mock.calls.map(([payload]: [string]) => payload);
  const sendMessageCall = calls.find((payload: string) => payload.startsWith('send_message:'));
  const payload = JSON.parse(sendMessageCall!.substring('send_message:'.length));
  expect(payload).not.toHaveProperty('permissionMode');
});
```

- [ ] **Step 2: Run red test**

Run:

```bash
rtk proxy powershell -NoProfile -Command "Set-Location webview; cmd /c npm.cmd exec vitest run src/hooks/useMessageSender.context.test.ts"
```

Expected: fails because `permissionMode` is currently included.

- [ ] **Step 3: Remove payload field**

In `sendMessageToBackend`, remove:

```ts
permissionMode: effectivePermissionMode
```

from `send_message`, attachment, and fallback payloads.

Keep `effectivePermissionMode` only if it is still used for logging; otherwise remove the local calculation and debug log.

- [ ] **Step 4: Run green test**

Run the same Vitest command.

Expected: passes.

### Task 6: Keep Backend Parsing Backward Compatible

**Files:**

- Keep: `src/main/java/com/github/claudecodegui/handler/SessionHandler.java`
- Keep: `src/main/java/com/github/claudecodegui/session/SessionSendService.java`

- [ ] **Step 1: Do not remove parsing yet**

Leave backend parsing of `permissionMode` in place for compatibility with older webviews or external bridge calls. Because `SessionSendService` is
session-first after Task 1, a stale payload cannot override session state.

- [ ] **Step 2: Add a code comment**

Near payload parse in `SessionHandler`, add:

```java
// Legacy compatibility only. Normal webview sends do not use permissionMode;
// SessionSendService resolves session mode before requested mode.
```

---

## Chunk 5: Stop Mount Hydration From Mutating Backend Session

### Task 7: Remove Backend Sync From `useModelStatePersistence` Mount

**Files:**

- Modify: `webview/src/hooks/providers/useModelStatePersistence.ts`
- Create/modify: `webview/src/hooks/providers/useModelStatePersistence.test.ts`

- [ ] **Step 1: Write failing test**

Create a hook test that sets localStorage and mounts `useModelStatePersistence`, then verifies no bridge commands are sent:

```ts
it('hydrates local UI preferences without mutating backend session state', () => {
  localStorage.setItem('model-selection-state', JSON.stringify({
    provider: 'codex',
    codexModel: 'gpt-5-codex',
    claudeModel: 'claude-sonnet-4-6',
    claudePermissionMode: 'bypassPermissions',
    codexPermissionMode: 'default',
    longContextEnabled: true,
    reasoningEffort: 'high',
  }));
  window.sendToJava = vi.fn();

  renderHook(() => useModelStatePersistence(createOptions()));

  vi.runAllTimers();

  expect(window.sendToJava).not.toHaveBeenCalledWith(expect.stringContaining('set_provider:'));
  expect(window.sendToJava).not.toHaveBeenCalledWith(expect.stringContaining('set_mode:'));
  expect(window.sendToJava).not.toHaveBeenCalledWith(expect.stringContaining('set_model:'));
});
```

Use fake timers if needed because current code delays sync by 200 ms.

- [ ] **Step 2: Run red test**

Run:

```bash
rtk proxy powershell -NoProfile -Command "Set-Location webview; cmd /c npm.cmd exec vitest run src/hooks/providers/useModelStatePersistence.test.ts"
```

Expected: fails because current hook sends `set_provider`, `set_model`, `set_mode`.

- [ ] **Step 3: Remove backend sync block**

Delete the `syncToBackend` function and `setTimeout(syncToBackend, 200)` from `useModelStatePersistence`.

The hook should only hydrate React state and persist local UI preferences.

- [ ] **Step 4: Run green test**

Run the same Vitest command.

Expected: passes.

---

## Chunk 6: Explicit User Changes Remain Explicit

### Task 8: Rename or Clarify Explicit Session Mutation Events

**Files:**

- Modify: `webview/src/hooks/useModelProviderState.ts`
- Modify: `src/main/java/com/github/claudecodegui/handler/SettingsHandler.java`
- Modify: `src/main/java/com/github/claudecodegui/handler/PermissionModeHandler.java`
- Modify: `src/main/java/com/github/claudecodegui/handler/provider/ModelProviderHandler.java`

- [ ] **Step 1: Decide compatibility level**

Recommended: add new event names but keep old names as aliases temporarily.

New explicit session events:

- `set_session_provider`
- `set_session_model`
- `set_session_mode`

Old events:

- `set_provider`
- `set_model`
- `set_mode`

Keep old events routed to the same handlers for compatibility, but update frontend user handlers to use new names.

- [ ] **Step 2: Update frontend explicit handlers**

In `useModelProviderState.ts`:

```ts
sendBridgeEvent('set_session_mode', modeToSet);
sendBridgeEvent('set_session_provider', providerId);
sendBridgeEvent('set_session_model', newModel);
```

Use these only in `handleModeSelect`, `handleModelSelect`, `handleProviderSelect`, and `handleLongContextChange` when user action changes the current
session.

- [ ] **Step 3: Backend route aliases**

In `SettingsHandler`, add supported types and route them to existing handlers:

```java
case "set_session_mode":
    permissionModeHandler.handleSetMode(content);
    return true;
case "set_session_provider":
    modelProviderHandler.handleSetProvider(content);
    return true;
case "set_session_model":
    modelProviderHandler.handleSetModel(content);
    return true;
```

- [ ] **Step 4: Separate persistent defaults if needed**

Review `PermissionModeHandler.handleSetMode`: it currently saves to `PropertiesComponent`. Decide whether explicit session mode changes should also
change defaults.

Recommended behavior:

- `set_session_mode`: updates session only.
- `set_default_mode` or settings UI: updates persistent default.

If implementing this split now, add `handleSetSessionMode` and keep `handleSetMode` as persistent-compatible old behavior until UI migration is
complete.

- [ ] **Step 5: Backend tests**

Add tests for `SessionSendService` and `SessionState`; handler-level tests may be difficult due IntelliJ dependencies. At minimum, compile and inspect
dispatch.

---

## Chunk 7: Verification

### Task 9: Run Focused Tests

- [ ] **Step 1: Backend session tests**

Run:

```bash
rtk .\gradlew.bat test --tests com.github.claudecodegui.session.SessionStateTest --tests com.github.claudecodegui.session.SessionSendServiceTest
```

Expected: pass.

- [ ] **Step 2: Frontend send tests**

Run:

```bash
rtk proxy powershell -NoProfile -Command "Set-Location webview; cmd /c npm.cmd exec vitest run src/hooks/useMessageSender.context.test.ts"
```

Expected: pass.

- [ ] **Step 3: Frontend persistence tests**

Run:

```bash
rtk proxy powershell -NoProfile -Command "Set-Location webview; cmd /c npm.cmd exec vitest run src/hooks/providers/useModelStatePersistence.test.ts"
```

Expected: pass.

- [ ] **Step 4: Compile gate**

Run:

```bash
rtk .\gradlew.bat compileJava testClasses
```

Expected: pass, including `webview` `tsc && vite build`.

### Task 10: Manual Plugin Log Verification

- [ ] **Step 1: Install/run plugin build as usual**

Use the project’s normal plugin testing flow.

- [ ] **Step 2: Verify new-session default**

Set default provider/mode in settings, create a new tab/session, send one message.

Expected log shape:

- session state initialized from backend defaults.
- no `permissionMode` in frontend `send_message` payload.
- backend send uses `session=<mode>` as effective mode.

- [ ] **Step 3: Verify existing-session stability**

Open two tabs with different providers or modes. Change global/basic settings after both tabs exist.

Expected:

- existing tabs do not change provider/mode just because global/basic settings changed.
- new tab/session uses the newly configured defaults.

- [ ] **Step 4: Verify Codex plan downgrade**

Try selecting/forcing `plan` while provider is Codex.

Expected:

- frontend UI shows Codex-effective `default`.
- backend logs effective permission as `default`.

---

## Rollback Plan

If user testing reveals a regression:

- Restore normal send payload `permissionMode` temporarily but keep backend session-first resolution.
- Re-enable old `set_provider/set_mode/set_model` aliases while keeping new explicit names.
- Do not revert session-first backend resolution unless it blocks all sends; that is the primary safety fix.

## Completion Criteria

- Normal sends no longer carry `permissionMode`.
- LocalStorage hydration no longer sends `set_provider`, `set_model`, or `set_mode`.
- Existing sessions are not overwritten by global/default settings changes.
- New sessions initialize from backend defaults.
- Codex `plan` is still downgraded to `default`.
- Focused Java and Vitest tests pass.
- `rtk .\gradlew.bat compileJava testClasses` passes.
