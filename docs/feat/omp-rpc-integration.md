# OMP RPC Integration

## Goal

Drive the OMP CLI (`omp`, Oh My Pi) through its RPC mode instead of print mode, so the plugin can use what OMP offers a host: tool approvals, the `ask` tool, native image input, usage and cost, its own slash commands and its usage limits.

## Investigation findings

Verified against `omp 18.18.6` and `18.20.0`. Where `18.12` differs it is noted; that version was not run here.

- `omp --print --mode json` (the previous transport) has no back-channel. A tool that needs approval is refused, the `ask` tool is not registered, and images can only be passed as file paths the model is told to read.
- `omp --mode rpc-ui` is a newline-delimited JSON protocol over stdio (not JSON-RPC). Commands go to stdin; stdout carries a `ready` frame, one `response` per command id, session events, `extension_ui_request` frames and `prompt_result`.
- Approvals arrive as `extension_ui_request` with `method: "select"`, `title: "Allow tool: <name>\n<details>"` and the options `Approve` / `Approve <tool> for this session` / `Deny` (`Approve Once` plus grant choices in `always-ask-cached` mode).
- An approval prompt carries no call id. Its details are whatever the tool's own formatter prints (`Command:` for `bash`, `Path:` and `Content:` for `write`, `File:` for `edit`, `Arguments:` for MCP tools); a tool without a formatter (`read`, `github`, ...) prints nothing. The prompt is written directly and the call's `tool_execution_start` goes through the event stream, so the prompt can arrive first.
- The `ask` tool walks its form field by field: `select` for choices (with an `Other (type your own)` row followed by an `input`), `input` / `editor` for text.
- A checkbox group has no request of its own. OMP sends its options as a `select`, toggles the option that comes back and sends the select again, until the answer is its `✔ Done selecting` row. The closing rows follow the options: "Other" then "Done" in 18.18 and later, "Done" then "Other" in 18.12. The title gains `(N selected) ` once something is selected; which options are checked is not in the frame. There is no "Done" row while nothing is selected in 18.12, and in later versions for a group marked `required`.
- `--thinking <level>` accepts a level the model does not list and runs with the next lower one it has, or its lowest (`xhigh` on `[low, high, max]` runs as `high`).
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

ready                      -> set_event_filter, get_session_stats (context window, the session id)
prompt { message, images } -> session events until prompt_result
agent_start                -> [SESSION_ID] for a new session: omp writes a session file only once an agent run began
prompt_result              -> session_settled first when background work is still running
close stdin                -> omp drains and exits; a builtin acknowledged with agentInvoked: false finishes now
```

- `rpc-client.js` owns the process: request/response correlation by id, every other frame to a callback, exit and stderr reporting, tree kill.
- Stop: the plugin signals the bridge process; the bridge sends `abort`, and kills the process tree if OMP has not wound down after 1.5 s.
- A turn fails with OMP's own message when `prompt_result.status` is `error`, when OMP refuses the prompt, or when the process exits early.
- A builtin that was acknowledged with `agentInvoked: false` (`/handoff`, `/compact`) may still be working in the background: the bridge closes stdin and waits for OMP to exit on its own, so its `command_output` still arrives. Stop ends the wait.
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
| `agent_start` (first one of the turn; the id comes from `get_session_stats`) | `[SESSION_ID]` |

## Tool mapping

`tool-mapping.js` (live stream) and `OmpToolMapper.java` (restored history) apply the same rules, so a session looks the same before and after a reload.

| OMP tool | Rendered as | Source of the data |
| --- | --- | --- |
| `todo` | `TodoWrite` (todo panel) | `details.phases`; abandoned tasks are dropped, blocked ones show as pending |
| `edit` | one `Edit` per changed region | `details.diff` / `details.perFileResults[].diff`; a region ends where the line numbers jump; ids `id`, `id#2`, ... |
| `write` to a plain path, or with `details.resolvedPath` | `Write` | `details.resolvedPath` when known, else the arguments (only for a path OMP does not rewrite) |
| `task` | one `Task` per subagent | `args.tasks[]`; ids `id`, `id#2`, ... |
| anything else, and every failed or unparsable case | unchanged | a fallback `edit` gains `file_path` when derivable |

