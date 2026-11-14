"use client";

// "Selling at / Working at": the store chips shared by POS, Resack and Stock in, so the owner and the staff
// see the same screen. A staff member the owner tied to one store sees only that store (the server enforces it too).

export interface StoreOption { id: string; name: string; code?: string | null; type?: string }

export default function StoreBar({ label = "Working at", locations: all, value, homeLocationId, onPick, locked = false, lockedNote, includeBuffer = false, inline = false, size = "lg", flush = false }: {
  label?: string;
  locations: StoreOption[];
  value: string;
  homeLocationId: string | null;
  onPick: (id: string) => void;
  /** A sale / resack / stock-in is under way: switching is off until it is finished or cleared. */
  locked?: boolean;
  lockedNote?: string;
  /** The Buffer store covers shortages; it is not a place to sell, so it is hidden unless asked for. */
  includeBuffer?: boolean;
  /** One row — the label, then the chips — for the selling screens, where every line of height counts. */
  inline?: boolean;
  /** `md` chips are 48 px tall (the touch minimum); `lg` are the roomier default. */
  size?: "lg" | "md";
  /** Inline only: no space under the row, for when it sits inside another row (a screen's heading line). */
  flush?: boolean;
}) {
  const locations = includeBuffer ? all : all.filter((l) => l.type !== "BUFFER");
  const here = all.find((l) => l.id === value);
  const btn = size === "lg" ? "btn btn-lg" : "btn";
  const chips = locations.map((l) => (
    <button key={l.id} type="button" disabled={locked && l.id !== value}
      className={`${btn} ${l.id === value ? "btn-dark" : "btn-outline-dark"}`}
      onClick={() => { if (l.id !== value) onPick(l.id); }}>
      {l.code ? `${l.code} · ` : ""}{l.name}
    </button>
  ));
  if (inline) {
    return (
      <div className={`d-flex flex-wrap align-items-center gap-2${flush ? "" : " mb-2"}`}>
        <span className="fw-semibold me-1">{label}</span>
        {homeLocationId ? (
          <><span className="badge text-bg-dark fs-6">{here?.name ?? "…"}</span><span className="small text-muted">your store, set by the owner</span></>
        ) : (
          <>
            <span className="d-flex flex-wrap gap-2" role="group" aria-label={label}>{chips}</span>
            {locked && lockedNote && <span className="small text-muted">{lockedNote}</span>}
          </>
        )}
      </div>
    );
  }
  return (
    <div className="mb-3">
      <div className="small text-muted mb-1">{label}</div>
      {homeLocationId ? (
        <div><span className="badge text-bg-dark fs-6">{here?.name ?? "…"}</span> <span className="small text-muted ms-1">your store, set by the owner</span></div>
      ) : (
        <>
          <div className="d-flex flex-wrap gap-2" role="group" aria-label="Store">{chips}</div>
          {locked && lockedNote && <div className="small text-muted mt-1">{lockedNote}</div>}
        </>
      )}
    </div>
  );
}
