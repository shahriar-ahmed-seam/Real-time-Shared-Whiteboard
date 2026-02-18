import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Board from "./pages/Board";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/board/:id" element={<Board />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
