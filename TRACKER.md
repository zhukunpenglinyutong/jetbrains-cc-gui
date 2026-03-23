# CCG-jh Bug & Feature Tracker

Tracks all bugs and features for the jh-fork, their status, which jh-version includes them, and whether they were submitted upstream as PR.

## Legend

**Status:** `open` | `⭐ next` | `testing` | `fixed` | `wontfix`
**StatusChangedOn:** Datum der letzten Statusänderung (ISO: `YYYY-MM-DD`). Bei neuen Einträgen = Erfassungsdatum.
**Upstream:** `PR #N` (submitted) | `merged` (merged upstream) | `private` (jh-only, not submitted)
**Since:** jh-version that first includes the fix/feature

---

## Bugs

| ID | Component | Description | Status | StatusChangedOn | Since | Upstream | Branch |
|----|-----------|-------------|--------|-----------------|-------|----------|--------|
| B-001 | `ChatInputBox` | Spellcheck active (red underlines on non-dictionary words) | fixed | 2026-02-15 | jh.5 | merged ([PR #455](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/455)) | `fix/contenteditable-input-bugs` |
| B-002 | `ChatInputBox` | Characters disappear when typing fast (useControlledValueSync overwrites during focus) | fixed | 2026-02-15 | jh.5 | merged ([PR #455](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/455)) | `fix/contenteditable-input-bugs` |
| B-003 | `ChatInputBox` | ArrowUp navigation broken after pasting multiline text (single TextNode with `\n`) | fixed | 2026-02-15 | jh.5 | merged ([PR #458](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/458)) | `fix/paste-arrow-navigation` |
| B-004 | `ChatInputBox` | ArrowUp at very top of contentEditable causes cursor to disappear (Chromium edge case) | open | 2026-02-15 | — | — | — |
| B-005 | `ChatHeader` | Spellcheck active on session title edit input | fixed | 2026-02-15 | jh.5 | merged ([PR #457](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/457)) | `fix/session-title-on-history-load` |
| B-006 | `ScrollControl` / Scroll | Scroll-to-bottom button does not re-activate auto-scroll during streaming. Clicking the ↓ button scrolls to the bottom, but the stream keeps running without following — user must manually scroll again. **Root cause:** `ScrollControl` implements its own `scrollToBottom()` via `container.scrollTo()` without clearing `userPausedRef` in `useScrollBehavior`. The hook's scroll handler exits early when `userPausedRef === true`, so `isUserAtBottomRef` is never updated and auto-scroll stays paused. **Fix:** Pass `userPausedRef` to `ScrollControl` (or use `useScrollBehavior`'s `scrollToBottom`) and reset it on button click. Also related: button sometimes shows wrong direction. | open | 2026-02-15 | — | — | — |
| B-007 | `AskUserQuestionDialog` | Spellcheck active in textarea | open | 2026-02-15 | — | — | — |
| B-008 | `AskUserQuestionDialog` | Enter creates new line instead of submitting (inconsistent with main chat) | open | 2026-02-15 | — | — | — |
| B-009 | Plan Mode | Markdown shown as raw source instead of rendered | open | 2026-02-15 | — | — | — |
| B-010 | Plan Mode | Collapse/expand arrows are inverted (up=collapse, down=expand) | open | 2026-02-15 | — | — | — |
| B-011 | `ChatHeader` / History | Custom session title lost after first prompt. **Root cause:** Frontend assigns a provisional sessionId; SDK creates a new one on first prompt. Title saved under old ID becomes orphaned. | fixed | 2026-02-18 | jh.5-b | merged ([PR #462](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/462)) | `fix/session-title-followup` |
| B-012 | `ChatHeader` | Pencil button for title edit does not appear on hover when IntelliJ starts with Claude Code GUI window already open/expanded. Title editing only works after navigating away and back, or after first interaction. | open | 2026-02-18 | — | — | — |
| B-013 | `ChatInputBox` / `ChatHeader` | After creating a new session, clicking into the title to edit causes cursor to jump to chat input. **Root cause:** `useGlobalCallbacks.ts` calls `focusInput()` on parent re-renders, stealing focus from title input. **Fix:** Guard with `document.activeElement` check. | fixed | 2026-02-18 | jh.5-b | merged ([PR #462](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/462)) | `fix/session-title-followup` |
| B-014 | `ChatHeader` / History | Renaming title in a new session (before first prompt) updates the **previous** session's title instead. **Root cause:** `createNewSession()` does not clear `currentSessionId`. | fixed | 2026-02-18 | jh.5-b | merged ([PR #462](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/462)) | `fix/session-title-followup` |
| B-015 | `CodemossSettingsService` | Config file `~/.codemoss/config.json` is "not found, creating default" on every access (logged 6+ times per session). File is either never actually written or immediately invalidated. | open | 2026-02-20 | — | — | — |
| B-016 | `ChatInputBox` / Layout | Loading spinner (bottom-left during streaming) causes layout shift when it disappears after stream ends. The chat content jumps abruptly to fill the space previously occupied by the spinner. | open | 2026-02-20 | — | — | — |
| B-017 | Scroll / Image | Auto-scroll does not follow stream when the prompt contains an image. Only the first ~2 lines of the response are visible; user must manually scroll down to see the rest. | open | 2026-02-20 | — | — | — |
| B-018 | Batch Run Commands | Status bubbles (green/red/orange dots) are not vertically aligned across list items. Dots appear at slightly different horizontal positions depending on the item text length or layout. ![B-018](B-018-status-bubbles-misaligned.png) | open | 2026-02-20 | — | — | — |
| B-019 | `ChatInputBox` | Ctrl+Z (undo) does not work after pasting longer text. Short pastes can be undone, but longer pastes (approx. 2+ lines) cannot be reverted with undo. Likely related to `useFileTags` innerHTML replacement breaking the browser's native undo stack. | open | 2026-02-20 | — | — | — |
| B-020 | Message Rendering / Layout | Text distortion after stream completes — lines overlap, characters shift, layout breaks. Occurs right after the spinner disappears (see also B-016). Possibly related to a high number of status bubbles in the left gutter causing layout recalculation issues. ![B-020](B-020-text-distorted-after-stream.png) | open | 2026-02-25 | — | — | — |
| B-021 | Scroll / Streaming | Chat scrolls up abruptly when streaming begins — existing messages jump upward, user loses visual position and must manually scroll down to follow the stream. Sporadic, not consistently reproducible. Possibly related to B-006, B-017. | testing | 2026-03-10 | jh.10 | upstream (PR #600) | — |
| B-022 | Tabs / Title | Tab-Rename wird nach erstem Prompt auf Default-Namen zurückgesetzt. **Fix in v0.2.4:** `ChatWindowDelegate.updateTabStatus()` erkennt externe Renames und ueberschreibt sie nicht mehr. | fixed | 2026-03-01 | jh.8 | upstream (v0.2.4) | — |
| B-023 | `ChatInputBox` / Layout | Border/Outline links abgeschnitten in existierenden Sessions. Die blaue Focus-Umrandung der Chat-Eingabe erscheint links unvollständig (ca. 1-2px fehlen), während sie in neuen Sessions im gleichen IDE-Fenster korrekt dargestellt wird. Session-abhängig, nicht IDE-abhängig. | open | 2026-03-01 | — | — | — |
| B-024 | AI Bridge / API | **"Prompt is too long"** — Session-JSONL wächst unbegrenzt (Progress-Events, alte Snapshots). Ab ~20 MB lehnt das SDK ab bevor ein API-Call stattfindet. **Root cause:** `persistent-query-service.js` lädt das gesamte JSONL in den Kontext. **Fix:** F-009 Session Auto-Compact — JSONL wird automatisch gestrippt und der Send wiederholt. | fixed | 2026-03-03 | jh.9 | [PR #572](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/572) | `feature/session-compact` |
| B-025 | Message Rendering | Assistant-Message wird am Ende abgeschnitten — letzter Absatz oder Satz fehlt in der Anzeige. Tritt seit v0.2.4 auf. Möglicherweise Timing-Problem bei `onStreamEnd` / `onContentDelta` (letztes Delta wird nicht gerendert) oder Truncation in der Markdown-Verarbeitung. | open | 2026-03-01 | — | — | — |
| B-026 | IPC Sniffer / Settings | IPC-Sniffer-Toggle wird nur an den aktiven Tab propagiert, nicht an alle offenen Tabs. **Root cause:** `SettingsHandler.handleSetIpcSnifferEnabled()` ruft `context.getClaudeSDKBridge()` auf, das nur die Bridge des aktuellen Tabs zurückgibt. Tabs, die vor dem Einschalten geöffnet wurden, behalten `ipcSnifferEnabled = false`. **Fix:** Über `ClaudeSDKToolWindow.getAllWindows()` an alle Bridges propagieren. | fixed | 2026-03-05 | jh.9 | private | — |
| B-027 | Webview / Tabs | Webview reloaded spontan beim Tippen — Tab wird angeklickt (erstmalig oder nach Inaktivität), User beginnt Prompt einzugeben, View baut sich komplett neu auf und der eingegebene Text geht verloren. Tritt seit v0.2.4 auf. Daemon bleibt aktiv (Session-ID bleibt gleich), nur die JCEF-Webview wird zerstört/neu geladen. IPC-Sniffer zeigt 36-Min-Lücke ohne Traffic, danach normaler Prompt — kein IPC-Event für den Reload selbst. Möglicherweise Lazy-Init der Webview bei Tab-Wechsel oder ein JCEF-Lifecycle-Event das den Browser-Content invalidiert. | open | 2026-03-05 | — | — | — |
| B-028 | Message Rendering / Streaming | Assistant-Antwort erscheint **über** der User-Nachricht statt darunter. Nach dem Absenden scrollt der Stream oberhalb des eigenen Prompts los. IPC-Sniffer zeigt saubere Sequenz (kein Interleaving auf IPC-Ebene). **Zwei Snapshots, zwei Pfade:** (1) Snapshot `B-027_*.json` (normaler Prompt): `app.messageCount` (1011) vs. Backend-Count (1009) = +2 überschüssige Messages → `appendOptimisticMessageIfMissing` dedupliziert nicht korrekt, Race Condition mit `onStreamStart` (700 ms vor erstem `messages_update`). (2) Snapshot `B-028_*.json` (nach SEND_ERROR-Kaskade): 457 KB Paste → "Prompt is too long" → F-009 Auto-Compact → Retry → erneut too long → User tippt neue Msg → erneut too long → Retry → Erfolg. Kein Count-Mismatch (beide 1101), aber `send()` wird bei Retry erneut aufgerufen inkl. `updateSessionStateForSend(userMessage)` — User-Message könnte doppelt im State landen. **Vermutete Root Causes:** A) Race in `appendOptimisticMessageIfMissing` (Timestamp/Content-Match schlägt fehl), B) Doppelter `send()`-Aufruf bei Auto-Compact-Retry schreibt User-Message zweimal. **Verwandt:** B-021 (Scroll-Jump), B-024/F-009 (Auto-Compact). **IPC-Log:** `ipc-75b263a5-20260305-122029.jsonl`. | testing | 2026-03-10 | jh.10 | upstream (PR #600, #611) | — |
| B-029 | Message Rendering / Streaming | Markdown-Tabellen werden während des Streamings nicht gerendert — Pipe-Zeichen, Bindestriche und Zeilenumbrüche erscheinen als Roh-Text. Erst nach Stream-Ende wird die Tabelle korrekt als HTML-Table dargestellt. Bei langen Streams mit umfangreichen Tabellen (z.B. Änderungspläne) ist der Inhalt während des Streamings kaum lesbar. | open | 2026-03-01 | — | — | — |
| B-030 | Session Compact / Streaming | Session Compact via Rechtsklick auf Session-Titel disconnectet den Daemon und tötet den laufenden Stream. **Root cause:** Manual Compact fährt den Daemon herunter, um die JSONL sicher zu kompaktieren — während eines aktiven Streams wird dadurch die Verbindung gekappt. | wontfix | 2026-03-23 | — | — | — |
| B-031 | `ChatInputBox` | Text bleibt nach Absenden (Enter) in der Prompt-Box stehen. Oberste Zeile ist meist leer, aber in den Zeilen darunter ist der alte Text im linken Teil noch sichtbar. Sporadisch, Details folgen bei nächstem Auftreten. | open | 2026-03-05 | — | — | — |
| B-033 | SessionHandler / cwd | **"API request failed" wenn projektfremde Datei im Editor offen ist.** `SessionHandler` nutzt das Parent-Verzeichnis der aktiven Editor-Datei als `cwd`. Liegt diese außerhalb des Projekts (z.B. `~/.claude/plans/*.md`), wird die Session-JSONL unter falschem Pfad erstellt (`C--Users-jhaan--claude-plans/` statt `D--apps-workspace-.../`). Erste Nachricht geht durch (Daemon erstellt Session), zweite crasht (Rewind sucht JSONL unter aktuellem cwd → "Session file not found" → 3 Retries → "API request failed"). **Root cause:** `SessionHandler` fällt auf `activeFile.getParent()` zurück statt auf `projectPath`. **Workaround:** Keine projektfremden Dateien im Editor offen haben. **Fix:** `SessionHandler.java` — immer `projectPath` als Fallback verwenden. | fixed | 2026-03-23 | jh.11 | merged ([PR #636](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/636), v0.2.9) | `fix/session-handler-cwd-fallback` |
| B-035 | AI Bridge / Process | **Zombie-Node.js-Prozesse nach IDE-Restart fressen CPU und blockieren Shutdown.** Nach mehreren IDE-Restarts (z.B. Plugin-Versionswechsel) bleiben Node.js-Daemon-Prozesse aus früheren Starts als Zombies aktiv (~6% CPU pro Prozess). Beim Schließen der IDE beendet sich IntelliJ nicht — bleibt im Task-Manager sichtbar. "Task beenden" verursacht ~1 Min Total-Freeze. Erst nach manuellem Kill der Node.js-Prozesse beendet sich auch IntelliJ. **Vermutete Root Cause:** `DaemonBridge.stop()` sendet `shutdown`-Command und ruft `destroyForcibly()` auf, aber Node.js-Prozesse terminieren nicht (SDK-Netzwerkverbindungen hängen?). Kein Force-Exit-Timer, kein Parent-Process-Monitor. Zombie-Prozesse aus früheren IDE-Starts werden nie aufgeräumt. **Fix upstream:** [PR #634](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/634) — 5s Force-Exit-Timer, ppid-Monitor (10s) und Session-Idle-Cleanup (30 Min). | testing | 2026-03-23 | — | merged ([PR #634](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/634), v0.2.9) | — |
| B-036 | Message Rendering / Streaming | **Assistant-Antwort erscheint erst nach nächstem Prompt.** Die Antwort wird empfangen (Spinner stoppt), aber der Message-Block wird nicht gerendert. Erst wenn der User eine weitere Nachricht sendet und ein neuer Stream beginnt, taucht die vorherige Antwort auf. Vermutlich fehlendes State-Update oder Re-Render-Trigger am Stream-Ende. Tritt sporadisch auf, erstmals beobachtet in jh.12 (0.2.8-Basis). **Verwandt:** B-025 (abgeschnittene Messages), B-034 (verschwundene Messages). | open | 2026-03-13 | — | — | — |
| B-034 | Message Rendering / Streaming | **Assistant-Nachrichten verschwinden beim Absenden eines Prompts in bestehender Session.** Race Condition zwischen `onStreamStart` und `messages_update`. In jh.11 gefixt via `streamingOriginalIdxRef` Guard. **v0.3.1:** Upstream hat mehrere Streaming-Fixes (`bd86d47`, `626cefe`, `e9b81d8`) + registerCallbacks-Refactoring. Privater Fix wird **nicht portiert** — erst testen ob Bug in v0.3.1 noch auftritt. **Verwandt:** B-021, B-028. | testing | 2026-03-23 | jh.11 | upstream pruefen | — |
| B-032 | Session Compact / API | **API Error 400: orphaned tool_result** — Nach Session Compact (F-009). **Root cause:** `SessionCompactor` trennte tool_use/tool_result-Paare. | wontfix | 2026-03-23 | jh.9 | private (dropped mit F-009) | — |

## Features

| ID | Component | Description | Status | StatusChangedOn | Since | Upstream | Branch |
|----|-----------|-------------|--------|-----------------|-------|----------|--------|
| F-001 | `ChatHeader` | Editable session titles with inline edit mode (pencil/save/cancel) | fixed | 2026-02-15 | jh.5 | merged ([PR #457](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/457)) | `fix/session-title-on-history-load` |
| F-002 | Scroll | Pause auto-scroll when user scrolls up during streaming (wheel-up lock) | fixed | 2026-02-15 | jh.5 | merged ([PR #456](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/456)) | `feat/scroll-lock-on-wheel-up` |
| F-003 | `ScrollControl` | Scroll-up button jumps to previous user message (blue bubble) instead of plain scroll — navigates prompt-to-prompt through chat history | open | 2026-02-15 | — | — | — |
| F-004 | `ChatInputBox` | Show long pasted text as collapsible thumbnail/attachment above the input instead of inserting inline. Similar to claude.ai behavior where large pastes appear as a preview card with "PASTED" label. Threshold TBD (e.g. >5 lines or >500 chars). Would also mitigate B-019 (broken undo after paste). | open | 2026-02-20 | — | — | — |
| F-005 | Tabs | **Session-ID Persistenz pro Tab** — nach IDE-Neustart soll jeder Tab seine vorherige Session (mit History) wiederherstellen, nicht nur Tab-Name und -Anzahl. Aktuell speichert `TabStateService` nur Names/Count, nicht die SessionIDs. | ⭐ next | 2026-02-25 | — | — | — |
| F-006 | Tabs | **Tab-Drag-Reorder** — Tabs per Drag & Drop umsortieren. IntelliJ `ContentManager` unterstützt das nicht nativ, muss custom implementiert werden. | ⭐ next | 2026-02-25 | — | — | — |
| F-008 | Settings / Diagnostics | **Configurable Tracker File Path** — Pfad zur Bug-Tracker-Datei (TRACKER.md) in den Settings konfigurierbar machen (Environment Tab). TrackerParser nutzt konfigurierten Pfad aus `config.json` zuerst, dann Fallback auf Auto-Discovery. Alte `tracker-path.txt` wird migriert. | fixed | 2026-03-03 | jh.9 | private | — |
| F-009 | AI Bridge / Session | **Session Auto-Compact** — Automatische JSONL-Kompaktierung bei "Prompt is too long" (B-024). v0.3.1 hat 6h Lifetime-Cap (`d46490d`) als alternativen Schutz. **Dropped ab jh.13** — nicht mehr portiert. | wontfix | 2026-03-23 | jh.9 | [PR #572](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/572) (closed) | `feature/session-compact` |
| F-007 | Diagnostics | **Cross-Instance Diagnostic Snapshots** — Optionaler Debugging-Zusatz (in Settings aktivierbar). Key-Events (Stream-Start/End, Scroll-Spruenge) in Ringbuffer. Trigger via `touch ~/.codemoss/diagnostics/snapshot-request` oder Bug-Button im Header. Bug-Dropdown mit durchsuchbarer Liste bekannter Bugs. Primaerer Use-Case: B-021 (sporadischer Scroll-Bug). | fixed | 2026-02-25 | jh.7 | private | `feat/f-007-diagnostic-snapshots` |
| F-010 | Settings / Diagnostics | **IPC Traffic Logger** — Loggt die gesamte Kommunikation zwischen Plugin und AI-Bridge in JSONL-Dateien (`~/.codemoss/diagnostics/ipc-sniffer/`). Toggle in Other Settings. Async Writer-Thread mit Queue, Sensitive-Data-Redaction, 50 MB Safety-Valve, 7-Tage Cleanup. Intercepted beide Pfade (Daemon + Process). Primärer Use-Case: B-024 Diagnose. | fixed | 2026-03-05 | jh.9 | private | — |
| F-011 | Settings | **Diagnostics Tab** — Eigener Menüpunkt oder Tab unter Basic Configuration, der alle Diagnose-Features bündelt: IPC Sniffer (F-010), Tracker-Pfad (F-008), Known-Bugs-Dropdown ein/aus (F-007). Aktuell sind diese über Other Settings und Environment Tab verstreut. | open | 2026-03-05 | — | — | — |
| F-012 | Diagnostics | **Webview Lifecycle Logging** — JCEF-Webview-Lifecycle-Events (`webview_created`, `page_loaded`, `frontend_ready`, `webview_reload`, `webview_recreate`, `window_disposed`) in dieselbe JSONL-Datei wie der IPC-Sniffer (F-010) schreiben. Nutzt bestehenden `IpcSnifferWriter` mit neuem `logLifecycle()`-Aufruf und `dir: "LIFECYCLE"` Tag. Kein eigener Toggle — aktiv wenn IPC Sniffer aktiv. Primärer Use-Case: B-027 (spontaner Webview-Reload). | fixed | 2026-03-05 | jh.9 | private | — |
| F-013 | Diagnostics | **Screenshot bei Bug-Report** — Beim Klick auf den Bug-Button (F-007) zusätzlich zum Diagnostic Snapshot einen Screenshot der aktuellen Webview/IDE erstellen und zusammen mit dem Snapshot speichern. Ergänzt die textbasierten Diagnosedaten um eine visuelle Momentaufnahme des UI-Zustands. | open | 2026-03-05 | — | — | — |

---

## Upstream PRs

| PR | Status | Type | Tracker IDs | Description |
|----|--------|------|-------------|-------------|
| [#455](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/455) | Merged | bug | B-001, B-002 | fix: disable spellcheck + prevent character loss |
| [#456](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/456) | Merged | feat | F-002 | feat: scroll-lock on wheel-up during streaming |
| [#457](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/457) | Merged | feat | F-001, B-005 | feat: editable session titles in chat header with history sync |
| [#458](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/458) | Merged | bug | B-003 | fix: ArrowUp navigation after paste in contentEditable |
| [#462](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/462) | Merged | bug | B-011, B-013, B-014 | fix: session title persistence and focus stability (#457 follow-up) |
| [#572](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/572) | Closed | feat+bug | F-009, B-024 | feat: auto-compact session on "Prompt is too long" error (incompatible with v0.2.7 daemon architecture) |
| [#636](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/636) | Merged | bug | B-033 | fix: use projectPath as cwd when active file is outside project root |

---

## jh-Releases

### jh.12 (current) — Base: upstream 0.2.8

Rebase auf v0.2.8 (commit 824c322). Alle privaten Features (F-007, F-008, F-009, F-010) portiert. B-033 cwd-Fix weiterhin enthalten (PR #636 offen). Neue Build-Versionierung mit fortlaufendem Suffix (`-XX`).

**Upstream changes in v0.2.8:**
- Refactor: Large modules split into focused files (`message-service.js` → 7 Dateien, `codex/message-service.js` → 6 Dateien)
- `selectWorkingDirectory()` in `path-utils.js` — JS-seitiger cwd-Schutz (greift aber nicht bei gültigen Nicht-Temp-Pfaden, daher B-033 Java-Fix weiterhin nötig)
- `fix(ai-bridge)`: Network env vars vor HTTPS-Verbindung injiziert
- Remote images lokalisiert

**Fixes & Improvements:**
- B-033 — cwd-Fix carried forward (PR #636 noch offen, Maintainer-Fix in v0.2.8 unzureichend)
- Diagnostic Layer komplett portiert (Single-Entry-Point-Architektur, siehe UPGRADE-GUIDE.md)
- Build-Versionierung: fortlaufendes Suffix `-XX` pro Release (z.B. `jh.12-04`)

**Known Issues:**
- B-036 — Assistant-Antwort erscheint erst nach nächstem Prompt (sporadisch, neu in jh.12)

**Branch:** `release/jh.12`
**Output:** `build/distributions/idea-claude-code-gui-0.2.8-jh.12-04.zip`

---

### jh.11 — Base: upstream 0.2.7

Hotfix-Release für jh.10. Behebt B-033 (SessionHandler cwd-Bug), der jh.10 komplett unbrauchbar machte. Außerdem: F-010 IPC Sniffer vollständig neu verdrahtet, F-008 Tracker-Path-UI wiederhergestellt, StatusChangedOn-Spalte im Tracker, Testing-Badges in BugDropdown, und 57 automatisierte Tests.

**Fixes & Improvements:**
- B-033 — SessionHandler cwd-Bug gefixt (upstream PR [#636](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/636))
- F-010 — IPC Sniffer: 7 Call-Sites in ClaudeSDKBridge, Settings-Delegate-Wiring-Bug behoben (setIpcSnifferEnabled fehlte in delegates)
- F-008 — Tracker-Path-UI in EnvironmentTab wiederhergestellt (war beim Upgrade verloren gegangen)
- F-012 — StatusChangedOn-Spalte in TRACKER.md + TrackerParser, Testing-Badges in BugDropdown (CSS-Klasse statt separatem Label)
- UPGRADE-GUIDE.md — Upgrade-Checkliste und Lessons Learned aus v0.2.7-Migration extrahiert

**Automated Tests (57 tests, 7 suites):**
- T2 — TrackerParser regex (10 tests)
- T3 — BugDropdown rendering, filtering, keyboard navigation, testing badge (12 tests)
- T7 — useSettingsWindowCallbacks delegate wiring (6 tests)
- T8 — useScrollBehavior auto-scroll, wheel-up lock, userPausedRef (8 tests)
- T1, T4, T5 — bereits vorhandene Tests (App, ChatInputBox, MessageItem)

**Branch:** `release/jh.11`
**Output:** `build/distributions/idea-claude-code-gui-0.2.7-jh.11.zip`

---

### jh.10 (skipped) — Base: upstream 0.2.7

**⚠ Komplett unbrauchbar wegen B-033:** SessionHandler verwendete das Parent-Verzeichnis der aktiven Datei statt projectPath als cwd. Dadurch startete Claude in falschen Verzeichnissen, konnte Dateien nicht finden, und produzierte inkonsistente Ergebnisse. Das Problem trat sofort nach Installation auf und machte produktives Arbeiten unmöglich. Sofort durch jh.11 ersetzt.

Rebase from `origin/main` (v0.2.7, commit ea57ba3). All private features (F-007, F-008, F-009, F-010) re-applied. PR #572 (F-009) still not merged upstream.

**Upstream changes in v0.2.5 / v0.2.6 / v0.2.7:**
- Project-Level Prompts — Dual-Scope (Global + Project), Git-shareable, Full CRUD (#598)
- Codex Mode Enhancements — Suggest/Approval Mode, per-Conversation Permissions, Config-UI (#571)
- Codex Tool Rendering — Smart Classification + File Navigation (#607)
- AUTO_ALLOW_TOOLS — secure tools without prompt in Plan Mode (#609/#615)
- Provider Sorting — Drag & Drop (#617)
- apiKeyHelper — Enterprise Auth via managed-settings.json (#623)
- Codex Models — gpt-5.4 new, gpt-5.2/5.3 removed
- Tab Detach → Floating Window, IDEA Keyboard Shortcuts, Clipboard Images
- Session Transition Races + Streaming Stability (PR #600) → **B-021, B-028 set to testing**
- Runtime Session Epoch Isolation (PR #611) → **B-028 set to testing**
- Context Menu Cut + File Tag Handling (PR #625) → B-019 may benefit
- UTF-8 Charset for all File I/O
- Experimental IntelliJ APIs → stable alternatives
- Node.js Path-Priority Fix (#587)

**Tracker updates:**
- B-021 → `testing` (PR #600 addresses session transition races)
- B-028 → `testing` (PR #600 + #611 address epoch isolation and ghost messages)

**Private changes (jh-only):**
- `plugin.xml` — ID + Name suffix "-jh"
- `build.gradle` — Version `0.2.7-jh.10`
- F-007 — Diagnostic Snapshots (carried forward)
- F-008 — Configurable Tracker Path (carried forward)
- F-009 — Session Auto-Compact (carried forward, PR #572 closed — inkompatibel mit v0.2.7 Daemon)
- F-010 — IPC Traffic Logger (carried forward)
- B-026 — IPC Sniffer multi-tab propagation (carried forward)
- B-032 — tool_use/tool_result pair preservation in session-service.js (carried forward)

**Branch:** `release/jh.10`
**Output:** `build/distributions/idea-claude-code-gui-0.2.7-jh.10.zip`

---

### jh.9 — Base: upstream 0.2.4

Built on `release/jh.8`. Adds Session Auto-Compact (F-009), IPC Traffic Logger (F-010), and configurable Tracker path (F-008).

**New features:**
- F-009 (Session Auto-Compact) — Auto-compact on "Prompt is too long" + manual compact via right-click. Fixes B-024. Submitted upstream as [PR #572](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/572).
- F-010 (IPC Traffic Logger) — Full IPC sniffer with toggle in Other Settings, async JSONL writer, sensitive-data redaction, 50 MB safety-valve.
- F-008 (Configurable Tracker Path) — Tracker file path configurable in Settings → Environment Tab.

**Bug fixes:**
- B-032 (orphaned tool_result after compact) — SessionCompactor now tracks tool_use/tool_result pairs and adjusts cutoff to keep them together. Includes post-compact validation.

**Private changes (jh-only):**
- `plugin.xml` — ID + Name suffix "-jh"
- `build.gradle` — Version `0.2.4-jh.9`
- F-007 — Diagnostic Snapshots (carried forward)
- F-008, F-010 — Private diagnostics features
- F-009 — Also submitted upstream (PR #572)

**Branch:** `release/jh.9`
**Output:** `build/distributions/idea-claude-code-gui-0.2.4-jh.9.zip`

---

### jh.8 — Base: upstream 0.2.4

Fresh branch from `origin/main` (v0.2.4). F-007 re-applied as sole private feature.

**Upstream changes in 0.2.4:**
- Local slash command registry (replaces remote SDK subprocess)
- Codex skills support with `$`-commands and multi-level scanning
- Permission mode validation unification (frontend + backend)
- New providers: Qwen, OpenRouter
- Tab lifecycle cleanup (closing tab terminates daemon)
- Usage stats: server-side date range filtering
- Vendor rename: CodeMossAI → MossX
- PlatformUtils.getHomeDirectory() replaces System.getProperty("user.home")
- B-022 fixed: Tab rename preserved after prompt

**Private changes (jh-only):**
- `plugin.xml` — ID + Name suffix "-jh"
- `build.gradle` — Version `0.2.4-jh.8`
- F-007 — Full Diagnostic Snapshots feature (adapted for v0.2.4 checkstyle rules)

**Branch:** `release/jh.8`
**Output:** `build/distributions/idea-claude-code-gui-0.2.4-jh.8.zip`

---

### jh.7 — Base: upstream 0.2.3

Fresh branch from `origin/main` (v0.2.3). All previous PRs (#455–#462) are now merged upstream, so **only F-007 (Diagnostic Snapshots) needed re-applying** as the sole private feature.

**Upstream changes in 0.2.2/0.2.3:**
- Daemon mode (persistent Node.js process)
- Settings tabs (General, Model, MCP, etc.)
- Sound notifications
- All jh PRs merged (#455, #456, #457, #458, #462)

**Private changes (jh-only):**
- `plugin.xml` — ID + Name suffix "-jh"
- `build.gradle` — Version `0.2.3-jh.7`
- F-007 — Full Diagnostic Snapshots feature (17 files, see CLAUDE.md "Custom Changes" table)

**Branch:** `release/jh.7`
**Output:** `build/distributions/idea-claude-code-gui-0.2.3-jh.7.zip`

---

### jh.6 (tag: `jh.6-on-jh.5-b`) — Base: upstream 0.2.1

Built on `release/jh.5-b`. First release with F-007 Diagnostic Snapshots.

**Included fixes/features:**
- Everything from jh.5 and jh.5-b
- F-007 (Diagnostic Snapshots) — initial implementation

**Branch:** `release/jh.5-b` (tagged as `jh.6-on-jh.5-b`)
**Output:** `build/distributions/idea-claude-code-gui-0.2.1-jh.6.zip`

---

### jh.5-b — Base: jh.5

Bugfix release on top of jh.5. Fixes session title persistence and editing stability.

**Included fixes:**
- B-011 — Custom title migrated from provisional/null to real sessionId
- B-013 — Guard `focusInput()` to prevent focus steal during title edit
- B-014 — `createNewSession` clears `currentSessionId`

**Branch:** `release/jh.5-b` (before jh.6 tag)

---

### jh.5 — Base: upstream 0.2.1

Built from `origin/develop` + cherry-picks. Contains ALL fixes regardless of upstream merge status.

**Included fixes/features:**
- B-001, B-002 (PR #455)
- B-003 (PR #458)
- B-005 (PR #457)
- F-001 (PR #457)
- F-002 (PR #456)

**Branch:** `release/jh.5`

---

## Upgrade & Migration

Upgrade-Checkliste, Feature-Migrationstabelle, Konflikt-Zonen und manuelle Test-Checkliste: siehe **[UPGRADE-GUIDE.md](UPGRADE-GUIDE.md)**.
