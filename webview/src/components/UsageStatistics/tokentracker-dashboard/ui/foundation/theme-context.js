import { createContext } from "react";

/**
 * @typedef {"light" | "dark" | "system"} Theme
 * @typedef {{ theme: Theme, setTheme: (theme: Theme) => void, toggleTheme: () => void, resolvedTheme: "light" | "dark" }} ThemeContextValue
 */

/** @type {React.Context<ThemeContextValue | null>} */
export const ThemeContext = createContext(null);
