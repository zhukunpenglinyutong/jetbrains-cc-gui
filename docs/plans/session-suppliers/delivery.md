# Conversation supplier delivery

Claude and Codex conversation suppliers, native Codex compatibility, the original-menu integration and the maintainer review fixes are implemented in the development workspace. GitHub delivery is tracked by [PR #2067](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui/pull/2067), targeting `feature/v0.6.6`.

## Behavior

Use the input's original Configure > Switch Current Provider menu to select the current conversation's configured API supplier. Opening the submenu refreshes edited configurations. New conversations capture the default once; tabs and histories restore their saved binding. A change during a live turn applies to the next turn. Unavailable saved suppliers require explicit reselection.

Credentials, endpoints, model mappings, generated titles and Claude pricing/capacity follow the bound supplier. Codex retains its native history, session identity and ownership. The extra supplier/refresh strip is removed.

New-session bootstrap now calls a named webview function that dispatches a real binding event. Global pricing settings use the global mapping, unavailable thinking controls are disabled, cloud settings fence inherited routing/auth fields, and duplicate models retain 1M capability regardless of order. Codex MCP/skills fragments and invalid TOML are unavailable before selection. See `review.md` for the findings and regressions.

Local/CLI login remains a shared native authorization mode, available while that mode is globally selected and authorized. Changing away from that mode makes its existing bindings unavailable until restored or explicitly rebound. Configured API supplier bindings remain independent of the global default. Independent OAuth account pinning and per-supplier MCP/skills overrides are outside this feature's scope.

## Development-workspace installation artifact

`build/distributions/idea-claude-code-gui-0.6.4-session-suppliers-review-fix.zip` (33570638 bytes). The standard `idea-claude-code-gui-0.6.4.zip` is byte-identical. The existing project version is preserved.

SHA-256: `4f2d2488cfeb6673bd7086a5a273603387908c729d4672987c8f952e1db5cd2e`.

All 27 archive checks passed, including exact reviewed Bridge sources and hash, the TOML dependency, Java supplier/catalog/lifecycle/event-queue class bytes, the named callback on both sides of the bridge, bound model catalogs and compressed frontend resource bytes. The archive retains native process-provider and legacy-thread restoration fixes. Evidence: `.codex/session-suppliers/maintainer-followup-package-audit.json`.

Install from the IDE's Plugins settings using Install Plugin from Disk, then restart the IDE. This artifact supersedes the previous `session-supplier-menu` package.

## Verification and acceptance boundary

- Development workspace: Java 3315 passed / 32 skipped; Checkstyle, both frontend production bundles and plugin build passed. Webview: 3294 tests across 302 files plus packaging checks and test TypeScript checking passed.
- Development-workspace Bridge: the full run passed 1480 tests / 15 skipped with one five-second process-exit timeout during concurrent builds. That unchanged test passed its isolated rerun in 671 ms; all other full-run tests passed.
- PR worktree after merging the official v0.6.6 base: the full Java run passed 2584 tests / 28 skipped; Checkstyle passed. Webview: 2909 tests across 259 files, six packaging-script checks, test TypeScript checking and production build passed. The full Bridge run passed 1442 tests / 7 skipped. The earlier catalog regressions failed before their fixes.
- Browser: all 16 checks passed across four viewport sizes on the first single-worker run, using the actual application with only the Java transport mocked. These include 12 supplier-menu scenarios and 4 configuration-submenu viewport checks. Supplier checks require the installed named callback, both engine menus, failure handling and replacement of unsaved-session bindings.

Earlier real Codex CLI fixtures verified native startup routing, older OpenAI-thread restoration, cold restart and supplier switching through loopback transports. The current archive audit retains the reviewed native runtime sources.

Real authenticated supplier connectivity and installed-IDE restart/tab restoration remain manual acceptance checks. Deleted-history binding cleanup, first-supplier reselection ergonomics and direct Bedrock title construction with the actual SDK remain non-blocking follow-ups.
