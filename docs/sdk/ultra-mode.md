# Native Ultra / Ultracode integration

The two providers expose different native controls. The plugin lets their own
runtimes create, schedule and supervise agents; it does not inject a delegation
prompt or create a second orchestration layer.

| Provider | Composer control | Native request |
| --- | --- | --- |
| Codex | Effort → Ultra, when advertised by the selected runtime/model | `turn/start.effort = "ultra"` and `collaborationMode.settings.reasoning_effort = "ultra"` |
| Claude Code | Ultracode switch, independent of effort | `query.options.settings.ultracode` at creation; `applyFlagSettings({ ultracode })` on an existing query |

Claude's effort remains one of `low`, `medium`, `high`, `xhigh`, `max`. Sending
`effort: "ultra"` to Claude would not activate its native workflow feature.
When changing Claude effort while Ultracode remains enabled, the native flag
patch includes both `effortLevel` and `ultracode`: an effort-only patch can turn
Ultracode off. Turning the switch off sends an explicit `false`.

## Native compatibility

- Codex's `model/list.supportedReasoningEfforts` is authoritative. A static
  fallback list cannot establish Ultra support. A restored selection survives
  catalog loading and is reconciled only after a successful lookup, including
  an absent custom model or an empty catalog. A failure or timeout cannot
  establish that Ultra is unsupported and does not overwrite the saved choice.
  An unconfirmed Ultra send retains its draft and attachments; the user can
  retry model loading or explicitly choose another effort.
- The installed Codex `0.165.0-alpha.1.2` protocol explicitly deprecates
  `multiAgentMode` as ignored and says to use `effort: "ultra"`. Its catalog
  advertised Ultra for GPT-6 Astra, GPT-6 Sol and GPT-6.1 Sol, but not GPT-6
  Luna. These observations are not a hard-coded availability guarantee.
- Claude's independent Ultracode toggle requires Claude Code **2.1.284+** and
  an SDK exposing the native settings controls. The bridge checks the actual
  spawned CLI, including executable overrides, before submitting a prompt.
  Native workflow availability/model policy remains authoritative; an
  unavailable mode produces an actionable error instead of a normal turn.
  Effort support is not a proxy for Ultracode support: the plugin does not
  require `xhigh`, and confirms the applied native setting before submitting
  the prompt. Rejection preserves the requested switch and explains how to
  choose a supported model, update the CLI, or explicitly turn Ultracode off.
- Account policies, permissions and supported models still apply. The plugin
  does not raise agent limits, broaden filesystem access or bypass approvals.
- Plugin preferences and request snapshots retain the user's choice. The
  bridge uses session-scoped native settings, not writes to the user's Claude
  settings files. Explicit saved tab effort overrides the last-used preference;
  a new tab with no explicit effort inherits it.

## Child lifecycle

Codex's native `subAgentActivity` and collaboration items retain child
identities. A child terminal cannot finish the parent operation; child
approval requests must prove ancestry and retain their own RPC identity.
Native root interruption owns cancellation. Status reads use bounded batches
with fair rotation so a large set of children cannot leave later children
permanently unobserved. Read timeouts are not proof that a child stopped.

Claude's `background_tasks_changed` event supplies the complete live task set.
Each snapshot replaces the previous one; task start/completion edges have
independent ordering and must not reconstruct this set. Ambient watchers are
excluded from activity. The foreground result does not terminate workflows,
and sidechain output does not reopen the foreground turn. Inter-turn events
retain session and runtime-epoch routing. The background panel keeps Stop
available after the main answer, while the composer can accept another turn.
On older CLIs, the bridge publishes a separately marked set of tasks derived
from legacy start/end events. These tasks have the same Stop affordance but do
not establish native snapshot authority or bypass the six-hour backstop.
An empty snapshot received while another provider is selected still retires
the old panel's tasks.

