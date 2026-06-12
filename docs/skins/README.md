# GitHub Copilot Inspired Skin Patch

This package applies a scoped `github-copilot` skin to `Miguel0888/jetbrains-cc-gui`.

## What it changes

- Adds `UiThemeMode = 'light' | 'dark' | 'system' | 'github-copilot'`
- Persists the new mode in `localStorage('theme')`
- Applies `data-theme="github-copilot"` without being overwritten by IDE theme changes
- Adds a scoped Less skin at `webview/src/styles/less/copilot-skin.less`
- Imports the skin from `webview/src/styles/app.less`
- Adds a Copilot-inspired Settings option by cloning the existing System theme button
- Replaces the old dual-ring waiting animation in this skin with a single GitHub/Primer-like circular spinner
- Adds a small Vitest test for the new theme mode

## Apply

Run from the repository root:

```bash
python apply-copilot-skin.py
```

On Windows:

```powershell
py .\apply-copilot-skin.py
```

## Test

```bash
cd webview
npm install
npm run test
npm run build
```

Then start the plugin sandbox:

```bash
./gradlew runIde
```

On Windows:

```powershell
.\gradlew.bat runIde
```

## Manual acceptance test

1. Open Settings.
2. Select `GitHub Copilot Inspired`.
3. Close and reopen the plugin.
4. Switch the IDE theme between Light and Dark.
5. The webview must keep `data-theme="github-copilot"`.
6. Start a prompt and confirm the waiting indicator is a circular spinner, not the old visual style.
