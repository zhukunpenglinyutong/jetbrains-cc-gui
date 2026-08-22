# Antigravity CLI (agy) → plugin provider `gemini`

## Goal

First-class provider id **`gemini`** in jetbrains-cc-gui, backed by **Antigravity CLI** headless NDJSON (`agy -p … --output-format stream-json`), not Claude Agent SDK and not ACP.

## Minimum agy version

**1.1.11** — read-only slash commands answer structurally in print mode (see `status:"ERROR"` and `command_result` below). Older agy still works for chat turns.

## Transport

```
UI provider=gemini
  → SessionSendService.sendToGemini
  → GeminiSDKBridge.sendMessage (one-shot channel-manager)
  → node channel-manager.js gemini send  (stdin JSON, GEMINI_USE_STDIN=true)
  → services/gemini/message-service.js
  → agy-runner.js spawn: agy -p <msg> --output-format stream-json [--conversation id] …
  → agy-event-normalizer.js → Claude-compatible stdout tags
  → GeminiMessageHandler → webview
```

## Multi-turn

`conversation_id` from agy `init` / `result` is stored as plugin `sessionId` and passed back as `--conversation` on later turns.

### Session reset

Clear `sessionId` (no `--conversation` on the next turn) when:

- the user starts a new chat tab session (`createNewSession` already sets id to null)
- Gemini **model** changes (including effort slug changes) — resume of a multi-model fat history is what produced ~2M context on a 128k model
- **provider** switches (Claude/Codex/Gemini ids are not interchangeable)

### cwd / workspaceDirs guard

agy uses process cwd as `workspaceDirs`. Never spawn with:

- JetBrains plugin / Application Support trees
- embedded or standalone `ai-bridge`
- `~/.gemini` / antigravity-cli home

Java `PathUtils.guardWorkingDirectory` + Node `selectWorkingDirectory` / `isUnsafeWorkingDirectory` enforce this; `runAgyTurn` always resolves cwd through `selectWorkingDirectory`.

## Permissions

Headless has no Ask UI. Default: soft-deny. Plugin modes map via `mapPermissionMode`:

| Plugin mode | agy |
|-------------|-----|
| plan | `--mode plan` |
| acceptEdits | `--mode accept-edits` |
| bypass / yolo / dontAsk | `--dangerously-skip-permissions` |
| sandbox | `--sandbox` |

## Auth

User runs `agy` once in a terminal (Google Sign-In). Binary resolution: `AGY_PATH` / `GEMINI_CLI_PATH`, then common install paths, then `PATH`.

## status:"ERROR" vs exit code (agy ≥ 1.1.11)

Interactive-only slash commands (`/clear`, …) now fail fast in print mode: the result payload carries `status:"ERROR"` + actionable `error` text, **but the process still exits 0**. The runner must trust the payload `status`, never the exit code; `message-service` throws `turn.error` to `[SEND_ERROR]` when there is no response text.

## `command_result` stream event (agy ≥ 1.1.11)

`--output-format stream-json` emits `{"event":"command_result","command":{name,data}}` for read-only slash commands, followed by the usual terminal `result` (whose `response` carries the human-readable text). The normalizer stores `commandResult` and emits no bridge tags for it — the text flows via `result` as with any other turn.

## Out of scope (v1)

- On-disk history browser for agy conversations
- Interactive permission dialogs for agy tools
- Persistent daemon ACP session (one-shot per turn is enough)