Stop uses the selected Claude runtime, interrupts native work, and closes that
runtime after a bounded cancellation wait. A subsequent send must not reuse
the runtime being stopped. Runtime termination clears its live task snapshot.
Requests still queued or preparing are cancelled before their prompt is sent.
For submitted work, only an acknowledged native interrupt and successful
cleanup produce a cancelled result; a timeout or failed interrupt is reported
as a failure. A Stop with no matching request or runtime is an idempotent,
successful control request with `stopped: false`; it makes no claim that an
original send was cancelled. New Session, template creation, history loading,
and deletion can therefore proceed after the idle runtime has already gone.

A failed Stop belongs to its original operation. A later send may create a
fresh runtime after disposal settles, without inheriting the old cancellation
error. Input closure alone does not release ownership: an unresolved close
keeps the old runtime registered and prevents a second writer for that session.
Idle cleanup does not await an unrelated runtime's hung close.

Session transitions preserve the old binding, transcript and queued drafts
until the backend accepts the transition. Acceptance and completion are scoped
to a request token; an earlier request's late callbacks cannot accept a newer
one. A genuine cleanup failure preserves the old session and releases the UI
guard. A UI timeout keeps queued messages paused until the request completes
or an explicit retry supersedes it. History deletion waits for the backend's
deletion outcome.
Settings that can be applied natively preserve active workers; changes that
require replacing the process cannot silently discard running background work.

Editor file and selection context travels with each user message, separately
from the stable process settings. Switching files therefore refreshes the
context without restarting a runtime or rejecting a send while a background
task runs. The compact payload contains paths, selections and workspace data
without repeating the full IDE guidance on every turn. The recognized trailing
plugin context block is hidden from live bubbles, history, session-list titles
and exports; literal tags in user-authored text remain intact.

Large subagent histories retain their initial task prompt alongside a bounded
tail. The detail view reports when earlier records were omitted.

Legacy CLIs that track background work only through task start/end events keep
the six-hour absolute-lifetime backstop, so a missing completion event cannot
retain an idle process forever. Active foreground turns and native in-flight
work remain protected. Authoritative nonempty background snapshots also keep
the runtime alive until the native work ends.

## Verification

- Native Codex schema generation and read-only `model/list` inspection.
- No-inference smoke against installed Claude Agent SDK `0.3.296` / CLI
  `2.1.296`: an empty streaming-input queue, temporary working directory,
  disabled session persistence, then native settings readback. `low/off` →
  `low/on` → `high/on` → `high/off` confirmed effort independence. No user
  prompt or model turn was submitted.
- Protocol tests cover Ultra propagation, queued-turn setting isolation,
  80 concurrent child starts/approvals, child terminals and native Stop.
- Claude tests cover settings readback and compatibility failures, background
  snapshots, idle delivery, cancellation during queuing/startup and native
  execution, runtime reuse, changing editor context between turns, and cleanup
  after a leaked legacy task ID, idempotent Stop after idle cleanup, retirement
  failures and a fresh send after a failed interrupt.
- Frontend tests cover draft and attachment preservation across capability
  refreshes, pagination errors, queue refusal and editing, and commands that do
  not require a model turn. Queue items are removed only after dispatch accepts
  them; refusal preserves their identity, attachments and quoted selections.
- Browser tests in `webview/e2e/ultra-mode.spec.ts` exercise selection, send,
  restore, missing custom-model capabilities, inherited new-tab effort, low
  effort without an `xhigh` capability, and 80 live workflows remaining visible
  and stoppable after the foreground answer.

## Sources

- [OpenAI models: Ultra](https://learn.chatgpt.com/docs/models#choose-a-model)
- [OpenAI subagents and effort](https://learn.chatgpt.com/docs/agent-configuration/subagents#choosing-models-and-reasoning)
- [Claude Code model configuration and Ultracode](https://code.claude.com/docs/en/model-config)
- [Claude Code workflows](https://code.claude.com/docs/en/workflows)
- [Claude Agent SDK dynamic workflows](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows)
- Installed Claude SDK declarations: `Query.applyFlagSettings`,
  `SDKBackgroundTasksChangedMessage`, and `Settings.ultracode`.
