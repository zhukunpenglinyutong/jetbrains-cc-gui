# jh-Fork Upgrade Guide

Anleitung fuer die Migration der privaten Feature-Schicht auf eine neue Upstream-Version.

---

## 1. Upgrade Checklist

When the maintainer releases a new version (e.g. 0.3.1):

1. `git fetch origin`
2. **TRACKER.md pruefen:** Jeden Bug/Feature gegen die neue Version abgleichen:
   - PR merged upstream → Status `merged`, aus Re-Apply-Liste entfernen
   - Bug upstream gefixt → Status `fixed`, Since aktualisieren
   - Noch offen → bleibt in der Re-Apply-Liste
3. Neuen Branch: `git checkout -b release/jh.N v0.X.Y`
4. **Infrastruktur re-apply:** `plugin.xml` (ID/Name -jh), `build.gradle` (Version -jh.N)
5. **Diagnostic Layer portieren** (Abschnitt 2) — Dateien kopieren + Integrationspunkte setzen
6. Nach jedem Schritt: `./gradlew.bat compileJava -x buildWebview` + `cd webview && npm run build`
7. Vollstaendiger Build: `./gradlew.bat buildPlugin`
8. Manuell testen (siehe Abschnitt 8)
9. TRACKER.md: neuen Release-Eintrag, StatusChangedOn aktualisieren
10. Commit + Push auf `fork`

---

## 2. Diagnostic Layer — Portable Architektur (ab jh.12)

Die Diagnostic-Schicht ist als **Single-Entry-Point-Architektur** aufgebaut. Jede Upstream-Datei hat max. 1-2 klar markierte Integrationspunkte (`// F-007`, `// F-010`).

### 2.1 Architektur-Ueberblick

```
┌─── Java ──────────────────────────────────────────────┐
│                                                        │
│  DiagnosticManager  (zentrale Fassade)                 │
│  ├── DiagnosticHandler  (Snapshots, Bugs, IPC)         │
│  ├── DiagnosticFileWatcher  (Cross-Instance)           │
│  ├── IpcSnifferWriter  (Traffic Logger)                │
│  └── DiagnosticConfig  (Config I/O)                    │
│                                                        │
│  Upstream-Integrationspunkte (v0.3.1 Pfade):          │
│  · ui/ChatWindowDelegate: 1 Feld + init + dispose      │
│  · provider/common/BaseSDKBridge: IPC-Logging Feld     │
│  · provider/claude/ClaudeProcessInvoker: 2 log-Calls   │
│  · provider/claude/ClaudeDaemonRequestExecutor: 2 Calls│
│  · ui/toolwindow/ClaudeSDKToolWindow: getAllWindows()   │
└────────────────────────────────────────────────────────┘

┌─── Webview ───────────────────────────────────────────┐
│                                                        │
│  useDiagnostics  (zentrale Fassade)                    │
│  ├── useDiagnosticRingBuffer  (Event-Buffer)           │
│  ├── collectSnapshot  (Snapshot-Builder)               │
│  └── BugDropdown  (Bug-Auswahl UI)                     │
│                                                        │
│  Upstream-Integrationspunkte (v0.3.1 Pfade):          │
│  · App.tsx: ~8 Zeilen (State + Hook-Aufrufe)           │
│  · useScrollBehavior.ts: onDiagnosticEvent param       │
│  · windowCallbacks/registerCallbacks.ts (NEU: modular) │
│  ·   → registerStreamingCallbacks: 3 Events            │
│  ·   → registerMessageCallbacks: 1 Event               │
│  · ChatHeader.tsx: BugDropdown + 4 Props               │
│  · global.d.ts: Window-Typen                           │
│  · Settings-Dateien: Tracker-Path + Sniffer UI         │
└────────────────────────────────────────────────────────┘
```

### 2.2 Dateien — Eigene (kopieren, keine Konflikte)

**Java (6 Dateien):**

| Datei | Feature |
|-------|---------|
| `src/.../diagnostics/DiagnosticManager.java` | Zentrale Fassade |
| `src/.../diagnostics/DiagnosticConfig.java` | Config I/O (Static Utility) |
| `src/.../diagnostics/IpcSnifferWriter.java` | Traffic Logger |
| `src/.../handler/DiagnosticHandler.java` | Snapshots + Bugs + Tracker + IPC Settings |
| `src/.../handler/DiagnosticFileWatcher.java` | Cross-Instance Trigger |
| `src/.../service/TrackerParser.java` | TRACKER.md Parser |

**Webview (11 Dateien):**

