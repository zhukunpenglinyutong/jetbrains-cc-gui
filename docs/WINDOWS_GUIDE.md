# Windows Setup & Troubleshooting Guide for CC GUI

This guide covers common Windows setup problems with the CC GUI JetBrains plugin.

**Where the plugin settings are:** open the CC GUI tool window, click the gear icon (**Settings**) in the chat header, then go to **Basic Configuration → Environment**. The plugin has no page under the IDE's own Settings dialog.

---

## 1. Node.js is not found

The plugin runs on Node.js. It finds `node.exe` on your PATH and in the usual install folders (`C:\Program Files\nodejs`, nvm-windows, and others).

If it is not found, or you want a specific version:

1. Get the full path of your Node.js:
   ```cmd
   node -p "process.execPath"
   ```
2. Paste it into **Basic Configuration → Environment → Node.js Path**, for example `C:\Program Files\nodejs\node.exe`. The path must end with `node.exe`. A folder path does not work.

If your Node.js is too old, the settings page shows the minimum version.

---

## 2. Claude or Codex is not found

**Claude** does not need the `claude` command. The plugin uses the Claude Code SDK: install it under **Settings → SDK Dependencies**. Leave **Claude CLI Path (override)** empty unless you really want the plugin to run a different Claude binary.

**Codex** uses the Codex CLI installed on your machine:

1. Install it:
   ```cmd
   npm install -g @openai/codex
   ```
2. Go to **Settings → Provider Management → CLI** and click **Re-check**.

The plugin already looks in npm's default global folder (`%APPDATA%\npm`), even when that folder is not on your PATH. If you changed npm's prefix (`npm config get prefix` prints something else), either add that folder to your **user** PATH, or set the `CODEX_PATH` environment variable to the full path of `codex.cmd`.

After you change PATH or any environment variable, quit and restart the IDE. A running IDE does not see the change.

---

## 3. PowerShell says "running scripts is disabled on this system"

You may see this when you type `npm`, `claude` or `codex` in PowerShell yourself, for example while installing. PowerShell runs the `.ps1` version of these commands, and Windows blocks scripts by default. The plugin itself starts `.cmd`/`.exe` files and is not affected.

Either use Command Prompt (`cmd.exe`) instead, or allow local scripts for your user (no administrator rights needed):

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

---

## 4. Projects and CLIs inside WSL2

To run Claude and Codex inside WSL while the IDE runs on Windows:

1. Install Node.js inside WSL (Codex users: also install the Codex CLI there).
2. In WSL, print the Node.js path:
   ```bash
   which node
   ```
3. Paste that Linux path into **Node.js Path**, for example `/usr/bin/node`. The plugin then starts Claude and Codex through `wsl`.

Open WSL projects from the Windows IDE as usual (`\\wsl.localhost\<Distro>\...` or `\\wsl$\<Distro>\...`). The plugin converts these paths to Linux paths.

The plugin uses your default WSL distribution. If the project is in a different one, make it the default and restart the IDE:

```cmd
wsl --set-default <Distro>
```
