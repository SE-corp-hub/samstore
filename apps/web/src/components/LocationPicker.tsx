"use client";

// "Where is it?" — pick a place, or add one on the spot if it is not registered yet.
// A place added here is flagged "added by staff" so the owner can check it in Locations.

import { useState } from "react";
import { API_URL } from "../config";
import { adminHeaders } from "../lib/admin";
import { toast } from "../lib/toast";

export interface PickableLocation { id: string; name: string; code?: string | null; type?: string }

interface Props {
  locations: PickableLocation[];
  value: string;
  onChange: (id: string) => void;
  /** Called after a new place is created so the parent can reload its list. */
  onAdded?: (loc: PickableLocation) => void;
  label?: string;
  /** What to show for each place (e.g. add the balance). */
  labelFor?: (l: PickableLocation) => string;
  allowAdd?: boolean;
  id?: string;
}

export default function LocationPicker({ locations, value, onChange, onAdded, label, labelFor, allowAdd = true, id }: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const n = name.trim();
    if (n.length < 2) { toast("Type the place's name", "danger"); return; }
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/admin/locations/quick`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ name: n }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.id) { toast(d?.message ?? d?.errors?.join(" · ") ?? "Could not add the place", "danger"); return; }
      const loc = { id: d.id as string, name: n };
      onAdded?.(loc);
      onChange(loc.id);
      setName(""); setAdding(false);
      toast(`Added ${n} — the owner will check it`, "success");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {label && <label className="form-label small mb-1" htmlFor={id}>{label}</label>}
      <select id={id} className="form-select form-select-lg" value={value} onChange={(e) => (e.target.value === "__add" ? setAdding(true) : onChange(e.target.value))}>
        <option value="">Choose…</option>
        {locations.map((l) => <option key={l.id} value={l.id}>{labelFor ? labelFor(l) : `${l.name}${l.code ? ` (${l.code})` : ""}`}</option>)}
        {allowAdd && <option value="__add">＋ Add a place that is not listed</option>}
      </select>
      {adding && (
        <div className="input-group mt-2">
          <input className="form-control" placeholder="Name of the place" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <button type="button" className="btn btn-success" disabled={busy} onClick={() => void add()}>Add</button>
          <button type="button" className="btn btn-outline-secondary" onClick={() => { setAdding(false); setName(""); }}>Cancel</button>
        </div>
      )}
    </div>
  );
}
