"use client";

// "Selling at / Working at": the store chips shared by POS, Resack and Stock in, so the owner and the staff
// see the same screen. A staff member the owner tied to one store sees only that store (the server enforces it too).

export interface StoreOption { id: string; name: string; code?: string | null; type?: string }

export default function StoreBar({ label = "Working at", locations: all, value, homeLocationId, onPick, locked = false, lockedNote, includeBuffer = false }: {
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
}) {
  const locations = includeBuffer ? all : all.filter((l) => l.type !== "BUFFER");
  const here = all.find((l) => l.id === value);
  return (
    <div className="mb-3">
      <div className="small text-muted mb-1">{label}</div>
      {homeLocationId ? (
        <div><span className="badge text-bg-dark fs-6">{here?.name ?? "…"}</span> <span className="small text-muted ms-1">your store, set by the owner</span></div>
      ) : (
        <>
          <div className="d-flex flex-wrap gap-2" role="group" aria-label="Store">
            {locations.map((l) => (
              <button key={l.id} type="button" disabled={locked && l.id !== value}
                className={`btn btn-lg ${l.id === value ? "btn-dark" : "btn-outline-dark"}`}
                onClick={() => { if (l.id !== value) onPick(l.id); }}>
                {l.code ? `${l.code} · ` : ""}{l.name}
              </button>
            ))}
          </div>
          {locked && lockedNote && <div className="small text-muted mt-1">{lockedNote}</div>}
        </>
      )}
    </div>
  );
}
