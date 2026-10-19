"use client";

// Staff home — big buttons instead of a long menu. The six daily jobs come first; every
// other screen the role may open is one tap away under "Other screens". It only changes what
// is easy to reach: the server still decides what each role may do (allowedTabs mirrors it).

import { allowedTabs, navItemFor } from "../../lib/admin";

const DAILY = ["benta", "trips", "resack", "bilangin", "agentorders", "drafts"];
const OTHER = ["pasok", "utangrice", "kargadors", "ulat", "orders", "pos", "preorders", "products", "inventory", "customers", "expenses", "purchases", "utang", "reports", "countersettings", "overview"];

interface Props {
  role: string;
  onNavigate: (tab: string) => void;
  /** The menu's own wording for a screen (so names match the drawer). */
  labelFor?: (id: string, fallback: string) => string;
}

export default function StaffHome({ role, onNavigate, labelFor }: Props) {
  const allowed = new Set(allowedTabs(role));
  const items = (ids: string[]) =>
    ids
      .filter((id) => allowed.has(id))
      .map((id) => {
        const n = navItemFor(id);
        return n ? { id, icon: n.icon, label: labelFor ? labelFor(id, n.label) : n.label } : null;
      })
      .filter((x): x is { id: string; icon: string; label: string } => x !== null);

  const daily = items(DAILY);
  const other = items(OTHER);

  const Tile = ({ id, icon, label }: { id: string; icon: string; label: string }) => (
    <div className="col-6 col-md-4">
      <button type="button" className="staff-tile w-100" onClick={() => onNavigate(id)}>
        <i className={`bi ${icon}`}></i>
        <span>{label}</span>
      </button>
    </div>
  );

  return (
    <div className="rice-ui">
      <h1 className="h4 mb-3">What do you need to do?</h1>
      <div className="row g-3 mb-4">
        {daily.map((d) => <Tile key={d.id} {...d} />)}
      </div>
      {other.length > 0 && (
        <details className="staff-other">
          <summary className="btn btn-outline-dark w-100 py-3 fs-5">Other screens ({other.length})</summary>
          <div className="row g-3 mt-1">
            {other.map((d) => <Tile key={d.id} {...d} />)}
          </div>
        </details>
      )}
    </div>
  );
}