`todo` and `edit` need their result, so the live stream shows them when they end; other tools show when they start.

In a session file a call id can occur more than once (providers that number calls per response). A result belongs to the latest call with its id that precedes it, so each restored call is mapped with its own result. Relative and `~` paths of restored writes are resolved with POSIX rules when the session directory is a POSIX path, on every host OS; under WSL `~` is the WSL home.

## Dialogs

`ui-bridge.js` answers `extension_ui_request` frames through the existing file IPC (`permission-ipc.js`), one dialog at a time.

- Approval → permission dialog. A call that merely happens to be running is never shown as the one being approved:
  - `bash` and `write` are matched to the running call the prompt prints (allowing for OMP's elision of long values) and shown as `Bash { command, cwd }` and, for a file write to a plain path, `Write { file_path, content }` (which opens the IDE diff review). When the prompt came before its call's start event the bridge waits up to 300 ms for it. Without a match the dialog shows OMP's own text.
  - Other tools show OMP's own text.
  - A prompt that prints nothing about its call cannot be tied to one. After the same wait the dialog lists the arguments of every running call of that tool ("OMP did not say which read call it is asking about. Running now: ...").

  The answer is the once-only choice; "always allow" stays the plugin's decision store.
- `select` / `confirm` / `input` / `editor` → question dialog with `provider: "omp"`. Text typed into a choice question is returned through OMP's "Other" row and its follow-up `input`. A `confirm`, and a `select` or checkbox group without the "Other" row, cannot take typed text: they are sent with `choiceOnly: true`, and the dialog shows no free-text box for them.
- A checkbox group → one multi-select question. Before the dialog opens the bridge finds the preselected options (toggle one, read the count, toggle it back) and marks them `selected`, so the dialog opens with the form's own selection. After the dialog it replays the user's choice as toggles, sends typed text through "Other", and ends with "Done". Rounds that do not count toggles this way are shown one by one, as before.
- An optional group can be submitted empty. The webview names the blank optional question in its answers (`withBlankOptionalAnswers`), because an empty answer map over the file IPC means "dismissed".
- A request OMP withdraws (`cancel`) gets no answer. A dialog still open when the turn ends does not keep the bridge process alive.

## Approval mode

The model-config popover has an **Approvals** row for OMP: Default, Ask (`always-ask`), Auto-approve edits (`write`), Full auto (`yolo`). `Default` passes no flag, so OMP's own `tools.approvalMode` applies. That setting is full auto unless the user changed it, and the row says so.

The choice belongs to the tab and is kept in its Java session state. The webview reports a change with `set_omp_approval_mode`; Java sends the stored mode back (`window.onOmpApprovalModeReceived`) each time a page reports ready, so a webview reload, including the render watchdog's, keeps it. It follows the tab into a new session, a loaded history session and a tab opened from it, and is part of the persisted tab state, so it also survives an IDE restart.

Every message still carries `ompApprovalMode`, and that value is the one used for that send, so two sends in flight cannot swap modes. A send without it (Quick Fix) uses the tab's stored mode.

## Usage, cost and context

Every assistant step emits `[USAGE]` in the Claude schema with OMP's own `cost_usd` and the model's `model_context_window`. `CodexMessageHandler` now accepts these markers for `omp`, which feeds the turn footer and the context ring. `OmpHistoryUsage` restores the same figures from session files. As in the live stream, a step whose token counts are all zero (an aborted or errored step) is skipped. Session files do not record the context window, so it is taken from `OmpContextWindows`, a registry filled from `omp models --json` each time the model list is fetched.

The effort selector lists the levels of the selected model (`omp models --json`, field `thinking`) and passes the stored effort unchanged as `--thinking` (no flag when no level is set). The effort is one value shared by all providers, so for OMP it is not rewritten when the model lacks that level: the selector shows the level OMP will run with instead. `auto`, an unresolved role and a model without a `thinking` list offer `low` to `xhigh`.

## Slash commands

For OMP the `/` list is OMP's catalog (`channel-manager.js omp listCommands <cwd>`, `get_available_commands` over RPC), cached per working directory by `OmpSlashCommandService`. Commands are sent to OMP as typed, including `/plan`, `/context` and `/plugins`. The plugin still handles `/clear`, `/new`, `/reset` (new session) and `/resume`, `/continue` (history view) itself.

A failed fetch keeps the last good list. After a failure the automatic refreshes of that directory (provider switch, session start, directory change, the `set_provider` sent with every message) are skipped for 20 s, then 60 s, then 5 min; a refresh the webview asks for is never skipped.

## Plan usage

`channel-manager.js omp getPlanUsage <model>` resolves the model's provider (through `modelRoles` for `auto` and role ids), runs `omp usage --json --provider <id>` and emits the capacity payload the existing indicator reads. Limits tied to a model family or to the account's plan are included when they apply to the model.

The indicator asks for the selected model (`get_omp_plan_usage:<model>`). A model change drops the reading, resets the failure backoff and polls at once; the reply names the model it was read for, so a late reply for the previous model is ignored. `OmpPlanUsageService` caches readings per model and shares one bridge run among concurrent requests for the same model, without holding a lock while it runs.

## Known limitations

- Sessions started by the plugin have no OMP title; the history list falls back to the first prompt. Sessions titled in the OMP terminal UI show that title.
- A checkbox group marked `required` with nothing preselected looks like a single choice until one option is picked. It is asked as a single choice first and then as a multi-select with that pick checked.
- A radio group's preselected option is not in OMP's frame, so single-choice questions open with nothing selected.
- `always-ask-cached` is not in the picker. When OMP is configured for it, the plugin answers for the current call only.
- `Edit` cards are built from OMP's display diff, one card per changed region.
- Results of background subagents arrive through OMP's `wait` tool, not inside the `Task` card.
- The picker's choice is per tab; there is no global default in the plugin.
- An approval prompt that prints nothing about its call is shown with every running call of that tool, not with the one call it is about.
- `off` and `minimal` thinking cannot be picked: the effort is shared with the other providers, which have no such levels.
- A restored session gets its context window from the model list, which is fetched when the OMP models load. Until that happened once in the IDE run, the ring uses the static table.

## Verification

- `node --test "ai-bridge/**/*.test.js" "ai-bridge/**/*.test.mjs"`
- `cd webview && npx vitest run && npx tsc --noEmit && npx tsc -p tsconfig.test.json --noEmit`
- `./gradlew test` and `./gradlew checkstyleMain`
- Live turns through `OMP_USE_STDIN=true node channel-manager.js omp send` against `omp 18.18.6`, with a script answering the permission files the way the plugin does: resume, streaming usage, `todo` / `edit` / `write` / `task` mapping, approval allowed and denied, `ask`, image input, `/session`, stop during a running command.
- The same way against `omp 18.20.0`: a checkbox question; under `always-ask`, `bash`, `write` and `edit` approvals, two parallel `bash` calls with one allowed and one denied (only the allowed one ran), and a parallel local and `ssh://` `read` (the dialog listed the `ssh://` call). The 18.12 row order, `confirm` and option-only `select` are covered by the bridge tests only.
- `node channel-manager.js omp listCommands <cwd>` and `omp getPlanUsage <model>` against the same installation.
- The webview in a browser with a mocked bridge: Approvals row, effort levels per model, `ompApprovalMode` in the send payload, `/` list, plan-usage indicator.

No `runIde` was run: the permission and question dialogs were exercised through the file IPC, not inside the IDE.
