# UI Skins

This document explains how **skins** work in the webview UI and how to add a new
one. A *skin* is a self-contained visual variant of the chat UI that is selected
by the user in **Settings → Appearance → Theme** and is fully isolated from the
built-in `light` / `dark` themes.

The repository currently ships one custom skin in addition to the IDE-following
themes:

| Theme mode | Description                                              |
| ---------- | -------------------------------------------------------- |
| `system`   | Follows the IDE (light/dark), default                    |
| `light`    | Explicit light theme                                     |
| `dark`     | Explicit dark theme                                      |
| `codriver` | **CoDriver** — a calm, Primer-like dark skin (bundled)   |

> The patch scripts that originally bootstrapped the `codriver` skin have been
> removed — the skin is now part of the source tree. This folder only keeps this
> guide so future skins can follow the same pattern.

---

## How theming works

Theming is driven by a single attribute on the root element:

```html
<html data-theme="codriver">
```

- `webview/index.html` sets `data-theme` **before React loads** (reads
  `localStorage('theme')`, falls back to the IDE theme injected by Java). It must
  recognise every explicit skin id, otherwise there is a flash on load.
- `webview/src/types/uiThemeMode.ts` is the single source of truth for the
  `UiThemeMode` union (`'light' | 'dark' | 'system' | 'codriver'`) plus the
  type guards used across the settings code.
- `webview/src/hooks/useThemeInit.ts` re-applies the persisted explicit theme.
- `webview/src/components/settings/hooks/useSettingsThemeSync.ts` persists the
  choice and resolves `system` against the live IDE theme.
- `webview/src/components/settings/BasicConfigSection/AppearanceTab.tsx` renders
  the theme picker buttons.

CSS variables (defined in `webview/src/styles/less/variables.less` and consumed
by every component) are the main lever: a skin mostly **redefines those variables**
under its `data-theme` selector, then adds targeted component overrides where the
variables are not enough.

### The golden rule

> **Every skin rule must be scoped to its `data-theme` selector.**
> Never change the shared `light` / `dark` styling directly.

```less
/* good — scoped */
html[data-theme="codriver"] .input-container { ... }

/* bad — leaks into all themes */
.input-container { ... }
```

---

## The `codriver` skin: file map

The skin is split into a few focused files, all scoped to
`[data-theme="codriver"]` (or the higher-specificity
`html[data-theme="codriver"]`).

**LESS, imported from `webview/src/styles/app.less`:**

| File | Responsibility |
| --- | --- |
| `styles/less/codriver-skin.less` | Core palette: redefines all `--*` design tokens + base shell, scrollbars, generic form controls |
| `styles/less/codriver-laf-v3.less` | Look-and-feel pass: app shell, header, messages, composer, tool blocks, anchor rail |
| `styles/less/codriver-icon-pack.less` | Icon tone adapter for Codicons + the local `CoDriverIcon` pack |
| `styles/less/codriver-syntax.less` | Dark `.hljs-*` syntax-highlighting palette |
| `styles/less/codriver-misc.less` | Primer-like font stack, welcome screen, toasts, dialogs |

**Scoped blocks appended inside existing component LESS files** (each guarded by
`[data-theme="codriver"] { ... }`):
`components/message.less`, `components/loading.less`, `components/input.less`,
`components/header.less`, `components/buttons.less`,
`components/scroll-control.less`.

**Plain CSS, imported from `webview/src/components/ChatInputBox/styles.css`
(loaded last so it wins the cascade):**

| File | Responsibility |
| --- | --- |
| `ChatInputBox/styles/codriver-attachments.css` | Attachment strip chips |
| `ChatInputBox/styles/codriver-context-file-icons.css` | Active file/context chip icons |
| `ChatInputBox/styles/codriver-dropdowns.css` | Slash / @-mention / model / mode / provider popups (defines the `--dropdown-*` / `--button-*` vars the dark/light themes provide) |

**TypeScript:**

| File | Responsibility |
| --- | --- |
| `components/codriverIcons/` | Original MIT-licensed stroke-SVG icon pack (`CoDriverIcon`). Used by ContextBar, AttachmentList, WaitingIndicator, ContentBlockRenderer, ButtonArea |
| `utils/diffTheme.ts` | Adds a `codriver` resolved diff palette used when the CoDriver skin is active and the diff mode is `follow` |

---

## Adding a new skin

Use the same pattern. Example for a hypothetical `solarized` skin:

1. **Register the theme id** in `webview/src/types/uiThemeMode.ts`
   (add `'solarized'` to the `UiThemeMode` union and the two type guards).

2. **Recognise it pre-React** in `webview/index.html` — add `'solarized'` to the
   `savedTheme === ...` check so there is no flash before React mounts.

3. **Add the picker button** in
   `components/settings/BasicConfigSection/AppearanceTab.tsx` (clone the existing
   `codriver` button, give it its own icon and i18n labels).

4. **Create the skin stylesheet** `webview/src/styles/less/solarized-skin.less`
   and `@import` it from `webview/src/styles/app.less` after `variables.less`.
   Start by redefining the design tokens:

   ```less
   [data-theme="solarized"] {
       --bg-primary: #002b36;
       --text-primary: #839496;
       --accent-primary: #268bd2;
       /* …redefine the rest of the tokens from variables.less… */
   }
   ```

5. **Refine specific components** only where tokens are not enough, always scoped:

   ```less
   [data-theme="solarized"] .input-container { ... }
   ```

   If you need to win over the `ChatInputBox/styles/*.css` rules, add a
   `solarized-*.css` file and import it last from
   `components/ChatInputBox/styles.css`.

6. **Optional integrations**: if your skin needs custom syntax colors, mirror
   `codriver-syntax.less`; for a custom diff palette, extend `utils/diffTheme.ts`.

7. **Build & verify**:

   ```powershell
   cd webview
   npm run build
   cd ..
   .\gradlew.bat runIde
   ```

   Then switch the IDE between light/dark and confirm your skin stays active and
   the `light` / `dark` themes are unchanged.

---

## Conventions

- **Scope everything** to `[data-theme="<id>"]`. Prefer `html[data-theme="<id>"]`
  when you must beat a component-local rule of equal class-specificity.
- **Reuse design tokens** (`--bg-*`, `--text-*`, `--accent-*`, `--color-*`,
  `--dropdown-*`, `--diff-*`) instead of hard-coding colors in many places.
- **Match real class names** — check the component/LESS before writing selectors;
  guessed `[class*="…"]` selectors tend to match nothing.
- **No third-party brand assets or brand names.** The bundled icon pack
  (`components/codriverIcons`) is original artwork, MIT-licensed
  (`components/codriverIcons/LICENSE.md`). Do not add vendor brand assets or name
  skins after third-party products (e.g. GitHub Copilot, Claude); pick a neutral
  name instead.
- **Keep `light` / `dark` untouched.**
- Run `npm run build` (it runs `tsc` + Vite and copies the bundle into
  `src/main/resources/html/`) before committing.
