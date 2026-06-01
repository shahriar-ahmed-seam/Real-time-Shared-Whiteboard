import { createContext, useContext } from "react";

/** The three theme choices a user can persist. `"system"` follows the OS. */
export type ThemePreference = "light" | "dark" | "system";

/** The concrete theme actually applied to the document at a given moment. */
export type ResolvedTheme = "light" | "dark";

export interface ThemeContextValue {
  /** The user's stored preference (light / dark / system). */
  preference: ThemePreference;
  /** The theme currently applied (system preference resolved to a concrete value). */
  resolved: ResolvedTheme;
  /** Persist a new preference. */
  setPreference: (next: ThemePreference) => void;
  /** Convenience: flip between light and dark (sets an explicit preference). */
  toggle: () => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Access the theme controls. Must be used within a `<ThemeProvider>`. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a <ThemeProvider>");
  }
  return ctx;
}
