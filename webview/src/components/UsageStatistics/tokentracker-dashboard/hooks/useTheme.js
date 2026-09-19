import { useContext } from "react";
import { ThemeContext } from "../ui/foundation/theme-context.js";

/**
 * @typedef {"light" | "dark" | "system"} Theme
 * @typedef {{ theme: Theme, setTheme: (theme: Theme) => void, toggleTheme: () => void, resolvedTheme: "light" | "dark" }} UseThemeReturn
 */

/**
 * Hook to access theme context
 * @returns {UseThemeReturn}
 * @throws {Error} If used outside of ThemeProvider
 */
export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
