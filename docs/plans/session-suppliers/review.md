# Session supplier deep review

Review date: 2026-11-10 (Asia/Shanghai). Ten confirmed findings (two P1 and eight P2) have been fixed, with no confirmed finding left open. Java, frontend, Bridge, Checkstyle, production builds and the final updated archive audit passed. Live supplier connectivity and installed-IDE acceptance remain unverified as described below.

## Confirmed findings and fixes

| ID | Severity | Trigger and observed defect | Fix and regression evidence |
| --- | --- | --- | --- |
| R1 | P1 | A Codex configuration names a custom `model_provider` absent from `model_providers`. The resolver synthesized an OpenAI provider instead of rejecting the typo, changing the endpoint receiving the configured key. | `session-supplier.js` rejects missing custom entries, invalid types and blank IDs. The new negative regression failed before the fix. The built-in OpenAI default remains valid. |
| R2 | P1 | Execute Plan bypassed Java runtime configuration capture. The daemon received no session supplier and could rebuild a bound runtime from global configuration. | `CodexSDKBridge.executeCodexPlan` captures supplier and native home before dispatch. A Java transport fixture checks all seven runtime-starting message paths. |
| R3 | P2 | Codex settings updates and plan execution put a raw UI model alias into `collaborationMode.settings.model`, even when the top-level model was resolved. | Both paths reuse the selected supplier's resolved model, including nested settings overrides. The real-stdio supplier fixture reproduced `fixture-model` instead of `b-codex-model` before the fix and now covers plan/default transitions and object updates. |
| R4 | P2 | Focus or busy refresh during an outstanding supplier SET replaced its request ID. Java could apply the change while the UI ignored its acknowledgement. | `SessionSupplierSelect` serializes requests and coalesces read refreshes until acknowledgement. The failing focus/busy regression passes. |
| R5 | P2 | Creating another conversation before the first message leaves both IDs null. React dependencies did not change, so the UI retained its old supplier and epoch while Java installed the new default. | `SessionLifecycleManager` announces the installed binding; the selector clears snapshots/catalogs and retires pending replies before reloading. Java lifecycle and frontend null-ID regressions cover notification order and stale replies. |
| R6 | P2 | Claude's chat picker queried the global catalog after choosing another conversation supplier. Custom routes, defaults, replacement mode and 1M capabilities could belong to another profile. | Java returns a safe selected-profile `modelCatalog`; the conversation hook subscribes to it and ignores late global replies. Tests cover bound routes, global switches, explicit refresh, capabilities and aggregation transitions. Global settings keep a separate catalog. |
| R7 | P2 | Virtual native login entries have no `settingsConfig`; interpreting them as empty profiles removed native mappings and custom picker options. | Authorized native modes read native model settings. Java regression verifies names, defaults, context capability and credential exclusion, and blocks inactive native reads. |
| R8 | P2 | Cloud Claude suppliers disable host-managed stripping. CLI settings env could override the bound child environment with global cloud flags, credentials or endpoints. | Persistent and fallback sends supply selected-profile routing settings, clear conflicting fields and retain request-owned model/thinking controls. Tests exercise precedence and actual request options without changing daemon env. |
| R9 | P2 | Bound Bedrock title generation assumed an Anthropic token. AWS-key profiles skipped titles, while a placeholder Anthropic token could select the wrong client. | Title auth selects Bedrock with captured explicit AWS credentials/token, endpoint, region and model. SDK constructor/request fixtures verify options and unchanged daemon env. Unsupported direct cloud credential chains skip safely. |
| R10 | P2 | A Codex conversation supplier change did not invalidate its native model catalog. Old native replies could retain the previous supplier's models, while unrelated global defaults could refresh a bound catalog. | Safe binding snapshots invalidate the catalog/request ID once the current turn is idle. Native replies from the old request are ignored, repeated identical snapshots do not refetch, managed global changes are ignored, and shared native login retains its global refresh. The new regression failed before the fix. |

## Deep-review validation

- Frontend: 3285 tests across 301 files and six packaging-script checks passed; production/test TypeScript checks and application/office production builds passed. This full run includes the final Codex catalog regression and shared-native-login refresh assertion.
- Bridge: 1484 tests, 1470 passed, 14 skipped, zero failures/cancellations with concurrency limited to four. Supplier/Codex targeted controls: 51 passed; title fixtures: four passed.
- Java: 3344 tests across 392 suites, 3312 passed, 32 skipped, zero failures/errors; Checkstyle and plugin build passed. Java production sources remain unchanged since that full suite. A final resource-only package rebuild includes the updated frontend.
- Final archive: packaged Bridge sources and hash, Java bytecode, compressed frontend resources, both bound model catalogs and binding notifications match the final build inputs. See `delivery.md` for the artifact size and SHA-256.
- `git diff --check` passed. Original 24 report files, HEAD and staged diff are unchanged.

The first frontend run found three tests still using the global callback; they now exercise the session catalog contract and the full suite passes. An unrestricted Bridge run hit two process timing failures; the complete bounded-concurrency rerun passes. A new Java lifecycle fixture initially lacked an IntelliJ Application; it now queues UI callbacks through a local proxy and restores the previous application. Intermediate logs are retained.

## Retained implementation checks

The review covered the feature diff, Java request/state/storage handling, Claude persistent and fallback sends, Codex native launch and control paths, auxiliary title generation, webview selection and model labels, and the associated regression tests. It was performed in the main thread with the code-reviewer workflow and focused CodeGraph/diff inspection. Live authenticated upstream API calls and an installed IDE session are outside this review.

| Resolved issue | Final behavior and verification |
| --- | --- |
| A temporary lifecycle session could redirect a shared bridge resolver | Resolvers belong to the installed window and dynamically read its current session. |
| A pending selection could redirect controls before the native turn ended | Turn routing is captured before launch and retained while either busy state or the execution actor remains active. Java regression covers the interval after the busy flag clears. |
| Context usage refresh could recreate a running Claude runtime after profile edits | Active queries read the existing runtime without changing model, supplier or process; stale epochs are rejected. Bridge regression covers an unavailable profile during a live turn. |
| Claude thinking controls used the globally active profile | The response exposes a boolean only; the control updates the selected profile under the existing configuration transaction, retaining all other profile fields and credentials. |
| Restoring tab metadata could briefly replace a saved supplier with the default | Explicit supplier metadata is installed before the restored identity is published. |
| Codex aliases and generated titles could use another profile | Aliases resolve from the selected configuration; title work uses its originating turn's runtime/environment snapshot. |
| Claude cost/capacity and global auxiliary settings could display another profile's mapping | Cost and capacity follow the current turn's supplier; the global auxiliary settings panel explicitly reads the global mapping. A pricing regression covers switching suppliers while a turn is active. |
| Raw configuration diagnostics could reach the webview | Selection errors use a dedicated safe exception; all other failures return a generic message. Protocol replies whitelist display metadata and never include credentials. |

Supplier selection preserves native access authorization, project/session ownership, real Codex history storage, and existing global supplier management. No database schema, release history, dependency, credential file, or global default changes are required by selection.

The feature-specific QA report records build/test results and the installed-IDE validation boundary. Independent OAuth accounts remain outside scope. Direct cloud titles require a safely captured supported SDK credential form; unsupported credential-chain-only titles are skipped without affecting chat. A new actual-application browser run with the Java transport mocked passed focus/busy refresh, deferred model display, late global catalog rejection, null-ID binding replacement, retired responses, new-token mutations and a narrow viewport. Historical implementation screenshots remain separate. Current evidence is in `.codex/session-suppliers/deep-review-*`.
