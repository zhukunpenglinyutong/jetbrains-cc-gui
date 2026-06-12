# Copilot attachment strip v5

Apply from the repository root after v1/v2/v3/v4:

```powershell
python .\apply-copilot-attachments-v5.py
cd webview
npm run test
npm run build
cd ..
.\gradlew.bat runIde
```

This patch moves the attachment list closest to the editable prompt and styles it as a GitHub Copilot inspired horizontal attachment strip.
