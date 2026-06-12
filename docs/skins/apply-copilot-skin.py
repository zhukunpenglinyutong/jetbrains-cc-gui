#!/usr/bin/env python3
"""
Apply a GitHub Copilot inspired skin to Miguel0888/jetbrains-cc-gui.

Run from the repository root:

    python apply-copilot-skin.py

Then test:

    cd webview
    npm install
    npm run test
    npm run build

The script is intentionally idempotent and only performs focused text changes.
"""

from __future__ import annotations

from pathlib import Path
import re
import sys


ROOT = Path.cwd()
WEBVIEW = ROOT / "webview"
SRC = WEBVIEW / "src"


def read_text(path: Path) -> str:
    if not path.exists():
        raise FileNotFoundError(f"Required file is missing: {path}")
    return path.read_text(encoding="utf-8")


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")


def replace_once(content: str, old: str, new: str, path: Path) -> str:
    if old not in content:
        raise RuntimeError(f"Expected text was not found in {path}:\n{old}")
    return content.replace(old, new, 1)


def replace_all(content: str, old: str, new: str) -> str:
    return content.replace(old, new)


def insert_after_once(content: str, marker: str, insertion: str, path: Path) -> str:
    if insertion.strip() in content:
        return content
    if marker not in content:
        raise RuntimeError(f"Marker was not found in {path}:\n{marker}")
    return content.replace(marker, marker + insertion, 1)


def ensure_import(content: str, import_line: str, after_import: str, path: Path) -> str:
    if import_line in content:
        return content
    return insert_after_once(content, after_import, "\n" + import_line, path)


def create_theme_mode_type() -> None:
    write_text(SRC / "types" / "uiThemeMode.ts", """export type IdeThemeMode = 'light' | 'dark';

export type UiThemeMode = IdeThemeMode | 'system' | 'github-copilot';

export function isUiThemeMode(value: string | null): value is UiThemeMode {
  return value === 'light'
    || value === 'dark'
    || value === 'system'
    || value === 'github-copilot';
}

export function isExplicitUiThemeMode(value: string | null): value is Exclude<UiThemeMode, 'system'> {
  return value === 'light'
    || value === 'dark'
    || value === 'github-copilot';
}

export function resolveThemeAttribute(
  preference: UiThemeMode,
  ideTheme: IdeThemeMode | null,
): IdeThemeMode | 'github-copilot' | null {
  if (preference === 'system') {
    return ideTheme;
  }

  return preference;
}
""")


def create_theme_mode_test() -> None:
    write_text(SRC / "types" / "uiThemeMode.test.ts", """import { describe, expect, it } from 'vitest';
import {
  isExplicitUiThemeMode,
  isUiThemeMode,
  resolveThemeAttribute,
} from './uiThemeMode';

describe('ui theme mode', () => {
  it('accepts the Copilot inspired skin as a first-class theme mode', () => {
    expect(isUiThemeMode('github-copilot')).toBe(true);
    expect(isExplicitUiThemeMode('github-copilot')).toBe(true);
    expect(resolveThemeAttribute('github-copilot', 'light')).toBe('github-copilot');
  });

  it('keeps system mode bound to the IDE theme', () => {
    expect(resolveThemeAttribute('system', 'dark')).toBe('dark');
    expect(resolveThemeAttribute('system', null)).toBeNull();
  });

  it('rejects unknown localStorage values', () => {
    expect(isUiThemeMode('copilot')).toBe(false);
    expect(isExplicitUiThemeMode('system')).toBe(false);
  });
});
""")


