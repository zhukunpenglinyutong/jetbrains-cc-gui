\# Windows Setup \& Troubleshooting Guide for CC GUI



This guide resolves common Windows environment and CLI integration issues when using the CC GUI JetBrains plugin with tools like Claude Code, Codex, and other AI CLIs.



\---



\## 1. PowerShell Script Execution Policy Error

If you see an error like `cannot be loaded because running scripts is disabled on this system`:



Open PowerShell as Administrator and run:

```powershell

Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

```



\---



\## 2. 'command not found' (Claude / Codex CLI)

When running CLIs installed via npm globally, Windows may not expose them to IntelliJ's PATH.



1\. Find your global npm path:

&#x20;  ```cmd

&#x20;  npm config get prefix

&#x20;  ```

&#x20;  \*(Usually: `C:\\Users\\<Username>\\AppData\\Roaming\\npm`)\*

2\. Add that path to your \*\*System Environment Variables -> PATH\*\*.

3\. In JetBrains: Go to \*\*Settings -> Tools -> CC GUI\*\* and set the explicit executable path if auto-detection fails.



\---



\## 3. WSL2 (Windows Subsystem for Linux) Setup

If your project files or AI CLI are running inside WSL2:

\- Ensure the project path does not use raw UNC paths (`\\\\wsl$\\...`) if your IDE version struggles with file locks.

\- Launch IntelliJ directly from inside WSL via:

&#x20; ```bash

&#x20; idea .

&#x20; ```

