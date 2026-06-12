# Copilot-inspired icon pack v4

Run this from the repository root after the Copilot skin/laf patches have been applied:

```powershell
python .\apply-copilot-icons-v4.py
cd webview
npm run test
npm run build
cd ..
.\gradlew.bat runIde
```

The patch adds an original MIT-licensed React SVG icon pack and normalizes existing Codicons in the `github-copilot` theme.
