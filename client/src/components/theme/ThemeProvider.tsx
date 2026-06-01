import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ThemeContext,
  type ResolvedTheme,
  type ThemePreference,
} from "./themeContext";

const STORAGE_KEY = "synapse-theme";

/** Read the persisted preference, defaulting to `"system"`. */
function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

/** The OS-level color scheme right now. */
function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Resolve a stored preference to the concrete theme to apply. */
function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === "system" ? systemTheme() : pref;
}

/**
 * Provides the adaptive light/dark theme. Defaults to the user's OS preference
 * and supports a manual override persisted to localStorage. Applies the chosen
 * theme by toggling the `.dark` class on <html>, which drives every token via
 * the `dark` Tailwind variant declared in index.css.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    readStoredPreference,
  );
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveTheme(readStoredPreference()),
  );

  // Apply the resolved theme to <html> whenever it changes.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
  }, [resolved]);

  // Recompute the resolved theme when the preference changes...
  useEffect(() => {
    setResolved(resolveTheme(preference));
  }, [preference]);

  // ...and live-track the OS scheme while the preference is "system".
  useEffect(() => {
    if (preference !== "system" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(systemTheme());
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore storage failures (private mode, quota) — theme still applies.
    }
  }, []);

  const toggle = useCallback(() => {
    // Toggle relative to what's currently showing, and store an explicit choice.
    setPreference(resolved === "dark" ? "light" : "dark");
  }, [resolved, setPreference]);

  const value = useMemo(
    () => ({ preference, resolved, setPreference, toggle }),
    [preference, resolved, setPreference, toggle],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}
