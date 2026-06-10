// hooks/useSettingsThemeSync.ts
import { useState, useEffect, useRef } from 'react';
import { applyDiffTheme, getStoredDiffTheme, type DiffThemeMode } from '../../../utils/diffTheme';
import { hexToRgb } from '../../../utils/colorUtils';

// Extend window type for IDE theme injection
declare global {
  interface Window {
    __INITIAL_IDE_THEME__?: 'light' | 'dark';
  }
}

const OPACITY_STORAGE_KEY = 'windowOpacity';
const OPACITY_CSS_PROP = '--window-opacity';
const OPACITY_DEFAULT = 1.0;
const OPACITY_DEBOUNCE_MS = 500;

function readStoredOpacity(): number {
  const raw = localStorage.getItem(OPACITY_STORAGE_KEY);
  if (!raw) return OPACITY_DEFAULT;
  const val = parseFloat(raw);
  if (!Number.isFinite(val)) return OPACITY_DEFAULT;
  if (val < 0 || val > 1) return OPACITY_DEFAULT;
  return val;
}

function applyOpacityCSS(value: number) {
  if (value < 1.0) {
    document.documentElement.style.setProperty(OPACITY_CSS_PROP, value.toString());
  } else {
    document.documentElement.style.removeProperty(OPACITY_CSS_PROP);
  }
}

function persistOpacity(value: number) {
  if (value < 1.0) {
    localStorage.setItem(OPACITY_STORAGE_KEY, value.toString());
  } else {
    localStorage.removeItem(OPACITY_STORAGE_KEY);
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
  diffTheme: DiffThemeMode;
  setDiffTheme: (theme: DiffThemeMode) => void;
  windowOpacity: number;
  setWindowOpacity: (opacity: number) => void;
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

  // Window opacity state — debounced localStorage writes, real-time CSS
  const [windowOpacity, setWindowOpacity] = useState<number>(readStoredOpacity);
  const opacityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      document.documentElement.style.setProperty('--bg-chat-rgb', hexToRgb(chatBgColor));
      localStorage.setItem('chatBgColor', chatBgColor);
    } else {
      document.documentElement.style.removeProperty('--bg-chat');
      document.documentElement.style.removeProperty('--bg-chat-rgb');
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

  // Window opacity handler — real-time CSS, debounced localStorage
  useEffect(() => {
    applyOpacityCSS(windowOpacity);

    if (opacityTimerRef.current) {
      clearTimeout(opacityTimerRef.current);
    }
    opacityTimerRef.current = setTimeout(() => {
      persistOpacity(windowOpacity);
      opacityTimerRef.current = null;
    }, OPACITY_DEBOUNCE_MS);
  }, [windowOpacity]);

  // Cleanup opacity timer on unmount
  useEffect(() => {
    return () => {
      if (opacityTimerRef.current) {
        clearTimeout(opacityTimerRef.current);
      }
    };
  }, []);

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
    windowOpacity,
    setWindowOpacity,
  };
}