def create_copilot_skin_less() -> None:
    write_text(SRC / "styles" / "less" / "copilot-skin.less", """/* GitHub Copilot inspired skin.
   Keep this scoped to data-theme=\"github-copilot\" so the existing dark/light themes remain unchanged. */

[data-theme=\"github-copilot\"] {
    /* Primer / GitHub Dark inspired base */
    --bg-primary: #0d1117;
    --bg-chat: #0d1117;
    --bg-secondary: #161b22;
    --bg-tertiary: #21262d;
    --bg-elevated: #161b22;
    --bg-hover: #21262d;
    --bg-active: #30363d;

    --text-primary: #c9d1d9;
    --text-secondary: #f0f6fc;
    --text-tertiary: #8b949e;
    --text-muted: #6e7681;
    --text-placeholder: #6e7681;
    --text-white: #ffffff;

    --border-primary: #30363d;
    --border-secondary: #30363d;
    --border-hover: #8b949e;

    --accent-primary: #8957e5;
    --accent-primary-hover: #a371f7;
    --accent-primary-active: #6e40c9;
    --accent-secondary: #58a6ff;

    --color-success: #3fb950;
    --color-warning: #d29922;
    --color-error: #f85149;
    --color-danger: #da3633;
    --color-info: #58a6ff;
    --color-link: #58a6ff;

    --color-code-bg: rgba(110, 118, 129, 0.24);
    --color-code-block-bg: #161b22;
    --color-code-block-border: #30363d;
    --color-code-inline-bg: rgba(110, 118, 129, 0.24);

    --color-thinking-border: #30363d;
    --color-thinking-text: #8b949e;

    --color-tool-bg: rgba(110, 118, 129, 0.12);
    --color-tool-bg-secondary: rgba(110, 118, 129, 0.08);
    --color-tool-icon: #58a6ff;
    --color-tool-name: #79c0ff;
    --color-tool-summary: #8b949e;
    --color-tool-file-link: #7ee787;
    --color-tool-class-link: #a371f7;
    --color-tool-param-text: #c9d1d9;
    --color-tool-param-key: #8b949e;
    --color-tool-param-value: #f0f6fc;

    --color-button-text: #ffffff;
    --color-button-accent-hover-bg: rgba(137, 87, 229, 0.18);
    --color-button-success-bg: rgba(63, 185, 80, 0.12);
    --color-button-success-border: rgba(63, 185, 80, 0.46);
    --color-button-success-hover-bg: rgba(63, 185, 80, 0.20);
    --color-button-danger-hover-bg: rgba(248, 81, 73, 0.15);

    --color-dialog-border: #30363d;
    --color-dialog-button-primary: #8957e5;
    --color-dialog-button-primary-hover: #a371f7;
    --color-dialog-button-primary-active: #6e40c9;
    --color-dialog-button-danger: #f85149;
    --color-dialog-button-danger-hover: #ff7b72;
    --color-dialog-button-danger-active: #da3633;

    --text-warning: #d29922;
    --color-warning-button: #d29922;
    --color-warning-button-hover: #bb8009;

    --color-message-user-bg: #8957e5;
    --color-message-user-text: #ffffff;
    --color-message-user-code-bg: rgba(255, 255, 255, 0.16);
    --color-message-user-code-border: rgba(255, 255, 255, 0.20);
    --color-message-error-border: #f85149;
    --color-message-role-user: #a371f7;
    --color-message-role-assistant: #3fb950;
    --color-message-blockquote: #30363d;
    --color-message-ai-indicator: #6e7681;
    --color-message-ai-indicator-hover: #8b949e;
    --color-message-divider: rgba(240, 246, 252, 0.06);

    --color-provider-card-bg: rgba(187, 128, 9, 0.10);
    --color-provider-card-border: rgba(210, 153, 34, 0.32);
    --color-provider-card-accent: #d29922;
    --color-provider-card-icon-bg: rgba(210, 153, 34, 0.14);
    --color-provider-card-action-bg: rgba(210, 153, 34, 0.12);
    --color-provider-card-action-border: rgba(210, 153, 34, 0.30);
    --color-provider-card-action-hover-bg: rgba(210, 153, 34, 0.20);
    --color-provider-card-action-hover-border: rgba(210, 153, 34, 0.45);
    --color-provider-card-action-active-bg: rgba(210, 153, 34, 0.24);

    --color-history-border: rgba(240, 246, 252, 0.08);
    --color-history-hover: rgba(240, 246, 252, 0.06);

    --color-switch-btn-bg: rgba(110, 118, 129, 0.14);
    --color-switch-btn-border: rgba(240, 246, 252, 0.10);
    --color-switch-btn-hover-bg: rgba(110, 118, 129, 0.22);

    --color-menu-bg-hover: #21262d;
    --color-menu-bg-active: #30363d;
    --color-menu-delete: #ff7b72;

    --color-scroll-control-bg: #161b22;
    --color-scroll-control-border: #30363d;
    --color-scroll-control-text: #c9d1d9;
    --color-scroll-control-hover-bg: #21262d;
    --color-scroll-control-hover-border: #8b949e;
    --color-scroll-control-active-bg: #30363d;
    --color-scroll-control-icon: #8b949e;

    --color-toast-info-border: #58a6ff;
    --color-toast-success-border: #3fb950;
    --color-toast-warning-border: #d29922;
    --color-toast-error-border: #f85149;

    --color-notice-info-bg: rgba(88, 166, 255, 0.12);
    --color-notice-info-border: rgba(88, 166, 255, 0.35);
    --color-notice-info-text: #58a6ff;
    --color-notice-warning-bg: rgba(210, 153, 34, 0.12);
    --color-notice-warning-border: rgba(210, 153, 34, 0.38);
    --color-notice-warning-text: #d29922;

    --color-settings-error: #f85149;
    --color-settings-link: #58a6ff;
    --color-settings-border: #30363d;

    --chart-gradient-start: #8957e5;
    --chart-gradient-end: #58a6ff;
    --color-chart-bar-1: #8957e5;
    --color-chart-bar-2: #58a6ff;
    --color-chart-bar-3: #3fb950;
    --color-chart-bar-4: #d29922;
    --color-chart-divider: #30363d;

    --color-todo-header: #f0f6fc;
    --color-todo-text: #c9d1d9;
    --color-todo-status-pending: #6e7681;
    --color-todo-status-progress: #58a6ff;
    --color-todo-status-completed: #3fb950;
    --color-todo-divider: #30363d;
    --color-todo-panel-progress: #58a6ff;

    --color-task-icon-bg: rgba(63, 185, 80, 0.14);
    --color-task-icon: #3fb950;
    --color-task-badge-text: #d29922;
    --color-task-badge-bg: rgba(210, 153, 34, 0.12);

    --scrollbar-track: #0d1117;
    --scrollbar-thumb: #30363d;
    --scrollbar-thumb-hover: #484f58;

    --shadow-sm: 0 1px 2px rgba(1, 4, 9, 0.32);
    --shadow-md: 0 8px 24px rgba(1, 4, 9, 0.34);
    --shadow-lg: 0 16px 32px rgba(1, 4, 9, 0.48);

    --copilot-radius-sm: 6px;
    --copilot-radius-md: 8px;
    --copilot-radius-lg: 12px;
    --copilot-focus-ring: 0 0 0 2px rgba(137, 87, 229, 0.40);
    --copilot-spinner-track: rgba(139, 148, 158, 0.26);
    --copilot-spinner-active: #8b949e;
}

/* Skin-level component polish. These rules intentionally use the existing class names
   so no component has to know about Primer/GitHub details. */

[data-theme=\"github-copilot\"] body,
[data-theme=\"github-copilot\"] #root,
[data-theme=\"github-copilot\"] #app {
    background: var(--bg-primary);
    color: var(--text-primary);
}

[data-theme=\"github-copilot\"] .messages-container {
    background:
        radial-gradient(circle at 50% 0%, rgba(137, 87, 229, 0.10), transparent 30rem),
        var(--bg-chat);
}

[data-theme=\"github-copilot\"] .message,
[data-theme=\"github-copilot\"] .message-content,
[data-theme=\"github-copilot\"] .tool-block,
[data-theme=\"github-copilot\"] .settings-page,
[data-theme=\"github-copilot\"] .dialog-content,
[data-theme=\"github-copilot\"] .context-menu {
    border-color: var(--border-primary);
}

[data-theme=\"github-copilot\"] .input-area {
    background:
        linear-gradient(180deg, rgba(13, 17, 23, 0), rgba(13, 17, 23, 0.94) 22%),
        var(--bg-primary);
}

[data-theme=\"github-copilot\"] textarea,
[data-theme=\"github-copilot\"] input,
[data-theme=\"github-copilot\"] select {
    background: var(--bg-secondary);
    border-color: var(--border-primary);
    color: var(--text-primary);
}

[data-theme=\"github-copilot\"] textarea:focus,
[data-theme=\"github-copilot\"] input:focus,
[data-theme=\"github-copilot\"] select:focus {
    border-color: var(--accent-primary);
    box-shadow: var(--copilot-focus-ring);
    outline: none;
}

[data-theme=\"github-copilot\"] button {
    border-radius: var(--copilot-radius-sm);
}

[data-theme=\"github-copilot\"] button:hover {
    background-color: var(--bg-hover);
}

[data-theme=\"github-copilot\"] pre,
[data-theme=\"github-copilot\"] code {
    border-radius: var(--copilot-radius-sm);
}

[data-theme=\"github-copilot\"] .waiting-indicator {
    align-self: flex-start;
    margin: 10px 0 12px 8px;
    padding: 8px 12px;
    gap: 10px;
    color: var(--text-tertiary);
    background: rgba(22, 27, 34, 0.72);
    border: 1px solid var(--border-primary);
    border-radius: 999px;
    box-shadow: var(--shadow-sm);
}

[data-theme=\"github-copilot\"] .waiting-spinner::before {
    border: 2px solid var(--copilot-spinner-track);
    border-top-color: var(--copilot-spinner-active);
    animation: waiting-spin 0.8s linear infinite;
}

[data-theme=\"github-copilot\"] .waiting-spinner::after {
    display: none;
}

[data-theme=\"github-copilot\"] .waiting-text {
    color: var(--text-tertiary);
    letter-spacing: 0;
}

[data-theme=\"github-copilot\"] .waiting-dots {
    min-width: 1.4em;
}

[data-theme=\"github-copilot\"] .waiting-seconds {
    color: var(--text-muted);
}
""")


