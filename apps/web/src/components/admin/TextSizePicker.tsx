"use client";

import { useEffect, useState } from "react";
import { readTextSize, setTextSize, subscribeTextSize, TEXT_SIZES, type TextSize } from "../../lib/text-size";

/**
 * Text size: Normal / Large / Extra large, one tap each, saved on this tablet. Shown in the
 * Menu drawer and at the bottom of Home so every role can find it without going into Settings.
 */
export default function TextSizePicker({ compact = false }: { compact?: boolean }) {
  const [size, setSize] = useState<TextSize>("large");
  useEffect(() => {
    setSize(readTextSize());
    return subscribeTextSize(setSize);
  }, []);

  return (
    <div className={`text-size-picker${compact ? " is-compact" : ""}`} role="group" aria-label="Text size">
      {!compact && <div className="text-size-label"><i className="bi bi-fonts me-1" aria-hidden="true"></i>Text size</div>}
      <div className="text-size-options">
        {TEXT_SIZES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`text-size-option${size === s.id ? " active" : ""}`}
            aria-pressed={size === s.id}
            onClick={() => { setTextSize(s.id); setSize(s.id); }}
          >
            <span className={`text-size-sample size-${s.id}`} aria-hidden="true">A</span>
            <span>{s.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
