# Session-specific API suppliers

## Approved scope

Claude and Codex conversations independently select an existing configured API supplier and model. New conversations capture the global supplier default once. Changing a global default must not rebind existing configured API supplier conversations. The settings page retains supplier management and default selection.

## Acceptance criteria

1. Two conversations using different configured suppliers can run concurrently without sharing credentials, base URLs, model mappings or mutable launch configuration.
2. The chat surface displays the selected supplier; changing it affects only that conversation. A change during execution applies to the next turn, while interrupt and interaction responses still address the active runtime.
3. Tab restoration and selecting history restore the stored supplier binding. Legacy history with no binding captures the current default once.
4. A missing or invalid bound supplier blocks the next request with a selection prompt. There is no silent fallback to another supplier.
5. Supplier credentials remain in backend-owned configuration and child environments. Webview messages and persistent conversation metadata contain supplier IDs and safe display information only.
6. Existing native session ownership, lifecycle fences, permission checks, storage maintenance and history paths remain enforced.

## Compatibility

Initial scope covers configured Claude/Codex API suppliers. Local configuration and CLI login remain shared native modes, available only while that native mode is the global selection and its existing authorization is valid. Their bindings do not pin an independent account: changing the global selection makes a previously native-bound conversation unavailable until the native mode is restored or a configured API supplier is selected. Independent OAuth accounts are outside scope.

Codex supplier fragments containing top-level `mcp_servers` or `skills` are not supported as conversation-specific configurations. These entries are shown as unavailable and cannot be selected; the existing shared native configuration remains separate. Invalid TOML is also unavailable. Other AI engines retain their existing behavior. No version-history edits are included.

## Validation

Use fake transports/configuration to exercise concurrent routing, deferred switching, deletion, defaults and restoration. Run targeted bridge/Java/webview regression checks, TypeScript checks, Checkstyle and production build. Real vendor requests require no new test traffic.
