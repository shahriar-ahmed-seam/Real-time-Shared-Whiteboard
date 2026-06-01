import { AppProviders } from "./AppProviders";
import { AppRouter } from "./router";

// ─── App ──────────────────────────────────────────────────────────────
// Thin shell: wrap the router in the app-wide providers. No layout or state
// lives here.

export default function App() {
  return (
    <AppProviders>
      <AppRouter />
    </AppProviders>
  );
}
