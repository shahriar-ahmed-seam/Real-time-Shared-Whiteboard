import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ErrorBoundary } from "../components/ErrorBoundary";
import HomeRoute from "../routes/home/HomeRoute";
import BoardRoute from "../routes/board/BoardRoute";

// ─── App router ───────────────────────────────────────────────────────
// Two surfaces: the home entry and the board workspace. The board is wrapped in
// an ErrorBoundary so a render fault there shows a recoverable panel instead of
// a blank screen, without taking down the rest of the app.

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomeRoute />} />
        <Route
          path="/board/:id"
          element={
            <ErrorBoundary>
              <BoardRoute />
            </ErrorBoundary>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
