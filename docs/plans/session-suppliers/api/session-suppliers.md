# Conversation supplier messages

These are existing webview-to-Java bridge messages, not HTTP endpoints. Replies invoke `window.onSessionSuppliers` with a JSON string. The webview correlates replies by `provider` and `requestId`.

## get_session_suppliers

Request: `{ "provider": "claude", "requestId": "request-id" }`.

`provider` must be `claude` or `codex` and match the current conversation engine. The snapshot contains:

- `provider`, `requestId`, `sessionId` (nullable), and `bindingToken` (runtime epoch).
- `supplierId` (desired selection), `activeSupplierId` (current-turn selection), and `busy`.
- `suppliers`: entries containing only `id`, `name`, and `available`.
- For Claude, `thinkingEnabled`, whitelisted model mapping/name fields in `modelMappingEnv`, and `modelCatalog` containing `models`, nullable `defaultModel`, and `replaceBuiltInOptions`. Each model contains only `id`, `label`, optional `description`, and `supports1MContext`.
- Optional safe `error` text; configuration parser diagnostics and credentials are never returned.

Availability here means a saved configuration exists and its access mode may be selected. Native startup validates its credentials and configuration separately. A deleted supplier can remain the stored selection without appearing in the catalog; the user must choose an available replacement.

## set_session_supplier

Request: `{ "provider": "claude", "requestId": "request-id", "supplierId": "configured-api", "sessionId": null, "bindingToken": "current-epoch" }`.

The caller must copy `sessionId` and `bindingToken` from its latest snapshot. Java rejects stale engine/session/epoch values and unavailable IDs before mutating the binding. On success it persists the desired selection and returns the same snapshot format. If a turn is live, `activeSupplierId` remains unchanged and the desired supplier applies to the next turn. Global active supplier IDs are unchanged.

Optional `thinkingEnabled` must be a boolean and is accepted only for Claude. It updates the selected profile's existing thinking preference atomically, preserving credentials and other fields. Native local/login thinking retains its existing settings-file behavior.

Malformed requests, missing suppliers, revoked native mode access, and stale selection requests return an error. No error path selects another supplier automatically. Refresh is read-only and can be retried after a timeout.

## Binding replacement and catalog refresh

After installing a new session, Java dispatches `session-supplier-binding-changed` in that window. This invalidates pending old requests, snapshots and local Claude catalogs before requesting the new snapshot. Null-to-null transcript ID transitions still change the runtime binding. Responses from retired requests cannot restore the previous selection.

The window-local `session-suppliers-refresh` event requests a read-only refresh. Focus, busy changes and explicit model refreshes coalesce behind a pending request; they cannot replace an unacknowledged supplier mutation. Conversation catalogs and global settings catalogs remain separate.

An accepted snapshot emits `session-supplier-snapshot` with only `provider`, `supplierId`, `bindingToken` and `busy`. The Codex catalog consumer reloads after an idle binding change, invalidates previous native request IDs, and ignores unrelated managed global defaults. A deferred selection waits until its active turn ends. Native login retains its existing shared-account refresh behavior.