| Datei | Feature |
|-------|---------|
| `webview/src/hooks/useDiagnostics.ts` | Zentrale Fassade |
| `webview/src/hooks/useDiagnosticRingBuffer.ts` | Event-Ring-Buffer |
| `webview/src/diagnostics/collectSnapshot.ts` | Snapshot-Builder |
| `webview/src/diagnostics/knownBugs.ts` | Bug-Definitionen |
| `webview/src/components/ChatHeader/BugDropdown.tsx` | Bug-Dropdown UI |
| `webview/src/components/ChatHeader/BugDropdown.test.tsx` | Test |
| `webview/src/hooks/useDiagnosticRingBuffer.test.ts` | Test |
| `webview/src/diagnostics/collectSnapshot.test.ts` | Test |
| `webview/src/diagnostics/trackerParser.test.ts` | Test |
| `webview/src/hooks/useScrollBehavior.test.ts` | Test |
| `webview/src/components/settings/hooks/useSettingsWindowCallbacks.test.ts` | Test |

### 2.3 Dateien — Upstream modifiziert (Integrationspunkte)

Jede Modifikation ist mit `// F-007`, `// F-010` o.ae. markiert und kann per Grep gefunden werden.

**Java (7 Dateien, ~40 Zeilen total):**

| Datei (v0.3.1 Pfad) | Aenderung | Zeilen | Feature |
|----------------------|-----------|--------|---------|
| `ui/ChatWindowDelegate.java` | 1 Import + 1 Feld `DiagnosticManager` + `init()` in `initializeHandlers()` + `dispose()` in `dispose()` | ~6 | F-007 |
| `ui/ChatWindowDelegate.java` | `TAB_STATUS_INDICATOR_KEY` Konstante + `updateTabStatus()` liest `PropertiesComponent` + bedingte Suffixe | ~12 | F-014 ⚡ |
| `provider/common/BaseSDKBridge.java` | 1 protected Feld `DiagnosticManager` + `setDiagnosticManager()` + shutdown in `cleanupAllProcesses()` | ~6 | F-010 |
| `provider/claude/ClaudeProcessInvoker.java` | Constructor-Parameter `DiagnosticManager` + 2 log-Aufrufe (outbound + inbound) | ~6 | F-010 |
| `provider/claude/ClaudeDaemonRequestExecutor.java` | Constructor-Parameter `DiagnosticManager` + 2 log-Aufrufe (outbound + inbound) | ~6 | F-010 |
| `ui/toolwindow/ClaudeSDKToolWindow.java` | `getAllWindows()` static method (B-026) | ~3 | B-026 |
| `handler/ProjectConfigHandler.java` | `handleGet/SetTabStatusIndicator()` via `PropertiesComponent` | ~25 | F-014 ⚡ |
| `handler/SettingsHandler.java` | Routing fuer `get/set_tab_status_indicator` | ~4 | F-014 ⚡ |

**Webview (13 Dateien, ~90 Zeilen total):**

| Datei | Aenderung | Zeilen | Feature |
|-------|-----------|--------|---------|
| `App.tsx` | 2 Imports + diagnostics state + `useDiagnosticRingBuffer()` + `useDiagnostics()` + `/report` check + ChatHeader-Props | ~8 | F-007 |
| `useScrollBehavior.ts` | `onDiagnosticEvent` in Options + Ref + 2 Event-Emissionen | ~12 | F-007 |
| `windowCallbacks/registerStreamingCallbacks.ts` | `onDiagnosticEvent` Ref + 3 Events (onStreamStart, onContentDelta, onStreamEnd) | ~8 | F-007 |
| `windowCallbacks/registerMessageCallbacks.ts` | `onDiagnosticEvent` Ref + 1 Event (updateMessages) + `__turnId` Index-Guard | ~8 | F-007, B-034 ⚡ |
| `ChatHeader.tsx` | BugDropdown import + 4 Props + Dropdown-Logik | ~30 | F-007 |
| `global.d.ts` | 6 Window-Typ-Deklarationen + `updateTabStatusIndicator` | ~7 | F-007, F-014 ⚡ |
| `settings/index.tsx` | TrackerPath + IPC Sniffer + TabStatusIndicator State/Props | ~20 | F-008, F-010, F-014 ⚡ |
| `settings/hooks/useSettingsWindowCallbacks.ts` | Callbacks + Init-Requests (Tracker, Sniffer, TabStatus) | ~25 | F-008, F-010, F-014 ⚡ |
| `settings/hooks/useSettingsBasicActions.ts` | TabStatusIndicator state + handler + streamingRenderTables/Lists (localStorage) | ~25 | F-014 ⚡, B-029 ⚡ |
| `settings/BasicConfigSection/EnvironmentTab.tsx` | Tracker-Path Input UI | ~15 | F-008 |
| `settings/BasicConfigSection/BehaviorTab.tsx` | TabStatusIndicator Toggle + StreamingRender Toggles (Tables/Lists) | ~20 | F-014 ⚡, B-029 ⚡ |
| `settings/BasicConfigSection/index.tsx` | Props-Plumbing fuer TabStatusIndicator + StreamingRender | ~8 | F-014 ⚡, B-029 ⚡ |
| `components/MarkdownBlock.tsx` | Streaming-Tabellen-Parser + `.table-wrapper` DOMParser-Wrapping + `div` in ALLOWED_TAGS + `minHeight`-Lock bei Stream-Ende | ~80 | B-029 ⚡, B-037 ⚡ |
| `styles/less/components/message.less` | `.table-wrapper` CSS + `table-layout: auto` + `margin-top: 0` auf `p` + Cursor-Regeln (B-038) | ~15 | B-029 ⚡, B-038 ⚡ |

