# Native Codex supplier startup and legacy resume fixes

## Confirmed failure

The packaged 0.6.4 plugin could fail before sending a model request with: `This chat uses codemoss_session, but your current provider is OpenAI`.

Thread creation and resume received the conversation's provider table, but the app-server process started with the global provider. Native Codex validates the thread provider against its process provider when starting a turn. Thread-only overrides therefore could not make the conversation usable. The previous protocol fixture accepted thread configuration without checking process startup, so it missed this failure.

The first startup fix did not cover threads created before session suppliers existed. A persisted thread with provider id `OpenAI` still failed at `thread/resume` when the new process used `codemoss_session`. The user's affected history metadata confirmed `OpenAI` and CLI 0.164.0. An isolated real CLI test reproduced the same structured `modelProviderMismatch` rejection before the follow-up fix. The earlier cold-resume test only restored threads already using `codemoss_session`, which missed this migration case.

## Change

Managed app-server processes now receive the selected provider and its native provider table through process-local TOML command overrides. The runtime builder retains the bound provider id consistently, and both persistent chat and auxiliary text generation pass that runtime to their clients. Other per-turn settings continue through RPC, and native CLI login keeps its original startup behavior.

API keys remain in the child environment. Static HTTP headers and experimental bearer tokens also move to child environment variables before building startup arguments, with their values registered for diagnostic redaction. Neither the user's shared Codex home nor its configuration/authentication files are rewritten.

On a structured native provider mismatch, the resume path now retains the historical custom provider id and maps the captured selected supplier's provider table to that id in a replacement process. Its factory accepts the effective native configuration so later cold starts retain the alias. This recovery is attempted once, only before work has been dispatched and with no other loaded thread, pending interaction or independent resume. Shared preconnect/send consumers retain their original thread id; cancellation and runtime reset can retire a pending replacement. Native authorization, ownership and provider validation remain enforced; reserved built-in provider ids cannot be redefined through this mechanism.

## Verification

- Reproduced the original provider mismatch with the installed Codex CLI before the fix; no model request reached the local fixture backend.
- Full Bridge suite: 1495 tests, 1480 passed, 15 skipped, no failures. The real CLI test is opt-in and was run separately.
- Actual Codex 0.167.0: concurrent requests to two local supplier endpoints, a second turn, cold resume, and switching the same persisted thread to another supplier all completed. A legacy `OpenAI` thread also resumed under supplier A, retained its previous assistant history, survived another process restart and switched to supplier B with its thread id unchanged. Exactly nine model requests were made for nine sends; bootstrap and recovery made no extra model requests. Each bound request carried the expected endpoint, key and custom header. Shared native config/auth files and parent environment remained unchanged.
- Six focused launch tests cover TOML escaping, credential-free process arguments, header fallback, bearer tokens, CLI login and invalid configuration. The process fixture now rejects a thread/provider startup mismatch.
- `gradlew.bat --offline buildPlugin` passed, including both frontend production bundles and Checkstyle; unchanged Java outputs remained up to date.
- Four new service regressions cover shared preconnect/send recovery, cold startup retaining the alias, reset during replacement preparation, cancellation with an independent preconnect, and preserving text-only errors. The production persistent factory is covered by a process integration that restores a legacy thread and switches its supplier without changing native history files.
- Final archive audit: 21 checks passed, including exact runtime source bytes and the Bridge archive hash. The actual packaged Bridge passed all 151 service, launch and real native supplier tests after extraction from the final ZIP.

During expanded process testing, the supplier peer reused turn ids after a process restart. This was a test-fixture defect: native Codex uses distinct turn ids. The peer now generates unique ids, and send outcomes are checked explicitly for the new legacy cases.

The real CLI tests used a local HTTP/SSE fixture and synthetic credentials. External supplier connectivity and interaction inside a restarted IDE remain manual acceptance checks.

## Corrected artifact

- Path: `build/distributions/idea-claude-code-gui-0.6.4-codex-resume-fix.zip` (native compatibility build; superseded by the menu consolidation archive in `delivery.md`)
- Bytes: `33575626`
- SHA-256: `f2e7b281ae4893eacfc6fae971912053e864ee36acfdde9f838d82b13e5b6230`

Install the current archive listed in `delivery.md` from the IDE's Plugins settings and restart the IDE so the existing Bridge process is replaced. Existing conversations do not need to be deleted.

Local evidence is retained under `.codex/session-suppliers/provider-legacy-*`; the earlier startup-only evidence uses `provider-runtime-*`. These fixes are included in the local repair commit; no remote push has been made.