def update_app_less() -> None:
    path = SRC / "styles" / "app.less"
    content = read_text(path)
    content = insert_after_once(
        content,
        '@import "less/variables.less";',
        '\n@import "less/copilot-skin.less";',
        path,
    )
    write_text(path, content)


def update_theme_init() -> None:
    path = SRC / "hooks" / "useThemeInit.ts"
    content = read_text(path)

    content = ensure_import(
        content,
        "import { isExplicitUiThemeMode } from '../types/uiThemeMode';",
        "import { useEffect, useState } from 'react';",
        path,
    )

    content = replace_once(
        content,
        "    // Apply the user's explicit theme choice (light/dark) first\n    const savedTheme = localStorage.getItem('theme');\n",
        "    // Apply the user's explicit theme choice first. System remains bound to the IDE theme.\n    const savedTheme = localStorage.getItem('theme');\n    if (isExplicitUiThemeMode(savedTheme)) {\n      document.documentElement.setAttribute('data-theme', savedTheme);\n    }\n",
        path,
    )

    write_text(path, content)


def update_settings_theme_sync() -> None:
    path = SRC / "components" / "settings" / "hooks" / "useSettingsThemeSync.ts"
    write_text(path, """// hooks/useSettingsThemeSync.ts
import { useState, useEffect } from 'react';
import { applyDiffTheme, getStoredDiffTheme, type DiffThemeMode } from '../../../utils/diffTheme';
import {
  isUiThemeMode,
  resolveThemeAttribute,
  type IdeThemeMode,
  type UiThemeMode,
} from '../../../types/uiThemeMode';

// Extend window type for IDE theme injection
declare global {
  interface Window {
    __INITIAL_IDE_THEME__?: IdeThemeMode;
  }
}

export interface UseSettingsThemeSyncReturn {
  themePreference: UiThemeMode;
  setThemePreference: (theme: UiThemeMode) => void;
  ideTheme: IdeThemeMode | null;
  setIdeTheme: (theme: IdeThemeMode | null) => void;
  fontSizeLevel: number;
  setFontSizeLevel: (level: number) => void;
  chatBgColor: string;
  setChatBgColor: (color: string) => void;
  userMsgColor: string;
  setUserMsgColor: (color: string) => void;
  diffTheme: DiffThemeMode;
  setDiffTheme: (theme: DiffThemeMode) => void;
}

export function useSettingsThemeSync(): UseSettingsThemeSyncReturn {
  const [themePreference, setThemePreference] = useState<UiThemeMode>(() => {
    // Read theme preference from localStorage
    const savedTheme = localStorage.getItem('theme');
    if (isUiThemeMode(savedTheme)) {
      return savedTheme;
    }
    return 'system'; // Default: follow IDE
  });

  // IDE theme state (prefer Java-injected initial theme, used to handle dynamic changes)
  const [ideTheme, setIdeTheme] = useState<IdeThemeMode | null>(() => {
    // Check if Java has injected the initial theme
    const injectedTheme = window.__INITIAL_IDE_THEME__;
    if (injectedTheme === 'light' || injectedTheme === 'dark') {
      return injectedTheme;
    }
    return null;
  });

  // Font size level state (1-6, default is 2, i.e. 90%)
  const [fontSizeLevel, setFontSizeLevel] = useState<number>(() => {
    const savedLevel = localStorage.getItem('fontSizeLevel');
    const level = savedLevel ? parseInt(savedLevel, 10) : 2;
    return level >= 1 && level <= 6 ? level : 2;
  });

  // Chat background color configuration
  const [chatBgColor, setChatBgColor] = useState<string>(() => {
    const saved = localStorage.getItem('chatBgColor');
    if (saved && /^#[0-9a-fA-F]{6}$/.test(saved)) {
      return saved;
    }
    return '';
  });

  // User message bubble color configuration
  const [userMsgColor, setUserMsgColor] = useState<string>(() => {
    const saved = localStorage.getItem('userMsgColor');
    if (saved && /^#[0-9a-fA-F]{6}$/.test(saved)) {
      return saved;
    }
    return '';
  });

  // Diff theme configuration
  const [diffTheme, setDiffTheme] = useState<DiffThemeMode>(() => getStoredDiffTheme());

  // Theme switching handler (supports following IDE theme)
  useEffect(() => {
    const resolvedTheme = resolveThemeAttribute(themePreference, ideTheme);
    if (resolvedTheme !== null) {
      document.documentElement.setAttribute('data-theme', resolvedTheme);
    }

    // Save to localStorage
    localStorage.setItem('theme', themePreference);
  }, [themePreference, ideTheme]);

  // Font size scaling handler
  useEffect(() => {
    // Map level to scale ratio
    const fontSizeMap: Record<number, number> = {
      1: 0.8,   // 80%
      2: 0.9,   // 90% (default)
      3: 1.0,   // 100%
      4: 1.1,   // 110%
      5: 1.2,   // 120%
      6: 1.4,   // 140%
    };
    const scale = fontSizeMap[fontSizeLevel] || 1.0;

    // Apply to root element
    document.documentElement.style.setProperty('--font-scale', scale.toString());

    // Save to localStorage
    localStorage.setItem('fontSizeLevel', fontSizeLevel.toString());
  }, [fontSizeLevel]);

  // Chat background color handler
  useEffect(() => {
    if (chatBgColor) {
      document.documentElement.style.setProperty('--bg-chat', chatBgColor);
      localStorage.setItem('chatBgColor', chatBgColor);
    } else {
      document.documentElement.style.removeProperty('--bg-chat');
      localStorage.removeItem('chatBgColor');
    }
  }, [chatBgColor]);

  // User message bubble color handler
  useEffect(() => {
    if (userMsgColor) {
      document.documentElement.style.setProperty('--color-message-user-bg', userMsgColor);
      localStorage.setItem('userMsgColor', userMsgColor);
    } else {
      document.documentElement.style.removeProperty('--color-message-user-bg');
      localStorage.removeItem('userMsgColor');
    }
  }, [userMsgColor]);

  // Diff theme handler
  useEffect(() => {
    applyDiffTheme(diffTheme, ideTheme);
  }, [diffTheme, ideTheme, themePreference]);

  return {
    themePreference,
    setThemePreference,
    ideTheme,
    setIdeTheme,
    fontSizeLevel,
    setFontSizeLevel,
    chatBgColor,
    setChatBgColor,
    userMsgColor,
    setUserMsgColor,
    diffTheme,
    setDiffTheme,
  };
}
""")


