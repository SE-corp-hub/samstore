"use client";

// Shared finger-drawn signature pad (300×120 white canvas, black 3px round-cap strokes).
// Pointer events with touch fallback; exports canvas.toDataURL("image/png") via onSignature.
// Used by POS utang sales, Pre-Order finalize, and Credit Ledger payment collection.

import { useRef } from "react";

export default function SignaturePad({ onSignature }: { onSignature: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const hasInkRef = useRef(false);
  const preppedRef = useRef(false);
  const supportsPointer = typeof window !== "undefined" && "PointerEvent" in window;

  const coords = (x: number, y: number) => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return { x: (x - r.left) * (c.width / r.width), y: (y - r.top) * (c.height / r.height) };
  };

  const setup = () => {
    const c = canvasRef.current;
    if (!c) return null;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    if (!preppedRef.current) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      preppedRef.current = true;
    }
    return ctx;
  };

  const beginStroke = (x: number, y: number) => {
    const ctx = setup();
    if (!ctx) return;
    const p = coords(x, y);
    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    drawingRef.current = true;
    hasInkRef.current = true;
  };

  const moveStroke = (x: number, y: number) => {
    if (!drawingRef.current) return;
    const ctx = setup();
    if (!ctx) return;
    const p = coords(x, y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };

  const endStroke = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const c = canvasRef.current;
    const dataUrl = c && hasInkRef.current ? c.toDataURL("image/png") : null;
    onSignature(dataUrl);
  };

  const clearPad = () => {
    const c = canvasRef.current;
    const ctx = c && c.getContext("2d");
    if (c && ctx) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
    }
    preppedRef.current = false;
    hasInkRef.current = false;
    onSignature(null);
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={300}
        height={120}
        className="border rounded d-block w-100"
        style={{ touchAction: "none", userSelect: "none", backgroundColor: "#fff" }}
        onPointerDown={(e) => { if (supportsPointer) { e.preventDefault(); beginStroke(e.clientX, e.clientY); } }}
        onPointerMove={(e) => { if (supportsPointer) moveStroke(e.clientX, e.clientY); }}
        onPointerUp={() => { if (supportsPointer) endStroke(); }}
        onPointerCancel={() => { if (supportsPointer) endStroke(); }}
        onTouchStart={(e) => { if (supportsPointer) return; const t = e.touches[0]; if (t) beginStroke(t.clientX, t.clientY); }}
        onTouchMove={(e) => { if (supportsPointer) return; if (e.cancelable) e.preventDefault(); const t = e.touches[0]; if (t) moveStroke(t.clientX, t.clientY); }}
        onTouchEnd={() => { if (supportsPointer) return; endStroke(); }}
      />
      <button type="button" className="btn btn-sm btn-outline-secondary mt-1" onClick={clearPad}>
        <i className="bi bi-eraser me-1"></i>Clear
      </button>
    </div>
  );
}