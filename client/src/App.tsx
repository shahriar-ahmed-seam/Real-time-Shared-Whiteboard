import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Board from "./pages/Board";
import { ErrorBoundary } from "./components/ErrorBoundary";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route
          path="/board/:id"
          element={
            <ErrorBoundary>
              <Board />
            </ErrorBoundary>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
