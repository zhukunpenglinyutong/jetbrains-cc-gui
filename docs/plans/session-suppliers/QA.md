# Session supplier verification

Deep review date: 2026-11-10 (Asia/Shanghai). Final Java, frontend, Bridge, Checkstyle, production build, archive audit and browser regressions pass. Installed-IDE validation with real upstream suppliers remains a manual acceptance boundary.

The counts and archive evidence below describe the daily development workspace. The upstream PR's Testing section records the separate validation against `feature/v0.6.5`.

## Automated checks

| Check | Observed result |
| --- | --- |
| Full Java suite, Checkstyle and plugin build after review | 3344 tests across 392 suites: 3312 passed, 32 skipped, zero failures/errors. Checkstyle and plugin build passed. |
| Historical implementation Java pricing/capacity regression | 170 tests across 12 affected suites passed before this review. |
| Full webview suite and test TypeScript checks after review | 3285 tests across 301 files and six packaging-script checks passed; exit code 0. |
| Selection, bound catalog and aggregation regressions | The final full run includes all 56 affected tests across the selector, model hook, aggregation toolbar and global auxiliary model panel, including deferred Codex refresh, stale replies and shared native login. |
| Frontend production build | Application and office bundles built and copied successfully; production TypeScript check passed. |
| Final plugin archive audit | Bridge hash and reviewed runtime sources, TOML dependency, Java bytecode and compressed frontend resources match the final build inputs, including the final Codex catalog refresh. All 17 audit checks passed. |
| Full Bridge suite after review | 1484 tests: 1470 passed, 14 skipped, 0 failures/cancellations; concurrency limited to four. |
| Codex/supplier controls and title regression | 51 supplier/Codex tests and four title fixtures passed, including real concurrent native peers and plan/settings model aliases. |
| Working tree integrity | Original 24 report files and their staged diff unchanged; whitespace check passed. |

The review full frontend and Bridge runs cover their final source changes. Skipped cases are not counted as passes. The first frontend run exposed three tests still using the legacy global catalog callback; those tests now use the session catalog contract. The first unrestricted Bridge run hit two process timing failures; the complete bounded-concurrency rerun passed. The new Java lifecycle fixture initially lacked an IntelliJ Application; it now supplies a local queued UI proxy and restores the previous application.

## Review browser regressions

Playwright exercised the actual application served by Vite after these fixes, with only the Java transport mocked. The following scenarios passed:

- A focus event and a busy transition did not issue a GET over an outstanding supplier SET.
- A deferred change displayed supplier B, its bound model and the next-turn hint.
- A late global model catalog did not replace the conversation model.
- Replacing an unsaved session without changing its null transcript ID reloaded the binding and default.
- A delayed response from the retired binding did not restore its old supplier/model.
- The next supplier mutation carried the new binding token.
- At 393 by 851, supplier B and its model remained visible without horizontal overflow.

Screenshot: `.codex/session-suppliers/deep-review-browser.png`. The test page and its dedicated localhost server were closed after verification. The mock did not provide SDK installation state, so this run does not validate SDK detection or real provider connectivity.

## Historical implementation browser scenarios

Playwright MCP exercised the running application with the Java message transport mocked according to API.md. Java contract/state tests and the process integration fixture verify the backend independently.

| Scenario | Observed result |
| --- | --- |
| Two windows choose different suppliers | First window retained B while the second selected A; changes in the second produced no selection requests in the first. |
| Change supplier during a turn | Desired supplier became B, active supplier remained A, and “Applies to the next turn” appeared. |
| Turn completion and refresh | The pending hint cleared when the active supplier matched the selected supplier. |
| Deleted saved supplier | The deleted ID remained selected with an explicit reselection prompt; no automatic replacement occurred. Selecting an available supplier recovered the control. |
| Missing bridge response | After the response timeout, an error appeared and Refresh was enabled; a subsequent response recovered the selection. |
| Engine switch | Switching to Codex requested `get_session_suppliers` with `provider=codex`. |
| Narrow viewport and long supplier names | At 393 × 851, the control remained visible with no horizontal document overflow; long names stayed within the selector width. |
| Production bundle | The built bundle loaded through the plugin's resource origin, selected supplier B, displayed its mapped model, and raised no page script errors. The test routed that origin to a local static preview server. |
| Global supplier mutation | Conversation selection produced no `switch_provider` or `update_provider` requests. |

The initial attempt to open production HTML under the Vite development URL could not resolve the plugin's custom resource hostname. Routing that hostname to the static preview server reproduced the intended resource transport and passed. This was a test transport issue; no product source change was needed. The development page also requested an absent favicon.

## Process and persistence coverage

- Concurrent Claude request contexts retained distinct keys, endpoints and model tiers without changing the daemon environment.
- Concurrent Codex native test peers received distinct child credentials and provider configuration while sharing the same history home. Global default changes did not rebind explicit suppliers; changing one idle session rebuilt its own runtime. Missing suppliers failed explicitly.
- Native configuration and authentication files stayed unchanged during managed routing in the integration fixture.
- Java XML round trips retained tab supplier IDs and the engine/session history map. Stale session and engine selection requests were rejected, and protocol replies excluded credentials and raw configuration diagnostics.
- Active Claude status reads retained their existing runtime after profile deletion. A result-pricing regression retained the active supplier's mapped rate while another supplier was pending for the next turn.

## Limits and local evidence

The native process fixture uses controlled local peers; it does not spend API credits or authenticate against real suppliers. IntelliJ restart/tab restoration, live upstream connectivity, account-specific login behavior, and third-party provider availability still require installed-IDE acceptance. Independent OAuth accounts are outside the approved scope.

Bedrock title fixtures verify explicit captured AWS keys/token, region and endpoint. Direct title generation for unsupported cloud SDKs or credential-chain-only bound profiles is skipped safely; normal conversation routing is unaffected.

Local logs are under `.codex/session-suppliers/`: `java-full.log`, `java-final-package.log`, `webview-full.log`, `webview-final-targeted.log`, `webview-final-build.log`, `bridge-final.log`, and `bridge-last-targeted.log`. Browser screenshots are `narrow-ui.png` and `production-ui.png` in the same directory. Temporary QA browser tabs and Vite servers were closed after verification.

Review evidence uses the `deep-review-` prefix: `java-final.log`, `webview-final.log`, `webview-final-build.log`, `bridge-final.log`, `codex-controls.log`, `titles.log`, `browser.png`, `package-final.log`, `package-audit.json`, `integrity.json` and `final-evidence.json`. Intermediate failing logs are preserved separately from the final runs.