> ⚡ = Upstream-PR offen. Falls gemergt, entfaellt der Integrationspunkt beim naechsten Upgrade.

---

## 3. Portierungs-Anleitung: jh.13 auf v0.3.1

### Schritt 1: Branch + Infrastruktur

```bash
git fetch origin
git checkout -b release/jh.13 v0.3.1
```

**plugin.xml** (`src/main/resources/META-INF/plugin.xml`):
```xml
<!-- Aendern: -->
<id>com.github.idea-claude-code-gui-jh</id>
<name>CC GUI（Claude or Codex）-jh</name>
```

**build.gradle**:
```groovy
version = '0.3.1-jh.13'
```

**Kompilierungstest:**
```bash
./gradlew.bat compileJava -x buildWebview
```

### ~~Schritt 1a: B-033 Cherry-Pick~~ — ENTFAELLT

PR [#636](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/pull/636) wurde in v0.2.9 gemerged (Commit `d11672e`). Der Fix ist in v0.3.1 enthalten.

### Schritt 2: Eigene Dateien kopieren

**Achtung:** In v0.3.1 wurde die Java-Paketstruktur komplett reorganisiert. Handler haben jetzt Subpackages. Die eigenen Dateien muessen in die **neue** Paketstruktur passen.

**Java-Dateien** — direkt kopieren (Paket `diagnostics` und `service` existieren weiter):
```bash
git checkout release/jh.12 -- \
  src/main/java/com/github/claudecodegui/diagnostics/ \
  src/main/java/com/github/claudecodegui/service/TrackerParser.java \
  webview/src/diagnostics/ \
  webview/src/hooks/useDiagnostics.ts \
  webview/src/hooks/useDiagnosticRingBuffer.ts \
  webview/src/hooks/useDiagnosticRingBuffer.test.ts \
  webview/src/hooks/useScrollBehavior.test.ts \
  webview/src/components/ChatHeader/BugDropdown.tsx \
  webview/src/components/ChatHeader/BugDropdown.test.tsx \
  webview/src/components/settings/hooks/useSettingsWindowCallbacks.test.ts \
  webview/src/styles/less/components/header.less \
  docs/bugs-jh/
```

**Handler-Dateien** — muessen ggf. in Subpackages verschoben werden:
```bash
# DiagnosticHandler und DiagnosticFileWatcher liegen in jh.12 unter handler/
# In v0.3.1 gibt es handler-Subpackages (core, diff, file, history, provider).
# Unsere Diagnostic-Handler passen am besten direkt unter handler/ (kein Subpackage noetig)
# da sie keiner bestehenden Domain zugehoeren.
git checkout release/jh.12 -- \
  src/main/java/com/github/claudecodegui/handler/DiagnosticHandler.java \
  src/main/java/com/github/claudecodegui/handler/DiagnosticFileWatcher.java
```

**Import-Anpassungen in kopierten Dateien:**

Die folgenden Imports muessen in den kopierten Java-Dateien aktualisiert werden, weil sich die Upstream-Klassen verschoben haben:

| Alte Import-Pfade (jh.12 / v0.2.8) | Neue Import-Pfade (v0.3.1) |
|-------------------------------------|----------------------------|
| `com.github.claudecodegui.ClaudeSDKBridge` | `com.github.claudecodegui.provider.claude.ClaudeSDKBridge` |
| `com.github.claudecodegui.ClaudeSession` | `com.github.claudecodegui.session.ClaudeSession` |
| `com.github.claudecodegui.CodemossSettingsService` | `com.github.claudecodegui.settings.CodemossSettingsService` |
| `com.github.claudecodegui.ClaudeCodeGuiBundle` | `com.github.claudecodegui.i18n.ClaudeCodeGuiBundle` |
| `com.github.claudecodegui.ClaudeChatWindow` | `com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow` |
| `com.github.claudecodegui.ClaudeSDKToolWindow` | `com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow` |
| `com.github.claudecodegui.BaseMessageHandler` | `com.github.claudecodegui.handler.core.BaseMessageHandler` |
| `com.github.claudecodegui.HandlerContext` | `com.github.claudecodegui.handler.core.HandlerContext` |
| `com.github.claudecodegui.MessageDispatcher` | `com.github.claudecodegui.handler.core.MessageDispatcher` |
| `com.github.claudecodegui.SessionLoadService` | `com.github.claudecodegui.session.SessionLoadService` |

**Tipp:** Nach dem Kopieren `grep -rn "com.github.claudecodegui.Claude" src/main/java/com/github/claudecodegui/diagnostics/ src/main/java/com/github/claudecodegui/handler/Diagnostic* src/main/java/com/github/claudecodegui/service/TrackerParser.java` ausfuehren und alle alten Root-Package-Imports korrigieren.

**Kompilierungstest:**
```bash
./gradlew.bat compileJava -x buildWebview
```

### Schritt 3: Java-Integrationspunkte setzen

#### 3.1 ChatWindowDelegate.java

**Pfad:** `src/main/java/com/github/claudecodegui/ui/ChatWindowDelegate.java`

```java
// 1. Import hinzufuegen
import com.github.claudecodegui.diagnostics.DiagnosticManager;

// 2. Feld hinzufuegen (nach `private final DelegateHost host;`)
private final DiagnosticManager diagnosticManager = new DiagnosticManager();

// 3. Am Ende von initializeHandlers():
diagnosticManager.init(handlerContext, messageDispatcher, host.getClaudeSDKBridge());

// 4. Am Anfang von dispose():
diagnosticManager.dispose();
```

#### 3.2 IPC-Logging via BaseSDKBridge

In v0.3.1 wurde `ClaudeSDKBridge` in viele Helper-Klassen aufgeteilt. Das IPC-Logging-Feld wandert daher in die gemeinsame Basisklasse `BaseSDKBridge`, von wo es per Constructor-Parameter an die Helper-Klassen durchgereicht wird.

**3.2a) BaseSDKBridge.java** (`provider/common/BaseSDKBridge.java`) — 3 Aenderungen:
```java
// 1. Import
import com.github.claudecodegui.diagnostics.DiagnosticManager;

// 2. Feld + Setter (nach den anderen protected Fields):
protected volatile DiagnosticManager diagnosticManager;
public void setDiagnosticManager(DiagnosticManager dm) { this.diagnosticManager = dm; }

// 3. In cleanupAllProcesses() (nach processManager.cleanupAllProcesses()):
if (diagnosticManager != null) { diagnosticManager.shutdownSniffer(); }
```

