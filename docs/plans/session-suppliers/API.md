# Session supplier contract

## Webview bridge

- `get_session_suppliers {provider, requestId}` returns `window.onSessionSuppliers(JSON)` with the echoed request ID and provider, current `sessionId`, `bindingToken`, selected supplier ID, active supplier ID, busy flag, safe supplier entries (`id`, `name`, `available`) and optional error. Claude replies also include whitelisted model mappings, the selected profile's `thinkingEnabled` boolean, and `modelCatalog`: models (`id`, `label`, optional `description`, `supports1MContext`), nullable `defaultModel`, and `replaceBuiltInOptions`.
- `set_session_supplier {provider, supplierId, requestId, sessionId, bindingToken}` validates the configured ID and the session identity/epoch, changes only the current session binding, persists it, and returns the same snapshot. Stale session or engine requests are rejected. Optional `thinkingEnabled` updates the chosen Claude profile's existing thinking preference, preserving credentials and other profile fields. Native local/login thinking controls retain their existing settings-file behavior.
- Existing `provider` continues to mean the AI engine. `supplierId` is a separate configuration identity; it never contains credentials or paths.
- Java dispatches `session-supplier-binding-changed` after installing a newly created conversation. The webview retires old requests and reloads the snapshot even when both old and new transcript IDs are null. Focus and busy refreshes wait for an outstanding selection response instead of superseding it.
- Accepted snapshots publish a window-local `session-supplier-snapshot` event containing only engine, supplier ID, binding token and busy flag. The Codex model consumer invalidates an old catalog/request when the binding changes and is idle; a deferred selection cannot restart the active turn's runtime. Shared native login keeps its existing global catalog refresh.

## Session state and storage

Capture both engines' defaults on conversation creation. Store supplier IDs in tab snapshots and an engine/session-ID keyed application history map, so a conversation retains its binding when reopened from another project. Bind the selected supplier for a turn before asynchronous launch; later UI changes are pending for the next turn. Restoring legacy history captures the default once. Deletion of a supplier does not remove stored bindings and cannot trigger fallback.

## Runtime isolation

Java sends only `supplierId` to the backend bridge. Node resolves that ID from backend-owned supplier configuration, without switching global defaults or copying supplier credentials into native authentication/configuration files. Existing native configuration compatibility normalization remains in place. Claude builds a child-only environment and hashes supplier configuration into its runtime signature. Codex builds child-only environment and native launch overrides, preserving the real Codex home, session-owner registry and operation routing. Custom model aliases resolve from the selected supplier. Auxiliary title generation uses the same supplier snapshot as its turn.

Existing local/CLI modes remain authorized by their existing rules and are not additional independent login accounts. Missing suppliers, invalid configuration and revoked access fail explicitly. Active-turn controls retain their runtime identity until the turn ends. Runtime configuration changes rebuild only the affected idle session runtime.

Plan execution carries the same supplier/home snapshot as other Codex operations. Native plan and settings updates resolve model aliases from that supplier, including the collaboration model. An undefined custom `model_provider` is invalid; only the built-in `openai` provider may omit its explicit provider entry.

The chat model picker reads the bound Claude catalog; global settings panels retain their global catalog. Authorized native login/local modes read their native picker and model mappings. Bound Bedrock direct title calls use captured explicit AWS keys or a Bedrock bearer token, region and endpoint. Credential-chain-only cloud title calls and unsupported direct cloud SDKs are skipped rather than reading another profile's credentials; normal chat continues through its isolated CLI runtime.
