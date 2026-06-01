import type { ReactNode } from "react";
import { ThemeProvider } from "../components/theme/ThemeProvider";
import { ToastProvider } from "../components/ui";

// ─── AppProviders ─────────────────────────────────────────────────────
// Single composition point for app-wide context: adaptive theme + the toast
// live region. Kept separate from the router so providers and routing evolve
// independently. The Tier-A stores are module singletons (not context), so they
// need no provider here.

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  );
}
