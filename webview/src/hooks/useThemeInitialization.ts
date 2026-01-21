import { useEffect, useState } from 'react';
import { debugLog, debugError, debugWarn } from '../utils/debugLogger';

interface UseThemeInitializationReturn {
  ideTheme: 'light' | 'dark' | null;
  setIdeTheme: React.Dispatch<React.SetStateAction<'light' | 'dark' | null>>;
}

/**
 * Hook for managing IDE theme initialization and synchronization
 * Extracts theme-related logic from App.tsx
 */
export function useThemeInitialization(): UseThemeInitializationReturn {
  // IDE theme state - prefer Java injected initial theme
  const [ideTheme, setIdeTheme] = useState<'light' | 'dark' | null>(() => {
    // Check if Java injected initial theme
    const injectedTheme = (window as any).__INITIAL_IDE_THEME__;
    if (injectedTheme === 'light' || injectedTheme === 'dark') {
      return injectedTheme;
    }
    return null;
  });

  // Initialize theme and font scale
  useEffect(() => {
    debugLog('[Frontend][Theme] Initializing theme system');

    // Register IDE theme receive callback
    window.onIdeThemeReceived = (jsonStr: string) => {
      try {
        const themeData = JSON.parse(jsonStr);
        const theme = themeData.isDark ? 'dark' : 'light';
        debugLog('[Frontend][Theme] IDE theme received:', {
          raw: themeData,
          resolved: theme,
          currentSetting: localStorage.getItem('theme'),
        });
        setIdeTheme(theme);
      } catch (e) {
        debugError('[Frontend][Theme] Failed to parse IDE theme response:', e, 'Raw:', jsonStr);
      }
    };

    // Listen for IDE theme changes (when user switches theme in IDE)
    window.onIdeThemeChanged = (jsonStr: string) => {
      try {
        const themeData = JSON.parse(jsonStr);
        const theme = themeData.isDark ? 'dark' : 'light';
        debugLog('[Frontend][Theme] IDE theme changed:', {
          raw: themeData,
          resolved: theme,
          currentSetting: localStorage.getItem('theme'),
        });
        setIdeTheme(theme);
      } catch (e) {
        debugError('[Frontend][Theme] Failed to parse IDE theme change:', e, 'Raw:', jsonStr);
      }
    };

    // Initialize font scale
    const savedLevel = localStorage.getItem('fontSizeLevel');
    const level = savedLevel ? parseInt(savedLevel, 10) : 3; // Default level 3 (100%)
    const fontSizeLevel = level >= 1 && level <= 6 ? level : 3;

    // Map level to scale ratio
    const fontSizeMap: Record<number, number> = {
      1: 0.8, // 80%
      2: 0.9, // 90%
      3: 1.0, // 100% (default)
      4: 1.1, // 110%
      5: 1.2, // 120%
      6: 1.4, // 140%
    };
    const scale = fontSizeMap[fontSizeLevel] || 1.0;
    document.documentElement.style.setProperty('--font-scale', scale.toString());

    // Apply user-selected theme (light/dark), Follow IDE case is handled after ideTheme updates
    const savedTheme = localStorage.getItem('theme');
    debugLog('[Frontend][Theme] Saved theme preference:', savedTheme);

    // Check for Java injected initial theme
    const injectedTheme = (window as any).__INITIAL_IDE_THEME__;
    debugLog('[Frontend][Theme] Injected IDE theme:', injectedTheme);

    // Note: data-theme is already set by index.html inline script, just log here
    if (savedTheme === 'light' || savedTheme === 'dark') {
      debugLog('[Frontend][Theme] User explicit theme:', savedTheme);
    } else if (injectedTheme === 'light' || injectedTheme === 'dark') {
      debugLog('[Frontend][Theme] Follow IDE mode with injected theme:', injectedTheme);
    } else {
      debugLog('[Frontend][Theme] Follow IDE mode detected, will wait for IDE theme');
    }

    // Request IDE theme (with retry mechanism) - still needed for dynamic theme changes
    let retryCount = 0;
    const MAX_RETRIES = 20; // Max 20 retries (2 seconds)

    const requestIdeTheme = () => {
      if (window.sendToJava) {
        debugLog('[Frontend][Theme] Requesting IDE theme from backend');
        window.sendToJava('get_ide_theme:');
      } else {
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          debugLog(`[Frontend][Theme] Bridge not ready, retrying (${retryCount}/${MAX_RETRIES})...`);
          setTimeout(requestIdeTheme, 100);
        } else {
          debugError('[Frontend][Theme] Failed to request IDE theme: bridge not available after', MAX_RETRIES, 'retries');
          // If Follow IDE mode and can't get IDE theme, use injected theme or dark as fallback
          if (savedTheme === null || savedTheme === 'system') {
            const fallback = injectedTheme || 'dark';
            debugWarn('[Frontend][Theme] Fallback to theme:', fallback);
            setIdeTheme(fallback as 'light' | 'dark');
          }
        }
      }
    };

    // Delay 100ms to start requesting, give bridge time to initialize
    setTimeout(requestIdeTheme, 100);
  }, []);

  // When IDE theme changes, re-apply theme (if user selected "Follow IDE")
  // This effect also handles initial load theme setting
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');

    debugLog('[Frontend][Theme] ideTheme effect triggered:', {
      ideTheme,
      savedTheme,
      currentDataTheme: document.documentElement.getAttribute('data-theme'),
    });

    // Only process after ideTheme is loaded
    if (ideTheme === null) {
      debugLog('[Frontend][Theme] IDE theme not loaded yet, waiting...');
      return;
    }

    // If user selected "Follow IDE" mode
    if (savedTheme === null || savedTheme === 'system') {
      debugLog('[Frontend][Theme] Applying IDE theme:', ideTheme);
      document.documentElement.setAttribute('data-theme', ideTheme);
    } else {
      debugLog('[Frontend][Theme] User has explicit theme preference:', savedTheme, '- not applying IDE theme');
    }
  }, [ideTheme]);

  return {
    ideTheme,
    setIdeTheme,
  };
}
