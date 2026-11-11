# OMP RPC Integration

## Goal

Drive the OMP CLI (`omp`, Oh My Pi) through its RPC mode instead of print mode, so the plugin can use what OMP offers a host: tool approvals, the `ask` tool, native image input, usage and cost, its own slash commands and its usage limits.

## Investigation findings

Verified against `omp 18.18.6`.

- `omp --print --mode json` (the previous transport) has no back-channel. A tool that needs approval is refused, the `ask` tool is not registered, and images can only be passed as file paths the model is told to read.
- `omp --mode rpc-ui` is a newline-delimited JSON protocol over stdio (not JSON-RPC). Commands go to stdin; stdout carries a `ready` frame, one `response` per command id, session events, `extension_ui_request` frames and `prompt_result`.
- Approvals arrive as `extension_ui_request` with `method: "select"`, `title: "Allow tool: <name>\n<details>"` and the options `Approve` / `Approve <tool> for this session` / `Deny` (`Approve Once` plus grant choices in `always-ask-cached` mode).
- The `ask` tool walks its form field by field: `select` for choices (with an `Other (type your own)` row followed by an `input`), `input` / `editor` for text.
- A checkbox group has no request of its own. OMP sends its options as a `select`, toggles the option that comes back and sends the select again, until the answer is its last row, `✔ Done selecting`. The title gains `(N selected) ` once something is selected; which options are checked is not in the frame. A group marked `required` has no "Done" row while nothing is selected.
- `prompt` accepts `images: [{ type: "image", mimeType, data }]`. Inbound frames larger than the advertised 1 MiB frame size are accepted (tested with 3 MiB).
- `get_session_stats` returns `sessionId` and `contextUsage.contextWindow` without a model call.
- A local slash command (`/session`, `/todo`) answers with `command_output` frames and a `prompt` response carrying `agentInvoked: false`; no `prompt_result` follows.
- `set_event_filter` with `messageUpdates: "delta"` removes the full message snapshot from every `message_update` frame.
- Neither print mode nor RPC mode generates a session title, so sessions started by the plugin have an empty title slot.
- Tool results carry structured `details`: `todo` → `phases[]`, `edit` → a numbered `diff` plus `path` (or `perFileResults[]`), `write` → `resolvedPath`.
- `omp usage --json --provider <id>` reports usage windows (`5h`, `7d`, `monthly`) per provider without a model call.

## Transport

`ai-bridge/services/omp/message-service.js` starts one process per turn:

```text
omp --mode rpc-ui [--model <id-or-role>] [--resume <session id>] [--thinking <level>] [--approval-mode <mode>]

ready                      -> set_event_filter, get_session_stats (session id, context window)
prompt { message, images } -> session events until prompt_result
prompt_result              -> session_settled first when background work is still running
close stdin                -> omp drains and exits
```

- `rpc-client.js` owns the process: request/response correlation by id, every other frame to a callback, exit and stderr reporting, tree kill.
- Stop: the plugin signals the bridge process; the bridge sends `abort`, and kills the process tree if OMP has not wound down after 1.5 s.
- A turn fails with OMP's own message when `prompt_result.status` is `error`, when OMP refuses the prompt, or when the process exits early.
- One process per turn keeps the Java side unchanged (`OmpCliBridge` is still a `MarkerCliBridge`). Session continuity comes from `--resume`.
- Commit-message generation and the prompt enhancer still use `omp --print` (`services/cli-ask.js`); they are one-shot and need no dialogs.

## Frame mapping

| OMP frame | Bridge marker |
| --- | --- |
| `message_update` / `text_delta`, `thinking_delta` | `[CONTENT_DELTA]`, `[THINKING_DELTA]` |
| `tool_execution_start`, `tool_execution_end` | `[MESSAGE]` tool_use / tool_result (see tool mapping) |
| `message_end` (assistant) | `[USAGE]` |
| `command_output` | `[CONTENT_DELTA]` |
| `extension_ui_request` | permission or question dialog, answered with `extension_ui_response` |
| `get_session_stats.sessionId` | `[SESSION_ID]` |

## Tool mapping

`tool-mapping.js` (live stream) and `OmpToolMapper.java` (restored history) apply the same rules, so a session looks the same before and after a reload.

| OMP tool | Rendered as | Source of the data |
| --- | --- | --- |
| `todo` | `TodoWrite` (todo panel) | `details.phases`; abandoned tasks are dropped, blocked ones show as pending |
| `edit` | one `Edit` per changed region | `details.diff` / `details.perFileResults[].diff`; ids `id`, `id#2`, ... |
| `write` to a plain path | `Write` | arguments; `details.resolvedPath` when known |
| `task` | one `Task` per subagent | `args.tasks[]`; ids `id`, `id#2`, ... |
| anything else, and every failed or unparsable case | unchanged | a fallback `edit` gains `file_path` when derivable |

