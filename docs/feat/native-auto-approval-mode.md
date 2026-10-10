# Native Auto-Approval Modes

## Goal

Expose the native automatic approval modes added by Claude Code and Codex while preserving the existing unrestricted `bypassPermissions` behavior as a separate **Full Auto** option.

## Investigation findings

### Claude

- Native mode value: `auto`.
- Agent SDK option: `permissionMode: 'auto'`.
- Runtime updates use the existing `query.setPermissionMode('auto')` control path.
- The SDK delegates approval decisions to Claude's classifier instead of bypassing permission checks.
- `@anthropic-ai/claude-agent-sdk` `0.3.182`, the plugin's current minimum version, already includes `auto` in its `PermissionMode` type.
- Reference: <https://code.claude.com/docs/en/permission-modes>

### Codex

- CLI convenience option observed in some Codex releases: `--approve-for-me` (alias `--not-so-yolo`).
- The plugin uses native app-server thread/turn settings. Codex is detected as a CLI alongside OpenCode; it is no longer installed or checked as an SDK.
- Equivalent configuration:
  - `approvals_reviewer = "auto_review"`
  - `approval_policy = "on-request"`
  - `sandbox_mode = "workspace-write"`
- Native settings carry `approvalsReviewer`, `approvalPolicy`, and the sandbox policy, subject to native managed constraints.
- CLI availability comes from the actual executable. Historical TypeScript SDK version metadata does not gate Auto.
- The CLI alias is version-specific and is not the mechanism used by this plugin.
- Reference: <https://github.com/openai/codex/blob/main/codex-rs/protocol/src/config_types.rs>

## SDK invocation contract

### Claude Agent SDK

The AI Bridge builds the initial query with the normalized mode as a direct SDK option:

```js
const query = queryFn({
  prompt: runtime.inputStream,
  options: {
    cwd,
    permissionMode: 'auto',
    canUseTool,
    hooks: { PreToolUse: [{ hooks: [preToolUseHook] }] },
    settingSources: ['user', 'project', 'local'],
  },
});
```

`permissionMode: 'auto'` is forwarded unchanged by `buildQueryOptions()`. The
`PreToolUse` hook returns `{ continue: true }` for this mode, so it does not make a
second approval decision; Claude Code's native mode flow invokes the classifier,
then sends only unresolved requests to `canUseTool`. A live mode change uses the
existing `query.setPermissionMode('auto')` control request and updates the reactive
mode state read by the hook.

Full Auto is intentionally different: only
`permissionMode: 'bypassPermissions'` adds
`allowDangerouslySkipPermissions: true` to the initial SDK options. That option is a
spawn-time flag, so entering or leaving Full Auto changes the runtime signature and
rebuilds the subprocess. Native `auto` does not add that flag and therefore shares
the live-switch signature with `default`, `plan`, and `acceptEdits`. If Full Auto is
selected while a turn is already running, the current subprocess remains bounded
by its original launch flag; the selected mode is persisted and takes effect when
the next send rebuilds the runtime.

### Codex app-server

Codex runs through the persistent stdio app-server. The initial thread uses
`approvalPolicy: 'on-request'`, `approvalsReviewer: 'auto_review'`, and a guarded
sandbox; each `turn/start` carries the frozen settings revision. Read-only stays
read-only. An incompatible request for unrestricted access is rejected rather
than silently widening access or changing reviewer.

Non-auto presets explicitly select the user reviewer. Approval strategy and
collaboration mode are independent: Plan does not change the current policy.
Native effective-settings notifications confirm what was applied; an RPC ack
does not imply a rejected desired setting became effective.

Native reverse requests are answered before execution, with distinct decline,
cancel, session allowance, and policy amendment results. File-change previews
come from native items; the plugin no longer infers approvals from completed
tools or rolls edits back after decline. Stop keeps the send gate until a native
terminal or confirmed process exit. The sanitized child environment removes
inherited policy overrides; settings travel through RPC.

Codex installation is managed by the CLI detection page. Prompt enhancement and
commit generation also use ephemeral app-server threads, with read-only access
and declined background interactions. See [the runtime contract](../codex/app-server.md).

## Mode model

| Plugin mode | Claude | Codex | Meaning |
|---|---|---|---|
| `default` | `permissionMode: 'default'` | `on-request` | User handles approval requests. |
| `acceptEdits` | `permissionMode: 'acceptEdits'` | Existing balanced mapping | File edits are less interruptive, but approval can still be requested. |
| `auto` | `permissionMode: 'auto'` | `auto_review` + `on-request` + `workspace-write` | Provider-native reviewer handles eligible approval requests. |
| `bypassPermissions` | `permissionMode: 'bypassPermissions'` | `never` with the existing sandbox mapping | Full Auto; ordinary approval checks are bypassed. |

`auto` is exposed only for Claude and Codex. Other CLI providers retain their existing mode list and behavior; in particular, Grok's internal `auto` alias for its existing `/always-approve` control path is not repurposed by this feature.

## Known limitations

### Claude auto mode requires a claude-sonnet model upstream

Claude's native auto mode delegates each tool call to a **server-side safety
classifier that runs on a claude-sonnet model** (currently `claude-sonnet-5`). It is
therefore only available when the upstream API actually serves a claude-sonnet
model. When the classifier model is not available — for example on third-party
relay/proxy endpoints that do not provide sonnet — tool calls that require
classification fail with a retryable error, while read-only operations keep
working:

