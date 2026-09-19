import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getCachedNativeSystemDark,
  isNativeEmbed,
  requestNativeSystemAppearance,
  subscribeNativeSystemAppearance,
  syncNativeChromeAppearance,
} from "../../lib/native-bridge.js";
import { ThemeContext } from "./theme-context.js";

const THEME_STORAGE_KEY = "tokentracker-theme";

/**
 * @typedef {"light" | "dark" | "system"} Theme
 * @typedef {{ theme: Theme, setTheme: (theme: Theme) => void, toggleTheme: () => void, resolvedTheme: "light" | "dark" }} ThemeContextValue
 */

/**
 * Get initial theme from localStorage or default to "system"
 * @returns {Theme}
 */
function getInitialTheme() {
  if (typeof window === "undefined") return "system";
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // Ignore localStorage errors (e.g., private mode)
  }
  return "system";
}

/**
 * Get system preferred theme
 * @returns {"light" | "dark"}
 */
function getSystemTheme() {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
// 读取当前系统外观：原生嵌入时优先用模块级缓存（always-on listener 维护），
// 缓存为空再用 matchMedia 兜底（WKWebView 的 matchMedia 不完全可信，但
// 作为兜底总比锁死旧值好）。
function readSystemAppearance() {
  if (isNativeEmbed()) {
    const cached = getCachedNativeSystemDark();
    if (typeof cached === "boolean") return cached ? "dark" : "light";
  }
  return getSystemTheme();
}

/**
 * Vendored change: upstream toggled `.dark` on document.documentElement. The
 * dashboard is embedded in the host app, so the class is scoped to the
 * `.tt-dashboard` wrapper element instead (dark-mode variables and the
 * `dark:` variant are scoped to that subtree in tokentracker-dashboard.css).
 * No-op when the wrapper is not in the document yet.
 * @param {"light" | "dark"} resolvedTheme
 */
function applyThemeToDOM(resolvedTheme) {
  if (typeof document === "undefined") return null;
  const root = document.querySelector(".tt-dashboard");
  if (!root) return null;
  if (resolvedTheme === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
  return root;
}

/**
 * ThemeProvider - Manages theme state and syncs with DOM/localStorage
 * @param {{ children: React.ReactNode }} props
 */
export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(getInitialTheme);
  // resolvedTheme 由 theme 派生：非 system 直接等于 theme；system 时读取
  // 系统外观（原生缓存优先，matchMedia 兜底）。派生发生在渲染期，不再经过
  // layout effect → setState → effect 的链路。
  const [systemTheme, setSystemTheme] = useState(readSystemAppearance);
  const resolvedTheme = theme === "system" ? systemTheme : theme;

  // 进入 system 模式时立刻同步一次系统外观（渲染期调整），避免停留在旧值一帧。
  const [prevTheme, setPrevTheme] = useState(theme);
  if (prevTheme !== theme) {
    setPrevTheme(theme);
    if (theme === "system") {
      setSystemTheme(readSystemAppearance());
    }
  }

  const themeRef = useRef(theme);
  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  // Apply theme to DOM whenever resolvedTheme changes
  useEffect(() => {
    const root = applyThemeToDOM(resolvedTheme);
    // Vendored change: don't leave a stale `.dark` on the wrapper if the
    // dashboard unmounts while dark (the wrapper may outlive this provider).
    return () => {
      root?.classList.remove("dark");
    };
  }, [resolvedTheme]);

  // theme 切换为 system 时主动请求一次最新原生外观以刷新缓存（渲染期调整
  // 已经同步了当前值，这里只是触发原生侧推送，属于真正的副作用）。
  useEffect(() => {
    if (theme === "system" && isNativeEmbed()) {
      requestNativeSystemAppearance();
    }
  }, [theme]);

  // 始终订阅原生 system appearance（不依赖 theme），缓存随时更新；只有处于 system 模式时才反映到 React state
  useEffect(() => {
    if (!isNativeEmbed()) return;
    const unsubscribe = subscribeNativeSystemAppearance((isDark) => {
      if (themeRef.current === "system") {
        setSystemTheme(isDark ? "dark" : "light");
      }
    });
    return unsubscribe;
  }, []);

  // 浏览器内用 matchMedia 跟系统；WKWebView 内不可靠（且与原生推送冲突），改由 Swift 侧推送
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (theme !== "system") return;
    if (isNativeEmbed()) return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const handleChange = (e) => {
      const newResolved = e.matches ? "dark" : "light";
      setSystemTheme(newResolved);
    };

    // Modern API
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
    // Legacy API (older Safari)
    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, [theme]);

  // macOS WKWebView：theme===system 时不要用 getSystemTheme() 作为 forNative（易为假 light），resolvedTheme 由原生事件维护
  useEffect(() => {
    const forNative =
      theme === "system" && !isNativeEmbed() ? getSystemTheme() : resolvedTheme;
    syncNativeChromeAppearance(forNative, theme);
  }, [resolvedTheme, theme]);

  const setTheme = useCallback((newTheme) => {
    setThemeState(newTheme);
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, newTheme);
      } catch {
        // Ignore localStorage errors
      }
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  const contextValue = useMemo(
    () => ({
      theme,
      setTheme,
      toggleTheme,
      resolvedTheme,
    }),
    [theme, setTheme, toggleTheme, resolvedTheme]
  );

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
}
