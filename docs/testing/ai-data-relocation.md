# Windows AI data relocation

This patch connects the runtime admission foundation to a Windows-only settings
flow for relocating `.claude`, `.codemoss` and `.codex`. The original names remain
directory junctions. SQL inventory, maintenance, session relations and Office
are separate patches.

The user chooses the destination through the IDE directory picker and confirms
the operation. The UI correlates results by request ID, handles failed delivery
and timeout, and translates known errors in English and Chinese. Backups remain
until an explicit cleanup confirmation.

## Runtime admission audit

| Call sites | Admission and lifetime |
| --- | --- |
| Claude/Codex requests and daemons | Active work rejects relocation; idle owned daemons stop after migration intent. A bound permit covers the observed process tree through exit. |
| Session queries, input history, short bridge services, prompts, commit generation, MCP handshakes and provider database import | Launch through `ProcessManager`; cancellation, timeout and cleanup retain exclusion until observed owned descendants exit. |
| SDK install and uninstall | Install holds admission across directory/package writes and supervised npm execution, preserving the existing per-SDK serial lock. Uninstall uses bounded read admission. |
| TokenTracker server | Its lifetime permit is bound to the spawned process. |
| DSH host | Commands are supervised; an owned persistent host retains its transferred permit. Relocation refuses a running host instead of terminating a service with unknown clients. |
| Executable/version/Node environment probes | Environment-only checks do not launch an AI session against a managed data home. |
| External CLIs | Detection is best effort. Detected processes block relocation; unrelated processes are never terminated. |

The directory manager publishes migration intent before quiescing runtimes and
uses the stable cross-JVM exclusive lock before changing filesystem entries.
Status recovery and backup cleanup use the same boundary. New starts before
commit cancel relocation and wait for rollback; starts after commit wait.

A pending migration journal rejects new shared process/read admission with
`AI_DATA_RECOVERY_REQUIRED`. Opening or refreshing storage status performs
exclusive recovery; successful recovery clears the journal and permits retry.
Malformed state remains blocked for inspection. Launch admission does not
silently repair user data.

## Filesystem and recovery checks

Copying, link handling and journal/backup state have separate package-private
helpers. They preserve path validation, source manifests, phase order and
rollback. Tests cover nested targets, existing links, junction redirection,
changed source content, interrupted relocation and recovery, rejected backup
paths and injected cleanup/copy failures.

Before publishing a relocated target, the journal records its data fingerprint.
If an independent writer changes that target and rollback is necessary, recovery
restores the original canonical directory and retains both the changed target and
the journal for inspection. It does not delete the newly written data. Status
queries return a busy snapshot while another runtime still holds admission.
The Windows fallback junction command passes paths through environment values,
with delayed expansion disabled, preserving literal percent and exclamation marks.

The process observer retains observed descendants after parent exit and channel
removal. Java OS snapshots cannot prove ownership of an arbitrary process that
forks and reparents between observations; this patch does not claim OS job-object
containment or control over unrelated CLIs.

## Validation

The extraction's first targeted Java run passed 120 cases. Adding the pending
journal regression first reproduced an unprotected shared admission; the guard
then passed the complete affected 121-case suite and Checkstyle. The final error
projection passed all 14 focused gate/coordinator/cross-JVM cases and Checkstyle.

The frontend's 48 affected cases, test TypeScript compilation and production
build pass. These checks exercise disposable fixtures; no account, installed AI
CLI or live user configuration is required. macOS, Linux and WSL relocation
remain unsupported in both the backend and UI.

After integrating official base `c4772b39`, the full Java suite passes: 2,092
cases discovered, 2,076 passed and 16 skipped, with no failures or errors;
Checkstyle passes. The subsequent bridge refusal correction passes 35 affected
frontend cases and the production build. An explicit false host dispatch now
returns false to the migration controls while legacy void bridges still work.