**3.2b) ClaudeSDKBridge.java** (`provider/claude/ClaudeSDKBridge.java`) — 2 Aenderungen:

`diagnosticManager` an die beiden Helper-Klassen durchreichen. Da `ClaudeProcessInvoker` und `ClaudeDaemonRequestExecutor` im Constructor erstellt werden, `diagnosticManager` aber erst spaeter via `setDiagnosticManager()` gesetzt wird, muessen die Helper-Klassen einen **Supplier** oder eine **Referenz auf das Bridge-Feld** bekommen:

```java
// Im Constructor, bei Erstellung von processInvoker:
// diagnosticManager als Supplier durchreichen: () -> diagnosticManager
this.processInvoker = new ClaudeProcessInvoker(
    LOG, gson, nodeDetector, sdkDirSupplier, processManager,
    envConfigurator, requestParamsBuilder, logSanitizer, streamAdapter,
    () -> diagnosticManager  // NEU
);

// Analog fuer daemonRequestExecutor:
this.daemonRequestExecutor = new ClaudeDaemonRequestExecutor(
    LOG, requestParamsBuilder, streamAdapter, jsonOutputExtractor,
    () -> diagnosticManager  // NEU
);
```

**3.2c) ClaudeProcessInvoker.java** (`provider/claude/`) — 3 Aenderungen:
```java
// 1. Neuer Constructor-Parameter:
private final java.util.function.Supplier<DiagnosticManager> diagnosticManagerSupplier;

// 2. Nach sanitizedJson (outbound):
DiagnosticManager dm = diagnosticManagerSupplier.get();
if (dm != null) { dm.logOutbound(sessionId, channelId, model, "process", sanitizedJson); }

// 3. In reader-Loop (inbound, erste Zeile nach while):
DiagnosticManager dm = diagnosticManagerSupplier.get();
if (dm != null) { dm.logInbound(sessionId, line); }
```