def update_basic_config_section() -> None:
    path = SRC / "components" / "settings" / "BasicConfigSection" / "index.tsx"
    content = read_text(path)
    content = ensure_import(
        content,
        "import type { UiThemeMode } from '../../../types/uiThemeMode';",
        "import type { UiFontConfig } from '../hooks/useSettingsBasicActions';",
        path,
    )
    content = replace_all(content, "theme: 'light' | 'dark' | 'system';", "theme: UiThemeMode;")
    content = replace_all(content, "onThemeChange: (theme: 'light' | 'dark' | 'system') => void;", "onThemeChange: (theme: UiThemeMode) => void;")
    write_text(path, content)


def update_appearance_tab() -> None:
    path = SRC / "components" / "settings" / "BasicConfigSection" / "AppearanceTab.tsx"
    content = read_text(path)
    content = ensure_import(
        content,
        "import type { UiThemeMode } from '../../../types/uiThemeMode';",
        "import type { UiFontConfig } from '../hooks/useSettingsBasicActions';",
        path,
    )

    content = replace_all(content, "theme: 'light' | 'dark' | 'system';", "theme: UiThemeMode;")
    content = replace_all(content, "onThemeChange: (theme: 'light' | 'dark' | 'system') => void;", "onThemeChange: (theme: UiThemeMode) => void;")

    copilot_icon = """
const CopilotIcon = () => (
  <svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\" aria-hidden=\"true\">
    <path d=\"M12 3.75C7.44 3.75 3.75 7.44 3.75 12S7.44 20.25 12 20.25 20.25 16.56 20.25 12 16.56 3.75 12 3.75Z\" stroke=\"currentColor\" strokeWidth=\"1.8\"/>
    <path d=\"M8.2 12.1c.7-1.35 1.95-2.15 3.8-2.15s3.1.8 3.8 2.15\" stroke=\"currentColor\" strokeWidth=\"1.8\" strokeLinecap=\"round\"/>
    <path d=\"M7.7 13.9c.95 1.25 2.38 1.9 4.3 1.9s3.35-.65 4.3-1.9\" stroke=\"currentColor\" strokeWidth=\"1.8\" strokeLinecap=\"round\"/>
  </svg>
);
"""
    if "const CopilotIcon = () => (" not in content:
        system_icon_pattern = re.compile(
            r"(const SystemIcon = \(\) => \(\n  <svg[\s\S]*?\n\);\n)",
            re.MULTILINE,
        )
        content, count = system_icon_pattern.subn(r"\1" + copilot_icon, content, count=1)
        if count != 1:
            raise RuntimeError(f"Could not insert CopilotIcon in {path}")

    # Make the resolved color preset logic treat the Copilot skin as a dark skin.
    content = replace_all(
        content,
        "return (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'dark';",
        "return (document.documentElement.getAttribute('data-theme') as 'light' | 'dark' | 'github-copilot') || 'dark';",
    )
    content = replace_all(
        content,
        "const defaultBgColor = resolvedTheme === 'light' ? DEFAULT_LIGHT_BG : DEFAULT_DARK_BG;",
        "const defaultBgColor = resolvedTheme === 'light' ? DEFAULT_LIGHT_BG : DEFAULT_DARK_BG;",
    )

    # Clone the existing System theme button to keep the component's CSS module names intact.
    if "onThemeChange('github-copilot')" not in content:
        button_pattern = re.compile(
            r"(?P<button>\n\s*<button[\s\S]*?onClick=\{\(\) => onThemeChange\('system'\)\}[\s\S]*?</button>)",
            re.MULTILINE,
        )
        match = button_pattern.search(content)
        if not match:
            raise RuntimeError(f"Could not find the System theme button in {path}")

        system_button = match.group("button")
        copilot_button = system_button
        copilot_button = copilot_button.replace("onThemeChange('system')", "onThemeChange('github-copilot')")
        copilot_button = copilot_button.replace("theme === 'system'", "theme === 'github-copilot'")
        copilot_button = copilot_button.replace("<SystemIcon />", "<CopilotIcon />")
        copilot_button = copilot_button.replace(
            "t('settings.basic.theme.system')",
            "t('settings.basic.theme.githubCopilot', 'GitHub Copilot Inspired')",
        )
        copilot_button = copilot_button.replace(
            "t('settings.basic.theme.systemDesc')",
            "t('settings.basic.theme.githubCopilotDesc', 'GitHub-style dark chat skin with Copilot accents')",
        )
        copilot_button = copilot_button.replace(
            "t('settings.appearance.theme.system')",
            "t('settings.appearance.theme.githubCopilot', 'GitHub Copilot Inspired')",
        )
        copilot_button = copilot_button.replace(
            "t('settings.appearance.theme.systemDesc')",
            "t('settings.appearance.theme.githubCopilotDesc', 'GitHub-style dark chat skin with Copilot accents')",
        )

        content = content[:match.end("button")] + copilot_button + content[match.end("button"):]

    write_text(path, content)


def update_waiting_indicator() -> None:
    path = SRC / "components" / "WaitingIndicator.tsx"
    content = read_text(path)
    content = replace_once(
        content,
        '    <div className="waiting-indicator">\n',
        '    <div className="waiting-indicator" role="status" aria-live="polite">\n',
        path,
    )
    write_text(path, content)


def main() -> int:
    if not (WEBVIEW / "package.json").exists():
        print("This script must be run from the jetbrains-cc-gui repository root.", file=sys.stderr)
        return 1

    create_theme_mode_type()
    create_theme_mode_test()
    create_copilot_skin_less()
    update_app_less()
    update_theme_init()
    update_settings_theme_sync()
    update_basic_config_section()
    update_appearance_tab()
    update_waiting_indicator()

    print("Applied GitHub Copilot inspired skin patch.")
    print("Next:")
    print("  cd webview")
    print("  npm run test")
    print("  npm run build")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