> `claude-sonnet-5[1m] is temporarily unavailable, so auto mode cannot determine the safety of Bash right now. Wait a moment and then try this action again... reading files, searching code, and other read-only operations do not require the classifier and can still be used.`

Users on endpoints without a claude-sonnet model should pick another permission
mode. Codex's `auto_review` runs locally inside the CLI and does not have this
dependency.

### Claude auto mode honors repository-level allow rules

In `default` mode the plugin's PreToolUse hook answers `ask` for tools with side
effects, so a malicious repository's `.claude/settings.json` allow-rule cannot
silently auto-approve them. In `auto` mode the hook yields to the SDK's native
flow, where matching allow rules are applied **before** the classifier runs —
the same semantics as the Claude Code CLI. Explicit `deny` rules still apply in
every mode. Users opening untrusted repositories should stay in `default` mode.

## Implementation

1. **Canonical mode and persistence**
   - Add `auto` to the Java and TypeScript permission-mode allowlists.
   - Preserve the existing per-provider Webview persistence and backend session/property persistence.
   - Keep `bypassPermissions` unchanged so existing saved Full Auto selections remain valid.
   - Migrate the legacy `autoEdit` alias to canonical `acceptEdits` for providers that support it (`default` for OMP); unsupported CLI provider `auto` values fall back to `default` without changing Grok's internal alias.

2. **Claude native routing**
   - Add `auto` to the AI Bridge Claude mode validator.
   - Let the PreToolUse hook yield to the SDK in `auto`, allowing the native classifier to decide.
   - Keep live switching through `setPermissionMode()`; unlike `bypassPermissions`, `auto` needs no runtime rebuild flag. Centralize failure handling so a rejected SDK control request leaves the local mode unchanged; Full Auto transitions mark a rebuild instead.
   - Update comments and tests that currently call `bypassPermissions` “Auto”, and reject stale runtime-epoch updates.

3. **Codex native routing**
   - Map plugin mode `auto` to `workspace-write`, `on-request`, and `approvalsReviewer: 'auto_review'`.
   - Copy that reviewer value into `CodexOptions.config.approvals_reviewer` before constructing `Codex`.
   - Force Java's permission environment override for `auto` to the native `workspace-write` / `on-request` pair rather than inheriting Full Auto or user sandbox overrides.
   - Reject `auto` before dispatch when the installed Codex SDK is below `0.146.0`, and hide the unsupported choice in the Webview when dependency status is known.
   - Raise Codex's full-feature minimum version to `0.146.0` and refresh fallback versions.

4. **User interface**
   - Add a dedicated `auto` item for Claude and Codex, including the execution-mode choice shown when a Claude plan is approved.
   - Rename the generic `bypassPermissions` display from “Auto” to “Full Auto”.
   - Use a shield/reviewer icon for native auto approval and retain the warning-colored lightning treatment for Full Auto.
   - Add provider-specific Codex wording (“Approve for me”) and update all shipped Webview locales.
   - Add the status-bar label for `auto` and update shipped Java resource bundles.

5. **Documentation and tests**
   - Update SDK permission documentation where the old mode naming is described.
   - Extend Java session validation tests.
   - Extend Claude bridge tests for request construction, live switching, plan-exit mode synchronization, and no-rebuild transitions involving `auto`.
   - Extend Codex mapper/config and event-handler tests for `approvals_reviewer = 'auto_review'`, explicit `user` reviewer resets, and no late Java approval after Codex has started an approved item.
   - Extend `ModeSelect` tests for provider-specific visibility and Full Auto distinction.

## Verification

- `node --check` on all modified AI Bridge JavaScript files.
- `node --test ai-bridge/services/codex/codex-utils.test.js ai-bridge/utils/permission-mapper.test.js ai-bridge/services/claude/permission-mode.test.js ai-bridge/services/claude/runtime-lifecycle.test.js ai-bridge/services/claude/setPermissionModePersistent.test.mjs ai-bridge/services/claude/setPermissionModePersistent.bypass.test.js`
- `cd webview && npm run test`
- `cd webview && npx vitest run src/components/PlanApprovalDialog.test.tsx src/components/ChatInputBox/selectors/ModeSelect.test.tsx src/hooks/providers/cliProviders.test.ts`
- `cd webview && npx tsc -p tsconfig.test.json --noEmit`
- `./gradlew test --tests com.github.claudecodegui.session.SessionStateTest --tests com.github.claudecodegui.session.SessionSendServiceTest --tests com.github.claudecodegui.dependency.DependencyManagerVersioningTest -PskipWebview=true`
- `./gradlew checkstyleMain -PskipWebview=true`
- Locale JSON and Java resource-bundle key checks.
- `git diff --check`

No plugin build or `runIde` is required for this change.

## Implementation status

Completed on 2026-08-31.

- AI Bridge permission, runtime, Codex event, and mapper tests: 113 passed.
- All modified AI Bridge JavaScript files passed `node --check`.
- Webview unit tests: 1,473 passed across 168 files; `npm run test` also passed the TypeScript test configuration.
- Java permission state, provider-mode normalization, session routing, and SDK versioning tests passed.
- `checkstyleMain` passed.
- All Webview locale JSON files and Java mode resource keys validated successfully.
- The local Codex CLI `0.146.0` accepted the config-based reviewer invocation through authentication setup; no authenticated model turn was run.
- `git diff --check` passed.
- No `runIde` or `buildPlugin` was run; Gradle test dependencies did regenerate ignored `build/` artifacts only.