`todo` and `edit` need their result, so the live stream shows them when they end; other tools show when they start.

## Dialogs

`ui-bridge.js` answers `extension_ui_request` frames through the existing file IPC (`permission-ipc.js`), one dialog at a time.

- Approval → permission dialog. `bash` is shown as `Bash { command, cwd }`, a file `write` as `Write { file_path, content }` (which opens the IDE diff review), other tools with OMP's own detail text. The answer is the once-only choice; "always allow" stays the plugin's decision store.
- `select` / `confirm` / `input` / `editor` → question dialog with `provider: "omp"`. Text typed into a choice question is returned through OMP's "Other" row and its follow-up `input`.
- A checkbox group → one multi-select question. Before the dialog opens the bridge finds the preselected options (toggle one, read the count, toggle it back) and marks them `selected`, so the dialog opens with the form's own selection. After the dialog it replays the user's choice as toggles, sends typed text through "Other", and ends with "Done". Rounds that do not count toggles this way are shown one by one, as before.
- An optional group can be submitted empty. The webview names the blank optional question in its answers (`withBlankOptionalAnswers`), because an empty answer map over the file IPC means "dismissed".
- A request OMP withdraws (`cancel`) gets no answer. A dialog still open when the turn ends does not keep the bridge process alive.

## Approval mode

The model-config popover has an **Approvals** row for OMP: Default, Ask (`always-ask`), Auto-approve edits (`write`), Full auto (`yolo`). The choice is stored per tab and sent as `ompApprovalMode` with every message. `Default` passes no flag, so OMP's own `tools.approvalMode` applies.

## Usage, cost and context

Every assistant step emits `[USAGE]` in the Claude schema with OMP's own `cost_usd` and the model's `model_context_window`. `CodexMessageHandler` now accepts these markers for `omp`, which feeds the turn footer and the context ring. `OmpHistoryUsage` restores the same figures from session files.

The effort selector passes `low` to `max` unchanged as `--thinking`, sends no flag when no level is set, and lists the levels of the selected model (`omp models --json`, field `thinking`).

## Slash commands

For OMP the `/` list is OMP's catalog (`channel-manager.js omp listCommands <cwd>`, `get_available_commands` over RPC), cached per working directory by `OmpSlashCommandService`. Commands are sent to OMP as typed, including `/plan`, `/context` and `/plugins`. The plugin still handles `/clear`, `/new`, `/reset` (new session) and `/resume`, `/continue` (history view) itself.

## Plan usage

`channel-manager.js omp getPlanUsage <model>` resolves the model's provider (through `modelRoles` for `auto` and role ids), runs `omp usage --json --provider <id>` and emits the capacity payload the existing indicator reads. Limits tied to a model family or to the account's plan are included when they apply to the model.

## Known limitations

- Sessions started by the plugin have no OMP title; the history list falls back to the first prompt. Sessions titled in the OMP terminal UI show that title.
- A checkbox group marked `required` with nothing preselected looks like a single choice until one option is picked. It is asked as a single choice first and then as a multi-select with that pick checked.
- A radio group's preselected option is not in OMP's frame, so single-choice questions open with nothing selected.
- `always-ask-cached` is not in the picker. When OMP is configured for it, the plugin answers for the current call only.
- `Edit` cards are built from OMP's display diff, one card per changed region.
- Results of background subagents arrive through OMP's `wait` tool, not inside the `Task` card.
- The picker's choice is per tab; there is no global default in the plugin.

## Verification

- `node --test "ai-bridge/**/*.test.js" "ai-bridge/**/*.test.mjs"`
- `cd webview && npx vitest run && npx tsc --noEmit && npx tsc -p tsconfig.test.json --noEmit`
- `./gradlew test` and `./gradlew checkstyleMain`
- Live turns through `OMP_USE_STDIN=true node channel-manager.js omp send` against `omp 18.18.6`, with a script answering the permission files the way the plugin does: resume, streaming usage, `todo` / `edit` / `write` / `task` mapping, approval allowed and denied, `ask`, image input, `/session`, stop during a running command.
- `node channel-manager.js omp listCommands <cwd>` and `omp getPlanUsage <model>` against the same installation.
- The webview in a browser with a mocked bridge: Approvals row, effort levels per model, `ompApprovalMode` in the send payload, persistence across reload, `/` list, plan-usage indicator.

No `runIde` was run: the permission and question dialogs were exercised through the file IPC, not inside the IDE.