**3.2d) ClaudeDaemonRequestExecutor.java** (`provider/claude/`) — 3 Aenderungen:
```java
// 1. Neuer Constructor-Parameter:
private final java.util.function.Supplier<DiagnosticManager> diagnosticManagerSupplier;

// 2. Vor sendCommand (outbound):
DiagnosticManager dm = diagnosticManagerSupplier.get();
if (dm != null) { dm.logOutbound(sessionId, channelId, model, "daemon", json); }

// 3. In onLine (inbound):
DiagnosticManager dm = diagnosticManagerSupplier.get();
if (dm != null) { dm.logInbound(sessionId, line); }
```

**DiagnosticManager.init()** behaelt die Signatur `init(HandlerContext, MessageDispatcher, ClaudeSDKBridge)` — `setDiagnosticManager()` ist von `BaseSDKBridge` geerbt und funktioniert weiterhin.

#### 3.3 ClaudeSDKToolWindow.java

**Pfad:** `src/main/java/com/github/claudecodegui/ui/toolwindow/ClaudeSDKToolWindow.java`

```java
// Methode hinzufuegen (fuer B-026 Multi-Tab-Propagation):
public static java.util.Collection<ClaudeChatWindow> getAllWindows() {
    return contentToWindowMap.values();
}
```

Das Feld `contentToWindowMap` existiert weiterhin an gleicher Stelle.

**Kompilierungstest:**
```bash
./gradlew.bat compileJava -x buildWebview
```

### Schritt 4: Webview-Integrationspunkte

#### 4.1 NICHT kopieren — manuell mergen

In v0.3.1 wurden die Webview-Dateien erheblich refactored. **Blind kopieren von jh.12 wuerde upstream-Aenderungen zerstoeren.** Stattdessen: v0.3.1-Dateien lesen und die `// F-007` / `// F-010` Bloecke manuell einfuegen.

#### 4.2 Aenderungsliste (Webview)

**`App.tsx`** — ~8 Zeilen:
```typescript
// 1. Imports
import { useDiagnostics } from './hooks/useDiagnostics';
import { useDiagnosticRingBuffer } from './hooks/useDiagnosticRingBuffer';

// 2. State (nach anderen useState)
const [activeBugId, setActiveBugId] = useState<string | null>(null);
const [knownBugsForDropdown, setKnownBugsForDropdown] = useState<...>([]);

// 3. Hooks
const { onDiagnosticEvent } = useDiagnosticRingBuffer();
useDiagnostics({ messages, activeBugId, onDiagnosticEvent, ... });

// 4. /report check (im Send-Handler)
// 5. ChatHeader-Props: activeBugId, setActiveBugId, knownBugsForDropdown
```

**`useScrollBehavior.ts`** — ~12 Zeilen:
```typescript
// Options-Interface erweitern um onDiagnosticEvent
// Ref anlegen: diagnosticEventRef = useRef(onDiagnosticEvent)
// 2 Event-Emissionen: scroll_to_bottom, user_scrolled_up
```

**`hooks/windowCallbacks/registerStreamingCallbacks.ts`** — ~8 Zeilen (NEU in v0.3.1):
```typescript
// In v0.3.1 wurde useWindowCallbacks in 6 Sub-Module aufgeteilt.
// Die Streaming-Events (onStreamStart, onContentDelta, onStreamEnd)
// liegen jetzt in registerStreamingCallbacks.ts.
// onDiagnosticEvent-Ref aus Options + 3 Event-Emissionen einfuegen.
```

**`hooks/windowCallbacks/registerMessageCallbacks.ts`** — ~4 Zeilen:
```typescript
// updateMessages-Callback: 1 Event-Emission (messages_update)
```

**`components/ChatHeader/ChatHeader.tsx`** — ~30 Zeilen:
```typescript
// BugDropdown import + 4 Props (activeBugId, setActiveBugId, knownBugs, onBugSelect)
// BugDropdown-Rendering neben dem Header-Title
```

**`global.d.ts`** — ~6 Zeilen:
```typescript
// Window-Typ-Deklarationen: collectDiagnosticSnapshot, onDiagnosticEvent, etc.
```

