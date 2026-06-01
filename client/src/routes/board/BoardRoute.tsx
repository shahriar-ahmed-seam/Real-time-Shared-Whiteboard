import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { MousePointer2 } from "lucide-react";
import { useCanvasEngine } from "../../features/canvas/hooks/useCanvasEngine";
import { useCollaboration } from "../../features/collaboration/hooks/useCollaboration";
import { CanvasStage } from "../../features/canvas/components/CanvasStage";
import { exportPng, exportPdf } from "../../features/canvas/engine/exporters";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import {
  getSavedUsername,
  saveBoardVisit,
  saveUsername,
} from "../../lib/boardStorage";
import {
  CANVAS_BG,
  resolveBrush,
  uiStore,
  useColor,
  useTool,
  useWidth,
} from "../../stores/uiStore";
import {
  commitJoin,
  initSession,
  useConnected,
  useJoined,
} from "../../stores/sessionStore";
import { BoardTopBar } from "./components/BoardTopBar";
import { ToolDock } from "./components/ToolDock";
import { JoinModal } from "./components/JoinModal";
import { ReconnectingIndicator } from "./components/ReconnectingIndicator";

// ─── BoardRoute ───────────────────────────────────────────────────────
// Composition root for the board. Renders the full-bleed CanvasStage as the
// BASE layer, then mounts the floating UI layers (top bar, tool dock, status)
// as INDEPENDENT siblings over it. The canvas is never a child of, and never
// re-renders because of, any chrome. All wiring between the socket transport and
// the imperative engine happens in useCollaboration; this component only drives
// discrete intent (join, clear, export) and reads Tier-A store slices.

export default function BoardRoute() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const roomId = id || "default";

  const urlUser = searchParams.get("user") || "";
  const savedUser = getSavedUsername();
  const [username, setUsername] = useState(urlUser || savedUser);

  const joined = useJoined();
  const connected = useConnected();
  const isMobile = useMediaQuery("(max-width: 639px)");

  const { engine, canvasRef, cursorLayerRef } = useCanvasEngine();

  // Seed the session store once, auto-joining when the URL carries a name.
  useEffect(() => {
    const startJoined = Boolean(urlUser);
    if (startJoined) saveUsername(urlUser);
    initSession(roomId, urlUser || savedUser, startJoined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, urlUser]);

  useEffect(() => {
    if (joined) saveBoardVisit(roomId);
  }, [roomId, joined]);

  // Wire transport ↔ engine ↔ stores + local input. Returns the live client.
  const client = useCollaboration({ engine, roomId, username, joined });

  const handleJoin = useCallback((name: string) => {
    setUsername(name);
    saveUsername(name);
    commitJoin(name);
  }, []);

  const handleClear = useCallback(() => {
    engine.clearBoard();
    client.clear(roomId);
  }, [engine, client, roomId]);

  const handleExportPng = useCallback(
    () => exportPng(engine.getCanvas(), roomId),
    [engine, roomId],
  );
  const handleExportPdf = useCallback(
    () => exportPdf(engine.getCanvas(), roomId),
    [engine, roomId],
  );

  return (
    <div className="relative h-screen w-screen select-none overflow-hidden bg-bg">
      {/* BASE LAYER — the workspace, unencumbered. */}
      <CanvasStage engine={engine} canvasRef={canvasRef} cursorLayerRef={cursorLayerRef} />

      {/* Name gate before joining. */}
      {!joined && (
        <JoinModal initial={username} onSubmit={handleJoin} onCancel={() => navigate("/")} />
      )}

      {/* FLOATING LAYERS — independent siblings over the canvas. */}
      {joined && (
        <>
          {!connected && <ReconnectingIndicator />}

          <BoardTopBar engine={engine} roomId={roomId} username={username} />

          {/* Mobile: bottom-anchored column (dock + status stack, no overlap).
              Desktop: display:contents so each child keeps its own float. */}
          <div
            className={
              isMobile
                ? "absolute inset-x-3 bottom-3 z-50 flex flex-col-reverse items-center gap-2"
                : "contents"
            }
          >
            <ToolDock
              orientation={isMobile ? "horizontal" : "vertical"}
              className={
                isMobile
                  ? "max-w-full flex-wrap justify-center shadow-[var(--shadow-md)] backdrop-blur-xl"
                  : "absolute left-4 top-1/2 z-50 -translate-y-1/2 shadow-[var(--shadow-md)] backdrop-blur-xl"
              }
              onClear={handleClear}
              onExportPng={handleExportPng}
              onExportPdf={handleExportPdf}
            />

            <BrushStatus isMobile={isMobile} />
          </div>
        </>
      )}
    </div>
  );
}

// ─── BrushStatus (Tier A — floating chrome) ───────────────────────────
// Compact readout of the active brush. Reads the UI store; re-renders only on
// tool/color/width changes.
function BrushStatus({ isMobile }: { isMobile: boolean }) {
  const tool = useTool();
  const color = useColor();
  const width = useWidth();
  const brush = resolveBrush(uiStore.get());
  const swatch = tool === "eraser" ? CANVAS_BG : color;

  return (
    <div
      className={
        isMobile
          ? "flex max-w-full items-center gap-3 rounded-full border border-border bg-surface-1/95 px-4 py-2 shadow-[var(--shadow-md)] backdrop-blur-xl"
          : "absolute bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-full border border-border bg-surface-1/95 px-5 py-2.5 shadow-[var(--shadow-md)] backdrop-blur-xl"
      }
    >
      <div className="flex items-center gap-2.5">
        <MousePointer2 className="h-4 w-4 shrink-0" aria-hidden="true" style={{ color: brush.color }} />
        <span
          className="h-4 w-4 shrink-0 rounded-full border border-border ring-1 ring-border"
          style={{ backgroundColor: swatch }}
        />
      </div>
      <span className="truncate font-mono text-sm font-medium text-text">
        {tool === "eraser" ? "Eraser" : color} · {width}px
      </span>
    </div>
  );
}
