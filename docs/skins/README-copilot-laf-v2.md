# Copilot Look-and-Feel Patch v2

Dieser Patch ergänzt den bereits vorhandenen `github-copilot` Theme-Modus um screenshot-nahe UI-Regeln.
Er verändert keine Dark-/Light-Regeln direkt, sondern schreibt ausschließlich scoped CSS unter:

```less
[data-theme="github-copilot"] { ... }
```

## Anwendung

Aus dem Repo-Root:

```bash
python apply-copilot-laf-v2.py
```

Danach:

```bash
cd webview
npm run test
npm run build
cd ..
./gradlew runIde
```

Unter Windows entsprechend:

```powershell
python .\apply-copilot-laf-v2.py
cd webview
npm run test
npm run build
cd ..
.\gradlew.bat runIde
```

## Was v2 gezielt nachzieht

- äußere App-/Chat-Shell
- Header/Tab/Back/Reload-Icons
- Assistant-Markdown-Typografie
- Inline-Code und Codeblöcke
- Codeblock-Header und Codeblock-Actions
- User-Bubble
- Message-Hover-Actions
- Completed-/Model-Footer-Zeile
- großer Composer unten
- Attachment-Chips
- Send-/Stop-Buttons
- Scrollbars
- Waiting-Spinner

## Erwarteter manueller Test

1. Theme `GitHub Copilot Inspired` aktivieren.
2. Eine bestehende Unterhaltung mit Überschriften, Listen, Inline-Code und Codeblöcken öffnen.
3. Eine neue Anfrage starten.
4. Prüfen, ob Spinner, Composer, Codeblöcke, Completed-Zeile und Icons zur Screenshot-Optik passen.
5. IDE-Light/Dark umschalten: `github-copilot` muss aktiv bleiben.