**`settings/index.tsx`** — ~15 Zeilen:
```typescript
// State: trackerPath, ipcSnifferEnabled
// Props an BasicConfigSection + OtherSettingsSection weiterreichen
```

**`settings/hooks/useSettingsWindowCallbacks.ts`** — ~20 Zeilen:
```typescript
// Callbacks: updateTrackerPath, updateIpcSnifferEnabled
// Init-Requests: get_tracker_path, get_ipc_sniffer_enabled
```

**`settings/BasicConfigSection/EnvironmentTab.tsx`** — ~15 Zeilen:
```typescript
// Tracker-Path Input mit "Found"/"Not found" Badge
```

#### 4.3 Webview Build + Test

```bash
cd webview && npm run build     # TypeScript-Fehler aufdecken
cd webview && npx vitest run    # Tests
```

### Schritt 5: Vollstaendiger Build

```bash
# Backup bestehender ZIPs
cp build/distributions/*.zip build/releases/ 2>/dev/null

# Build
./gradlew.bat buildPlugin
```

---

## 4. v0.3.1 Paket-Mapping (Java)

Referenz fuer die Import-Aktualisierung. Zeigt wohin Upstream-Klassen in v0.3.1 verschoben wurden.

### 4.1 Klassen-Verschiebungen

| Klasse | Alter Pfad (v0.2.8) | Neuer Pfad (v0.3.1) |
|--------|----------------------|----------------------|
| `ClaudeSDKBridge` | root | `provider/claude/` |
| `CodexSDKBridge` | root | `provider/codex/` |
| `ClaudeSession` | root | `session/` |
| `SessionLoadService` | root | `session/` |
| `CodemossSettingsService` | root | `settings/` |
| `ClaudeCodeGuiBundle` | root | `i18n/` |
| `ClaudeChatWindow` | root | `ui/toolwindow/` |
| `ClaudeSDKToolWindow` | root | `ui/toolwindow/` |
| `ChatWindowDelegate` | root | `ui/` |
| `BaseMessageHandler` | `handler/` | `handler/core/` |
| `HandlerContext` | `handler/` | `handler/core/` |
| `MessageDispatcher` | `handler/` | `handler/core/` |
| `HistoryHandler` | `handler/` | `handler/history/` |
| `FileHandler` | `handler/` | `handler/file/` |
| `ProviderHandler` | `handler/` | `handler/provider/` |

### 4.2 Neue Klassen in v0.3.1 (diagnostics-relevant)

| Klasse | Pfad | Relevanz |
|--------|------|----------|
| `BaseSDKBridge` | `provider/common/` | IPC-Logging-Feld + Setter + Shutdown |
| `ClaudeProcessInvoker` | `provider/claude/` | Process-Mode IPC: Supplier-Param + 2 log-Calls |
| `ClaudeDaemonRequestExecutor` | `provider/claude/` | Daemon-Mode IPC: Supplier-Param + 2 log-Calls |
| `ClaudeDaemonCoordinator` | `provider/claude/` | Daemon lifecycle (nicht IPC-relevant) |
| `registerStreamingCallbacks.ts` | `hooks/windowCallbacks/` | Ersetzt Teile von useWindowCallbacks |
| `registerMessageCallbacks.ts` | `hooks/windowCallbacks/` | Ersetzt Teile von useWindowCallbacks |

---

## 5. Known Conflict Zones

Dateien die bei Upgrades **typischerweise** kollidieren:

