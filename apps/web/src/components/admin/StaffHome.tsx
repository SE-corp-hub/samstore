"use client";

// Home (the bottom bar's "More" for staff, manager and owner): every screen the role may open,
// grouped by what it is for (Sell, Money, Stock, Reports, People & settings) in the same order
// and colours as the Menu and the top bar, as big tiles, nothing hidden behind a second tap.
// It only changes what is easy to reach: the server still decides what each role may do
// (allowedTabs mirrors it). The Text size choice sits at the bottom so every role can find it.

import { allowedTabs, NAV_GROUPS } from "../../lib/admin";
import TextSizePicker from "./TextSizePicker";
import CountReminder from "./CountReminder";

interface Props {
  role: string;
  onNavigate: (tab: string) => void;
  /** The menu's own wording for a screen (so names match the drawer). */
  labelFor?: (id: string, fallback: string) => string;
  /** PIN lock: screens that ask for the lock PIN get a lock on their tile. */
  isLocked?: (id: string) => boolean;
}

export default function StaffHome({ role, onNavigate, labelFor, isLocked }: Props) {
  const allowed = new Set(allowedTabs(role));
  const groups = NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((i) => allowed.has(i.id)) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="rice-ui">
      <h1 className="h4 mb-3">What do you need to do?</h1>
      {allowed.has("bilangin") && <CountReminder onNavigate={onNavigate} />}
      {groups.map((g) => (
        <section key={g.group} className={`home-group tone-${g.tone}`} aria-labelledby={`home-group-${g.group}`}>
          <h2 id={`home-group-${g.group}`} className="home-group-title">
            <span className="home-group-icon" aria-hidden="true"><i className={`bi ${g.icon}`}></i></span>
            {g.label}
          </h2>
          <div className="row g-3">
            {g.items.map((it) => (
              <div key={it.id} className="col-6 col-md-4 col-xl-3">
                <button type="button" className="staff-tile w-100 position-relative" onClick={() => onNavigate(it.id)}>
                  <i className={`bi ${it.icon}`} aria-hidden="true"></i>
                  <span>{labelFor ? labelFor(it.id, it.label) : it.label}</span>
                  {isLocked?.(it.id) && <i className="bi bi-lock-fill tile-lock" role="img" aria-label="Needs the lock PIN"></i>}
                </button>
              </div>
            ))}
          </div>
        </section>
      ))}
      <section className="card p-3" aria-label="Text size">
        <TextSizePicker />
      </section>
    </div>
  );
}
