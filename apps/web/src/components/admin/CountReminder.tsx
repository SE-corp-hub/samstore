"use client";

// The Home reminder: a store whose rice was not all counted for 2 days or more (or never), or a
// "Close the store" that was started and not finished. Walk-ins are not rung up, so the count is the
// only way their sales reach the app: the reminder keeps it from being forgotten. It shows nothing
// when every store was counted recently, and nothing at all if the check cannot load.

import { useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { CLOSE_STORE_KEY } from "../../lib/count-view";

interface StoreStatus { locationId: string; name: string; daysSince: number | null; openCountId: string | null }

/** Counted every day or every other day: from 2 days the reminder shows. */
export const REMIND_AFTER_DAYS = 2;

export function needsReminder(s: StoreStatus): boolean {
  return !!s.openCountId || s.daysSince === null || s.daysSince >= REMIND_AFTER_DAYS;
}

export default function CountReminder({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [stores, setStores] = useState<StoreStatus[]>([]);
  useEffect(() => {
    let live = true;
    void fetch(`${API_URL}/admin/counts/closing-status`, { headers: adminHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d?.stores) setStores((d.stores as StoreStatus[]).filter(needsReminder)); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  if (!stores.length || !onNavigate) return null;
  const go = (id: string) => {
    try { sessionStorage.setItem(CLOSE_STORE_KEY, id); } catch { /* private mode: Count still opens */ }
    onNavigate("bilangin");
  };
  return (
    <section className="count-reminder" aria-labelledby="count-reminder-title">
      <h2 id="count-reminder-title" className="h6 fw-bold mb-1"><i className="bi bi-clipboard-check me-1" aria-hidden="true"></i>Time to count the rice</h2>
      {stores.map((s) => (
        <div key={s.locationId} className="row-store">
          <span>
            <strong>{s.name}</strong>{" · "}
            {s.openCountId ? "closing was started, not finished" : s.daysSince === null ? "never fully counted" : `last counted ${s.daysSince} days ago`}
          </span>
          <button type="button" className="btn btn-primary" onClick={() => go(s.locationId)}>{s.openCountId ? "Continue closing" : `Close ${s.name}`}</button>
        </div>
      ))}
    </section>
  );
}