| Datei | Grund | Strategie |
|-------|-------|-----------|
| `App.tsx` | Diagnostics state + hooks (kompakt ~8 Zeilen) | Manuell einfuegen, nicht blind kopieren |
| `provider/common/BaseSDKBridge.java` | IPC-Logging Feld + Setter + Shutdown | 3 Zeilen, Feld + Setter + cleanupAllProcesses |
| `provider/claude/ClaudeProcessInvoker.java` | IPC outbound/inbound (Process-Mode) | Supplier-Parameter + 2 log-Aufrufe |
| `provider/claude/ClaudeDaemonRequestExecutor.java` | IPC outbound/inbound (Daemon-Mode) | Supplier-Parameter + 2 log-Aufrufe |
| `windowCallbacks/registerStreamingCallbacks.ts` | Diagnostics-Events in Streaming-Callbacks | Ref durchreichen, 3 Events einfuegen |
| `windowCallbacks/registerMessageCallbacks.ts` | Diagnostics-Event + B-034 `__turnId`-Guard | 1 Event + Index-Vergleich einfuegen |
| `useScrollBehavior.ts` | Diagnostics-Events in Scroll-Callbacks | Options erweitern, 2 Events einfuegen |
| `ChatHeader.tsx` | Bug-Button + Props | Diagnostics-Props am Ende der Prop-Liste |
| `settings/index.tsx` | Tracker-Path + Sniffer + TabStatus State | State-Block am Anfang der Komponente |
| `components/MarkdownBlock.tsx` | B-029 Streaming-Tabellen + B-037 minHeight-Lock ⚡ | Tabellen-Parser in `renderStreamingContent`, DOMParser-Wrapping, `minHeight`-Lock in `applyRefresh` |
| `styles/less/components/message.less` | B-029 table-layout + B-038 Cursor ⚡ | `.table-wrapper` CSS, `table-layout: auto`, Cursor-Regeln |
| `ui/ChatWindowDelegate.java` | F-014 Tab-Status-Indicator ⚡ | `TAB_STATUS_INDICATOR_KEY` + `updateTabStatus()` Logik |
| `handler/ProjectConfigHandler.java` | F-014 Get/Set-Handler ⚡ | 2 Methoden + `PropertiesComponent` |
| `handler/SettingsHandler.java` | F-014 Routing ⚡ | 2 Cases in handle() |
| `settings/BasicConfigSection/BehaviorTab.tsx` | F-014 + B-029 Toggles ⚡ | TabStatusIndicator + StreamingRender Toggles |
| `settings/hooks/useSettingsBasicActions.ts` | F-014 + B-029 State ⚡ | TabStatusIndicator state/handler + localStorage Toggles |

> ⚡ = Upstream-PR offen. Falls gemergt, entfaellt der Konflikt beim naechsten Upgrade.

---

## 6. Upstream-merged Features (nur bei Regression re-apply)

| ID | PRs | Beschreibung | Status |
|----|-----|-------------|--------|
| F-001 | #457 | Editable session titles | merged |
| F-002 | #456 | Scroll-lock on wheel-up | merged |
| B-001..B-003 | #455, #458 | ChatInputBox fixes | merged |
| B-005, B-011..B-014 | #457, #462 | Title persistence fixes | merged |
| B-033 | #636 | SessionHandler cwd fix | **merged** (v0.2.9) |
| B-035 | #634 | Zombie Node.js processes | **merged** (v0.2.9) |
| B-029+B-037 | #765 | Streaming table render + minHeight-Lock | **open** (jh.13) |
| B-034 | #764 | Streaming placeholder guard (`__turnId`) | **open** (jh.13) |
| F-014 | #766 | Tab status indicator toggle | **open** (jh.13) |
| B-038 | #767 | Cursor arrow on scrollbars | **open** (jh.13) |

---

## 7. Lessons Learned

### A. Daemon-Architektur (v0.2.2+) aendert Session-Management grundlegend

**Problem:** F-009 (Session Auto-Compact) war mit v0.2.7 inkompatibel.
**Lesson:** Vor jedem Upgrade pruefen, ob sich das Session-Management geaendert hat.

### B. Working Tree vs. Committed State beim Build

**Problem:** `gradlew buildPlugin` baut vom Working Tree, nicht von committed Files.
**Lesson:** Fuer saubere Vergleichs-Builds immer `git stash` oder separaten Worktree verwenden.

### C. Callback-Doppelregistrierung in Settings

**Problem:** `settings/index.tsx` ueberschrieb Window-Callbacks aus `useSettingsWindowCallbacks`.
**Lesson:** Window-Callbacks gehoeren **ausschliesslich** in `useSettingsWindowCallbacks`.

### D. Externe Dateien im Editor crashen Sessions (B-033)

**Lesson:** Nach jedem Upgrade-Build mit projektfremden Dateien im Editor testen.

### E. TrackerParser-Regex muss zum Tabellenformat passen

**Lesson:** Bei jeder Aenderung am TRACKER.md-Tabellenformat die `BUG_PATTERN` in `TrackerParser.java` pruefen.

### F. DiagnosticConfig statt CodemossSettingsService

**Problem (jh.11):** Diagnostic-Settings in CodemossSettingsService gemischt → unnoetige Upstream-Abhaengigkeit.
**Lesson:** Eigene Config-Klasse (`DiagnosticConfig`) liest/schreibt dieselbe `config.json`, aber ohne Upstream-Code zu modifizieren.

### G. Massives Paket-Refactoring in v0.3.x — NICHT blind kopieren

