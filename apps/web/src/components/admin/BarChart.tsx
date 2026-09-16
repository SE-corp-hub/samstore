"use client";

// Tiny inline bar chart (no chart library — pure divs, Bootstrap-themed).

interface BarChartProps {
  data: { label: string; value: number; valueLabel?: string }[];
  color?: string;
  max?: number;
}

export default function BarChart({ data, color = "var(--sam-primary)", max }: BarChartProps) {
  const maxValue = max ?? Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="d-flex align-items-end gap-2" style={{ height: 180 }}>
      {data.map((d, i) => {
        const h = maxValue > 0 ? Math.max(2, Math.round((d.value / maxValue) * 160)) : 2;
        return (
          <div key={i} className="d-flex flex-column justify-content-end flex-grow-1 text-center" title={`${d.label}: ${d.valueLabel ?? d.value}`}>
            <div style={{ height: h, background: color, borderRadius: "4px 4px 0 0", minWidth: 12 }} />
            <div className="small text-muted mt-1" style={{ fontSize: 10 }}>{d.label}</div>
          </div>
        );
      })}
    </div>
  );
}