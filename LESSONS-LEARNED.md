# Lessons Learned — idea-claude-code-gui

> **Scope:** IntelliJ Plugin (Java 17), JCEF Webview (React 19/TS), Node.js ai-bridge (ESM), Gradle, Claude SDK
> **Ursprung:** Gesammelt ab 2026-03-13, fortlaufend erweitert

---

## Git & Build

### L-1: `./gradlew clean` löscht alle archivierten Builds

**Kontext:** Gradle-Build des Plugins mit mehreren gespeicherten ZIP-Versionen.
**Pitfall:** `./gradlew clean` löscht das gesamte `build/`-Verzeichnis — auch `build/releases/` und `build/distributions/`. Alles unter `build/` ist betroffen.
**Lösung:** Builds werden in `releases/` im Projekt-Root gespeichert (nicht unter `build/`). Dieses Verzeichnis ist in `.gitignore` und wird von `gradlew clean` nicht gelöscht. Nach jedem Build: `cp build/distributions/*.zip releases/<name>-<suffix>.zip`.

### L-2: Keine destructive Git-Operationen im Hauptrepo für alternative Builds

**Kontext:** Man will einen Build mit/ohne bestimmten Fix erstellen (z.B. zum A/B-Testen).
**Pitfall:** `git revert --no-commit` + `git stash` im Hauptrepo riskiert Datenverlust — untracked/staged Dateien können bei `revert --abort` verloren gehen, Stash-Refs werden nach `pop` unzuverlässig.
**Lösung:** Immer `git worktree add` für alternative Builds verwenden. Worktrees sind isoliert und zerstören nichts im Hauptrepo.

### L-3: Worktree-Builds brauchen eigenes `npm install`

**Kontext:** Plugin-Build in einem Git-Worktree (`git worktree add`).
**Pitfall:** `node_modules/` ist nicht Teil des Git-Trees. Ein Worktree-Build schlägt fehl mit "tsc not found" oder erzeugt eine zu kleine ZIP (5 MB statt 13 MB), weil `webview/node_modules/` und `ai-bridge/node_modules/` fehlen.
**Lösung:** Nach dem Erstellen eines Worktrees: `cd webview && npm install && cd ../ai-bridge && npm install` vor dem Build.

---

## Plugin / JCEF

### L-4: Jeder Chat-Tab startet einen eigenen Daemon-Prozess

**Kontext:** Plugin hat mehrere Chat-Tabs (CCG, Bugs, AI3, etc.).
**Pitfall:** Man sieht mehrere `node.exe`-Prozesse im Task-Manager und hält sie fälschlich für Zombies. Tatsächlich ist das 1:1 — jeder Tab hat seinen Daemon + SDK-Child.
**Lösung:** Anzahl Node-Prozesse mit Anzahl offener Tabs vergleichen, bevor man von Zombies ausgeht. Echte Zombies erkennt man daran, dass sie nach Schließen aller Tabs / IDEA weiter existieren.

---

## cwd / Working Directory

### L-5: Externe Dateien im Editor setzen falschen cwd

**Kontext:** Eine Datei außerhalb des Projekt-Roots ist im Editor aktiv (z.B. `~/.claude/plans/*.md`).
**Pitfall:** `resolveWorkingDirectoryFromActiveFile()` liefert das Parent-Verzeichnis der externen Datei als `cwd`. Der Claude SDK schlägt dann mit "API request failed" fehl, weil Session-History im falschen Verzeichnis gesucht wird.
**Lösung:** Die Active-File-Resolution darf nur greifen, wenn `projectPath` ungültig ist (null oder nicht existent). Fix: `resolveWorkingDirectoryFromActiveFile()` innerhalb des `projectPath == null`-Guards aufrufen. (B-033, PR #636)
