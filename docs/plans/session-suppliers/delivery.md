# Conversation supplier delivery

This document records the build and deep review in the daily development workspace before Git publication. The upstream PR applies the feature to `feature/v0.6.5` and reports its separate target-branch validation in the PR's Testing section. The installation artifact below belongs to the development-workspace build.

The 2026-11-10 deep review fixed ten confirmed issues across supplier validation, Execute Plan routing, model aliases, selection races, unsaved-session replacement, bound model catalogs, native login mappings, Claude cloud settings and Bedrock titles. The detailed findings and regression evidence are in `review.md`.

## Behavior

Claude and Codex conversations can select an existing API supplier above the message input. New conversations capture the global default once. Tab and history restoration retain the selection. Changes during a turn apply to the next turn, and unavailable saved suppliers require explicit reselection.

Child credentials, endpoints, model mappings, generated titles, and Claude cost/capacity calculations follow the bound supplier. Native Codex history and ownership remain shared through their existing mechanisms. Local/CLI login access retains its existing authorization; separate OAuth accounts are outside this release's scope.

## Installation artifact

`build/distributions/idea-claude-code-gui-0.6.4.zip` (33,567,902 bytes).

SHA-256: `9f678e8fa4887c2fc517450030a47d17beb147c93a22e3738c914e559b184503`.

The existing project version is preserved. All 17 final archive checks passed: the Bridge archive hash and reviewed runtime sources, TOML runtime dependency, Java supplier/plan/lifecycle bytecode, binding notifications, bound Claude/Codex model catalogs and compressed frontend resource bytes. The artifact was rebuilt after the final frontend fix. Evidence is recorded in `.codex/session-suppliers/deep-review-package-audit.json`.

Install using the IDE's Plugins settings, gear menu, and “Install Plugin from Disk”, then restart the IDE. Select the conversation's supplier above its input area. The catalog refresh button reloads edited configurations.

## Verification and acceptance boundary

See `QA.md` for full-run counts, final affected-suite regressions, browser scenarios and limitations. Final plugin build and archive audit passed. Original report files and staged changes were preserved.

Final automated results: Java 3312 passed and 32 skipped, webview 3285 passed plus six packaging-script checks, and Bridge 1470 passed and 14 skipped. Checkstyle and both frontend production bundles passed. The controlled actual-application browser run covered binding races, stale responses, bound Claude models and narrow layout; the subsequent Codex catalog change is covered by the final full frontend suite.

Real supplier connectivity and an installed IDE restart/tab restoration remain manual acceptance checks. A useful acceptance run is two concurrent conversations with different suppliers, followed by restarting the IDE and reopening their histories. No API credits were consumed by the controlled browser/process fixtures.
