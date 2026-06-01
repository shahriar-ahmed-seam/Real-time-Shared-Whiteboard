import { jsPDF } from "jspdf";

// ─── Canvas exporters ─────────────────────────────────────────────────
// Rasterize the live canvas to a downloadable PNG or PDF. Pure side-effect
// helpers operating on the engine's backing <canvas>; no React, no engine
// state mutation.

export function exportPng(canvas: HTMLCanvasElement | null, roomId: string): void {
  if (!canvas) return;
  const link = document.createElement("a");
  link.download = `synapse-${roomId}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

export function exportPdf(canvas: HTMLCanvasElement | null, roomId: string): void {
  if (!canvas) return;
  const imgData = canvas.toDataURL("image/png");
  const pdf = new jsPDF({
    orientation: canvas.width > canvas.height ? "landscape" : "portrait",
    unit: "px",
    format: [canvas.width, canvas.height],
  });
  pdf.addImage(imgData, "PNG", 0, 0, canvas.width, canvas.height);
  pdf.save(`synapse-${roomId}.pdf`);
}
