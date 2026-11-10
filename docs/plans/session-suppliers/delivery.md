# Conversation supplier delivery

This document records the build and deep review in the daily development workspace before Git publication. The upstream PR applies the feature to `feature/v0.6.5` and reports its separate target-branch validation in the PR's Testing section. The installation artifact below belongs to the development-workspace build.

The 2026-11-10 deep review fixed ten confirmed issues across supplier validation, Execute Plan routing, model aliases, selection races, unsaved-session replacement, bound model catalogs, native login mappings, Claude cloud settings and Bedrock titles. The detailed findings and regression evidence are in `review.md`.

## Behavior

Claude and Codex conversations select an existing API supplier through the message input's original configuration menu (Configure > Switch Current Provider). The extra supplier/refresh strip has been removed. New conversations capture the global default once. Tab and history restoration retain the selection. Changes during a turn apply to the next turn, and unavailable saved suppliers require explicit reselection.

Child credentials, endpoints, model mappings, generated titles, and Claude cost/capacity calculations follow the bound supplier. Native Codex history and ownership remain shared through their existing mechanisms. Local/CLI login access retains its existing authorization; separate OAuth accounts are outside this release's scope.

## Installation artifact

`build/distributions/idea-claude-code-gui-0.6.4-session-supplier-menu.zip` (33,568,559 bytes). The standard `idea-claude-code-gui-0.6.4.zip` is byte-identical.

SHA-256: `4720e80fb1fe0dbeec43e54097e24918b0eb8872921ceb587dc1cc60b22ee858`.

The existing project version is preserved. This archive includes both native process provider and legacy history resume fixes described in `native-provider-fix.md`. It supersedes the earlier archives with SHA-256 beginning `9f678e8f` and `80d86ff2`. All 24 final archive checks passed, including removal of the extra supplier strip, retention of the existing menu and session selection protocol: the Bridge archive hash and reviewed runtime sources, TOML runtime dependency, Java supplier/plan/lifecycle bytecode, binding notifications, bound Claude/Codex model catalogs and compressed frontend resource bytes. Evidence is recorded in `.codex/session-suppliers/supplier-menu-package-audit.json`.

Install using the IDE's Plugins settings, gear menu, and “Install Plugin from Disk”, then restart the IDE. Open Configure in the input's lower-left corner, then Switch Current Provider. This changes only the current conversation's supplier. Opening the submenu refreshes edited configurations automatically. A live turn retains its current supplier; a new choice applies to the next turn. The previous `codex-resume-fix` archive is superseded by this menu-consolidation archive.

## Verification and acceptance boundary

See `QA.md` for full-run counts, final affected-suite regressions, browser scenarios and limitations. Final plugin build and archive audit passed. Original report files and staged changes were preserved.

Final automated results: Java 3312 passed and 32 skipped, webview 3285 passed plus six packaging-script checks, and Bridge 1470 passed and 14 skipped. Checkstyle and both frontend production bundles passed. The controlled actual-application browser run covered binding races, stale responses, bound Claude models and narrow layout; the subsequent Codex catalog change is covered by the final full frontend suite.

After the legacy provider resume follow-up, the full Bridge suite passed with 1480 passed and 15 skipped. The opt-in real CLI regression also passed separately on Codex 0.167.0, including old `OpenAI` threads, retained history, cold restart and switching the old thread between two suppliers. All 151 service/launch/native tests passed against the Bridge extracted from the final plugin archive. The final Gradle plugin build rebuilt both frontend bundles and passed Checkstyle; unchanged Java outputs remained up to date.

Real supplier connectivity and an installed IDE restart/tab restoration remain manual acceptance checks. A useful acceptance run is two concurrent conversations with different suppliers, followed by restarting the IDE and reopening their histories. No API credits were consumed by the controlled browser/process fixtures.


The menu consolidation passed a full frontend run (3289 tests plus six packaging-script checks), the final 25 affected regressions, test TypeScript checking and 16 actual-application Playwright scenarios across four viewport sizes. Both production bundles, Checkstyle and `buildPlugin` passed. The 24 archive checks verified the exact Bridge sources and Java bytecode from the prior native compatibility fix, the final compressed frontend resources, the original menu and absence of the separate supplier strip. No native runtime source changed during the menu consolidation; previous real-CLI evidence remains applicable. Evidence uses `.codex/session-suppliers/supplier-menu-*`. This follow-up is committed locally; no remote push has been made.
