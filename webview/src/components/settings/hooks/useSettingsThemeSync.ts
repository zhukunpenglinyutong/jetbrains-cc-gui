// hooks/useSettingsThemeSync.ts
import { useState, useEffect, useRef, useCallback } from 'react';
import { applyDiffTheme, getStoredDiffTheme, type DiffThemeMode } from '../../../utils/diffTheme';
import {
  applyChatBarThemeColor,
  CHAT_BAR_COLOR_STORAGE_KEY,
  isValidHexColor,
} from '../../../utils/chatBarTheme';
import { forceWebviewRepaint } from '../../../utils/forceWebviewRepaint';
import {
  FONT_SIZE_LEVEL_STORAGE_KEY,
  fontSizeLevelToScale,
  isValidFontSizeLevel,
  parseFontSizeLevel,
} from '../../../utils/fontScale';

// Extend window type for IDE theme injection
declare global {
  interface Window {
    __INITIAL_IDE_THEME__?: 'light' | 'dark';
  }
}

export interface UseSettingsThemeSyncReturn {
  themePreference: 'light' | 'dark' | 'system';
  setThemePreference: (theme: 'light' | 'dark' | 'system') => void;
  ideTheme: 'light' | 'dark' | null;
  setIdeTheme: (theme: 'light' | 'dark' | null) => void;
  fontSizeLevel: number;
  setFontSizeLevel: (level: number) => void;
  chatBgColor: string;
  setChatBgColor: (color: string) => void;
  userMsgColor: string;
  setUserMsgColor: (color: string) => void;
  chatBarColor: string;
  setChatBarColor: (color: string) => void;
  diffTheme: DiffThemeMode;
  setDiffTheme: (theme: DiffThemeMode) => void;
}

export function useSettingsThemeSync(): UseSettingsThemeSyncReturn {
  const [themePreference, setThemePreference] = useState<'light' | 'dark' | 'system'>(() => {
    // Read theme preference from localStorage
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') {
      return savedTheme;
    }
    return 'system'; // Default: follow IDE
  });

  // IDE theme state (prefer Java-injected initial theme, used to handle dynamic changes)
  const [ideTheme, setIdeTheme] = useState<'light' | 'dark' | null>(() => {
    // Check if Java has injected the initial theme
    const injectedTheme = window.__INITIAL_IDE_THEME__;
    if (injectedTheme === 'light' || injectedTheme === 'dark') {
      return injectedTheme;
    }
    return null;
  });

  // Font size level state (1-6); default and level->scale mapping live in utils/fontScale.ts
  const [fontSizeLevel, setFontSizeLevelState] = useState<number>(
    () => parseFontSizeLevel(localStorage.getItem(FONT_SIZE_LEVEL_STORAGE_KEY))
  );

  // SettingsView is conditionally mounted, so the font-size effect runs once on
  // mount with an unchanged scale; only a real level change needs the OSR nudge.
  const isFirstFontSizeSyncEffect = useRef(true);

  const setFontSizeLevel = useCallback((level: number) => {
    if (!isValidFontSizeLevel(level)) {
      return;
    }
    // Persist on the explicit change instead of in the effect: writing on
    // mount would make a stored default indistinguishable from a deliberate
    // pick and pin users to the default of the version they opened Settings in.
    localStorage.setItem(FONT_SIZE_LEVEL_STORAGE_KEY, level.toString());
    setFontSizeLevelState(level);
  }, []);

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

  // Shared chat header and status bar color configuration
  const [chatBarColor, setChatBarColor] = useState<string>(() => {
    const saved = localStorage.getItem(CHAT_BAR_COLOR_STORAGE_KEY);
    return saved && isValidHexColor(saved) ? saved : '';
  });

  // Diff theme configuration
  const [diffTheme, setDiffTheme] = useState<DiffThemeMode>(() => getStoredDiffTheme());

  // Theme switching handler (supports following IDE theme)
  useEffect(() => {
    const applyTheme = (preference: 'light' | 'dark' | 'system') => {
      if (preference === 'system') {
        // If following IDE, need to wait for IDE theme to load
        if (ideTheme === null) {
          return; // Wait for ideTheme to load
        }
        document.documentElement.setAttribute('data-theme', ideTheme);
      } else {
        // Explicit light/dark selection, apply immediately
        document.documentElement.setAttribute('data-theme', preference);
      }
    };

    applyTheme(themePreference);
    // Save to localStorage
    localStorage.setItem('theme', themePreference);
  }, [themePreference, ideTheme]);

  // Font size scaling handler
  useEffect(() => {
    // Apply to root element
    document.documentElement.style.setProperty('--font-scale', fontSizeLevelToScale(fontSizeLevel).toString());

    if (isFirstFontSizeSyncEffect.current) {
      isFirstFontSizeSyncEffect.current = false;
      return;
    }

    // A pure CSS variable change does not invalidate the OSR compositor surface
    // (Linux), leaving the rendered viewport stale until a real window resize.
    // Nudge it like every other --font-scale write path does.
    forceWebviewRepaint('font-scale-change');
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

  // Shared chat header and status bar color handler
  useEffect(() => {
    applyChatBarThemeColor(chatBarColor);
    if (isValidHexColor(chatBarColor)) {
      localStorage.setItem(CHAT_BAR_COLOR_STORAGE_KEY, chatBarColor);
    } else {
      localStorage.removeItem(CHAT_BAR_COLOR_STORAGE_KEY);
    }
  }, [chatBarColor]);

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
    chatBarColor,
    setChatBarColor,
    diffTheme,
    setDiffTheme,
  };
}