**Problem (v0.3.1):** Java-Pakete komplett nach Domain reorganisiert, ClaudeSDKBridge in 10+ Klassen aufgeteilt, Handler in Subpackages. Webview registerCallbacks in 6 Module aufgeteilt.
**Lesson:** Bei grossen Upstream-Refactorings IMMER die v0.3.1-Dateien als Basis nehmen und unsere Integrationspunkte manuell einfuegen. Niemals alte jh-Versionen der Upstream-modifizierten Dateien kopieren — das zerstoert Upstream-Aenderungen.

### H. IPC-Logging: BaseSDKBridge + Supplier-Pattern (ab jh.13)

**Problem (v0.3.1):** ClaudeSDKBridge ist in viele Helper-Klassen aufgeteilt (ClaudeProcessInvoker, ClaudeDaemonRequestExecutor). Die Helper sind package-private und werden im Constructor erstellt, aber `diagnosticManager` wird erst spaeter via `setDiagnosticManager()` gesetzt.
**Loesung:** Feld in `BaseSDKBridge` (protected, volatile). Helper-Klassen bekommen `Supplier<DiagnosticManager>` als Constructor-Parameter (`() -> diagnosticManager`), damit sie zum Zeitpunkt des Aufrufs den aktuellen Wert lesen.

### I. Worktree-Builds fehlt die ai-bridge (jh.13)

**Problem:** `gradlew buildPlugin` in git-Worktrees erzeugt 4.7 MB ZIPs statt 13 MB — die ai-bridge wird nicht korrekt gepackt (nur 131 KB statt mehrere MB, node_modules fehlen).
**Lesson:** Fuer PR-Builds NICHT Worktrees verwenden. Stattdessen die Branches sequentiell im Hauptrepo auschecken und bauen. Die ai-bridge-Packlogik im Gradle-Build setzt voraus, dass `ai-bridge/node_modules/` vollstaendig vorhanden ist.

### J. Upstream-PRs: Konflikt-Freiheit zwischen PRs sicherstellen (jh.13)

**Problem:** PR4 (B-038 Cursor) setzte Tabellen-Cursor-Regeln auf die alte CSS-Struktur. PR1 (B-029) aenderte die Tabellen-CSS komplett (`.table-wrapper`). Falls PR1 zuerst mergt, waeren die Cursor-Regeln in PR4 falsch.
**Lesson:** Bei mehreren parallelen Upstream-PRs pruefen, ob sie sich gegenseitig beeinflussen. Abhaengige Aenderungen in den jeweiligen PR aufnehmen (z.B. Tabellen-Cursor in PR1 statt in PR4).

---

## 8. Manual Test Checklist

Nach jedem Upgrade folgende Punkte manuell pruefen:

- [ ] Plugin startet ohne Fehler
- [ ] Neue Session erstellen + 2 Nachrichten senden
- [ ] Bestehende Session aus History laden
- [ ] Session Title editieren (Pencil → Edit → Save)
- [ ] Bug-Button: Dropdown oeffnet, zeigt Bugs mit korrekten Farben
- [ ] Bug-Button: Bug auswaehlen → Snapshot wird geschrieben
- [ ] `/report B-XXX` im Chat → Snapshot wird geschrieben
- [ ] Settings → Environment → Tracker Path: Pfad setzen, "Found"-Badge pruefen
- [ ] Settings → Other → IPC Traffic Logger: Einschalten, Nachricht senden, JSONL pruefen
- [ ] IPC Sniffer: Zweiten Tab oeffnen → Sniffer-State synchron
- [ ] Projektfremde Datei im Editor oeffnen → Session funktioniert trotzdem (B-033)
- [ ] `cd webview && npx vitest run` — alle eigenen Tests gruen
- [ ] Provider wechseln → Session funktioniert (v0.3.1 Provider-Refactoring)
- [ ] CLI Login Provider testen (falls OAuth konfiguriert)
- [ ] **jh.13:** Tabelle im Stream → wird als HTML gerendert sobald vollstaendig (B-029)
- [ ] **jh.13:** Tabellen-Spaltenbreiten passen sich Inhalt an, breite Tabellen horizontal scrollbar (B-029)
- [ ] **jh.13:** Settings → Behavior → "Render tables during streaming" Toggle funktioniert (B-029)
- [ ] **jh.13:** Layout-Shift am Stream-Ende reduziert (B-037)
- [ ] **jh.13:** Bestehende Session mit tool_use: neuer Prompt → Antwort verschwindet nicht (B-034)
- [ ] **jh.13:** Settings → Behavior → "Tab status indicator" Toggle: ein/aus, persistiert (F-014)
- [ ] **jh.13:** Cursor ueber Scrollbalken (Code-Block, Chat) zeigt Pfeil, nicht I-beam (B-038)
