"use client";

// Customer barcode — Code-128 encoding of the store customer's unique id.
// Renders via jsbarcode into an SVG (no raster, prints clean). If jsbarcode is
// unavailable in the environment it falls back to showing the code as text.

import { useEffect, useRef } from "react";
import JsBarcode from "jsbarcode";

export default function CustomerBarcode({
  value,
  displayLabel,
  height,
}: {
  value: string;
  displayLabel?: string;
  height?: number;
}) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const rendered = useRef(false);

  useEffect(() => {
    if (!value || rendered.current) return;
    rendered.current = true;
    try {
      // jsbarcode renders an SVG inside the given element when it's an <svg> parent? It
      // renders a <svg> inside the container for the 'svg' renderer family. Simplest robust
      // path: create an <svg> child and let jsbarcode draw into it.
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", String(height ?? 70));
      svg.setAttribute("viewBox", "0 0 400 70");
      if (holderRef.current) holderRef.current.appendChild(svg);
      svgRef.current = svg;
      JsBarcode(svg, value, {
        format: "CODE128",
        height: height ?? 32,
        width: 2,
        displayValue: true,
        fontSize: 14,
        margin: 4,
        lineColor: "#000000",
        background: "#ffffff",
      } as JsBarcode.BaseOptions);
    } catch {
      // fallback: text only
      if (holderRef.current) {
        holderRef.current.innerHTML = "";
        const code = document.createElement("code");
        code.textContent = value;
        holderRef.current.appendChild(code);
      }
    }
  }, [value, height]);

  return (
    <div
      ref={holderRef}
      className="text-center py-2"
      style={{ background: "#fff", borderRadius: 8, border: "1px solid #dee2e6" }}
    >
      {!value && <span className="text-muted small">No id</span>}
      {displayLabel && (
        <div className="small text-muted mt-1 fw-semibold">{displayLabel}</div>
      )}
    </div>
  );
}