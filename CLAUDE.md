# CLAUDE.md

**Navigation:** See `.claude/INDEX.md` for keywords and file routing.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: idea-claude-gui

IntelliJ IDEA plugin providing a GUI for Claude Code. React/TypeScript webview + Java plugin + Node.js ai-bridge.

## Design Philosophy

**Goal: Be as close as possible to the Claude Code CLI experience, with a GUI layer on top.**

See [docs/DESIGN.md](docs/DESIGN.md) for full design principles and reference guidelines.

## Architecture

```
webview/          # React frontend (Vite + TypeScript + Ant Design)
ai-bridge/        # Node.js bridge to Claude Agent SDK (stdin/stdout JSON protocol)
src/main/java/    # IntelliJ plugin (Java)
```

### Communication Flow

```
React Webview <--JCEF bridge--> Java Plugin <--stdin/stdout JSON--> ai-bridge <--SDK--> Claude API
     |                              |
     |-- sendToJava('type', data)   |-- MessageDispatcher routes to handlers
     |                              |-- PermissionService handles tool approvals
```

**Key patterns:**
- Webview sends `type:jsonPayload` strings via `window.sendToJava()`
- Java `MessageDispatcher` routes to registered `MessageHandler` implementations
- ai-bridge uses JSON line protocol: one JSON object per line on stdin/stdout
- Permission requests block in ai-bridge until Java responds

## Commands

```bash
# Full test suite
./scripts/test-all.sh

# Component-specific tests
npm test --prefix webview           # React/TypeScript tests
npm test --prefix ai-bridge         # Node.js tests
./gradlew test                      # Java tests

# Single test file
npm test --prefix webview -- src/components/ChatInputBox/ChatInputBox.test.tsx
npm test --prefix webview -- --watch  # Watch mode

# Development
./gradlew clean runIde              # Debug plugin in sandbox IDE
./gradlew clean buildPlugin         # Build distributable (.zip in build/distributions/)

# Build verification (fast, checks plugin ZIP structure)
./gradlew testE2E

# E2E tests (auto-opens Claude GUI panel, requires Rider running)
node tests/e2e/run-all.mjs          # See docs/E2E_TESTING.md for one-time CDP setup
```

## Testing Guidelines

### The Loop
When implementing features: **code → test → fix → verify**

Run tests after changes. If tests fail, fix before moving on.

### Test-First for New Features
For non-trivial features, write failing tests first:
1. Define expected behavior as test cases
2. Verify tests fail
3. Implement until tests pass

### What to Test
- **React components**: User interactions, state changes, bridge calls
- **ai-bridge**: Message handling, API responses
- **Java handlers**: Message routing, file operations

### Test Patterns

**React (Vitest + Testing Library):**
```typescript
it('calls sendToJava when clicked', async () => {
  render(<Component />);
  fireEvent.click(screen.getByRole('button'));
  expect(sendToJava).toHaveBeenCalledWith('action', expect.objectContaining({...}));
});
```

**Watch for test cheating** - review that tests verify actual behavior, not hardcoded values.

## Code Style

- English comments only
- No excessive debug logging in production
- Follow existing patterns in codebase
- English strings for all user-facing text (no i18n)

## Key Files

**Webview (React):**
- `webview/src/App.tsx` - Main React app, message rendering, state management
- `webview/src/utils/bridge.ts` - Java bridge communication (`sendToJava`)
- `webview/src/hooks/useProviderConfig.ts` - Model/provider/reasoning effort state
- `webview/src/hooks/useChatHandlers.ts` - Chat handlers, bridge event dispatch
- `webview/src/components/ChatInputBox/types.ts` - Model and reasoning effort types/constants
- `webview/src/components/PermissionDialog.tsx` - Tool permission UI

**ai-bridge (Node.js):**
- `ai-bridge/bridge.js` - Claude SDK wrapper, JSON line protocol, permission callback

**Java Plugin:**
- `src/main/java/.../ClaudeSDKToolWindow.java` - Plugin entry, JCEF webview setup
- `src/main/java/.../handler/MessageDispatcher.java` - Routes messages to handlers
- `src/main/java/.../handler/SessionHandler.java` - Chat session management
- `src/main/java/.../handler/SettingsHandler.java` - Settings from webview (model, effort, permissions)
- `src/main/java/.../handler/HandlerContext.java` - Per-window mutable state
- `src/main/java/.../session/SessionState.java` - Per-session state
- `src/main/java/.../permission/PermissionService.java` - Tool approval logic
- `src/main/java/.../provider/claude/ClaudeSDKBridge.java` - Spawns ai-bridge process
- `src/main/java/.../provider/claude/ProcessManager.java` - Process registry, cleanup
- `src/main/java/.../bridge/EnvironmentConfigurator.java` - Env vars for spawned processes
- `src/main/java/.../settings/WorkingDirectoryManager.java` - CWD resolution

**Architecture docs:**
- `docs/CODEBASE_MAP.md` - Process spawning paths, lifecycle, env vars, session architecture
- `docs/UPSTREAM_DELTA.md` - Upstream feature analysis and port candidates

## Release Checklist

1. Update version in `build.gradle`
2. Update `CHANGELOG.md` with release notes (format: `##### **vX.Y.Z** (YYYY-MM-DD)`)
3. Commit: `chore: Bump version to X.Y.Z`
4. Tag: `git tag vX.Y.Z`
5. Push: `git push && git push --tags`
6. CI builds and publishes to JetBrains Marketplace automatically on version tags

Note: `build.gradle` auto-generates `<change-notes>` from CHANGELOG.md

## Adding New Features

For full-stack settings/features that span React → Java → bridge.js → SDK, see `.claude/skills/full-stack-feature.md` — documents the exact 11-file path with checklist.

## Fork History

Originally forked from [zhukunpenglinyutong/idea-claude-code-gui](https://github.com/zhukunpenglinyutong/idea-claude-code-gui). Upstream sync abandoned January 2026. See `docs/UPSTREAM_DELTA.md` for full feature delta analysis.

**Key differences from upstream:**
- English-only (removed i18n)
- Claude-only (removed Codex/multi-provider)
- Simplified architecture
- Ported: UTF-8 enforcement, proxy/TLS forwarding, zombie process fixes, CWD dedup, reasoning effort selector
