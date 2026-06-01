import {
  Palette,
  Eraser,
  Trash2,
  Minus,
  Plus,
  FileImage,
  Download,
} from "lucide-react";
import { Popover, Toolbar, ToolbarButton } from "../../../components/ui";
import {
  PALETTE,
  cycleWidth,
  setColor,
  setPaletteOpen,
  setTool,
  useColor,
  usePaletteOpen,
  useTool,
  useWidth,
} from "../../../stores/uiStore";

// ─── ToolDock (Tier A — floating chrome) ──────────────────────────────
// The drawing toolbar, floating over the canvas as an isolated layer. Reads and
// writes the UI store only; selecting a tool/color/width never touches the
// canvas hot path (the engine reads the resolved brush at stroke-start time).
//
// Layout adapts to the viewport: a left vertical rail on ≥640px, a wrapping
// bottom dock on mobile (handled by the parent's positioning + `orientation`).

export interface ToolDockProps {
  orientation: "horizontal" | "vertical";
  className?: string;
  onClear: () => void;
  onExportPng: () => void;
  onExportPdf: () => void;
}

function Separator({ vertical }: { vertical: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={vertical ? "mx-1 h-px w-8 bg-border" : "my-1 h-8 w-px bg-border"}
    />
  );
}

export function ToolDock({
  orientation,
  className,
  onClear,
  onExportPng,
  onExportPdf,
}: ToolDockProps) {
  const tool = useTool();
  const color = useColor();
  const width = useWidth();
  const paletteOpen = usePaletteOpen();

  const vertical = orientation === "vertical";

  return (
    <Toolbar aria-label="Drawing tools" orientation={orientation} className={className}>
      {/* Brush + color palette */}
      <Popover
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        side={vertical ? "bottom" : "top"}
        align={vertical ? "start" : "center"}
        aria-label="Brush colors"
        trigger={
          <ToolbarButton aria-label="Brush and color" active={tool === "pen"}>
            <Palette className="h-5 w-5" />
          </ToolbarButton>
        }
      >
        <div className="min-w-44">
          <div className="mb-3 px-1 text-xs font-semibold uppercase tracking-wider text-text-muted">
            Colors
          </div>
          <div className="grid grid-cols-4 gap-2.5">
            {PALETTE.map((c) => {
              const selected = color === c && tool === "pen";
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Color ${c}`}
                  aria-pressed={selected}
                  className={`h-11 w-11 cursor-pointer rounded-lg border-2 transition-transform duration-[var(--motion-fast)] hover:scale-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none ${
                    selected ? "scale-110 border-focus" : "border-transparent hover:border-border"
                  }`}
                  style={{ backgroundColor: c }}
                />
              );
            })}
          </div>
        </div>
      </Popover>

      {/* Eraser */}
      <ToolbarButton
        aria-label="Eraser"
        active={tool === "eraser"}
        onClick={() => setTool(tool === "eraser" ? "pen" : "eraser")}
      >
        <Eraser className="h-5 w-5" />
      </ToolbarButton>

      <Separator vertical={vertical} />

      {/* Line width */}
      <ToolbarButton aria-label="Thinner line" onClick={() => cycleWidth(-1)}>
        <Minus className="h-4 w-4" />
      </ToolbarButton>
      <div className="flex h-11 w-11 items-center justify-center" aria-hidden="true">
        <div
          className="rounded-full bg-text-strong"
          style={{ width: `${Math.max(4, width)}px`, height: `${Math.max(4, width)}px` }}
        />
      </div>
      <ToolbarButton aria-label="Thicker line" onClick={() => cycleWidth(1)}>
        <Plus className="h-4 w-4" />
      </ToolbarButton>

      <Separator vertical={vertical} />

      {/* Clear */}
      <ToolbarButton aria-label="Clear board" onClick={onClear} className="hover:text-danger">
        <Trash2 className="h-5 w-5" />
      </ToolbarButton>

      <Separator vertical={vertical} />

      {/* Export */}
      <ToolbarButton aria-label="Export as PNG" onClick={onExportPng}>
        <FileImage className="h-5 w-5" />
      </ToolbarButton>
      <ToolbarButton aria-label="Export as PDF" onClick={onExportPdf}>
        <Download className="h-5 w-5" />
      </ToolbarButton>
    </Toolbar>
  );
}
