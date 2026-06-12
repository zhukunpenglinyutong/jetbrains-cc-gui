# Copilot context/file icon v6

Apply from the repository root after v1-v5:

```powershell
python .\apply-copilot-context-file-icons-v6.py
cd webview
npm run test
npm run build
cd ..
.\gradlew.bat runIde
```

This patch replaces the active file/context chip icon (for example `Main.java`) with the local Copilot-inspired icon pack and neutralizes leftover IDE file-type SVG colors in the Copilot theme.
