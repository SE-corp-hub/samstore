"use client";

// Rice Ops — the Count home. Anyone can count:
//   * search for an item (name, size, code or barcode) and count it right there, or
//   * start a list count: everything here / one kind of rice / not counted lately / picked items.
// Counts post when submitted; the owner is not asked first.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { ageText, searchItems, staleCount, staleFirst, titleCase, type CountItem } from "../../lib/count-view";
import QuickCount from "./QuickCount";

type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;
const errText = (d: ApiBody | null, f: string) => d?.errors?.join(", ") ?? d?.message ?? f;

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(`${API_URL}${path}`, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...adminHeaders() }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: res.ok, data: (await res.json().catch(() => null)) as ApiBody | null };
}

export default function CountHome({ locationId, owner, onOpen, onChanged, onError, onClosing, children }: {
  locationId: string;
  owner: boolean;
  /** Open a count that was just started. */
  onOpen: (id: string) => void | Promise<void>;
  /** Something was counted or started: reload the list of counts. */
  onChanged: () => void | Promise<void>;
  onError: (message: string | null) => void;
  onClosing: () => void;
  /** The list of counts, shown under the search on the home view only. */
  children?: ReactNode;
}) {
  const [items, setItems] = useState<CountItem[] | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<CountItem | null>(null);
  const [setup, setSetup] = useState(false);
  const [suggest, setSuggest] = useState(false);

  const loadItems = useCallback(async () => {
    const r = await call("GET", `/admin/counts/items?locationId=${encodeURIComponent(locationId)}`);
    if (r.ok) setItems(((r.data?.items as CountItem[] | undefined) ?? []));
    else onError(errText(r.data, "Could not load the items"));
  }, [locationId, onError]);
  useEffect(() => { setItems(null); setPicked(null); setSetup(false); setSuggest(false); void loadItems(); }, [loadItems]);

  const results = useMemo(() => (items ? (q.trim() ? searchItems(items, q) : staleFirst(items, 5)) : []), [items, q]);

  if (picked) {
    return (
      <QuickCount
        title={`Count — ${picked.name}`} cancelLabel="Cancel" productId={picked.productId} name={picked.name} loose={picked.loose} locationId={locationId}
        onCancel={() => setPicked(null)}
        onDone={async () => { setPicked(null); setQ(""); await loadItems(); await onChanged(); }}
      />
    );
  }
  if (setup && items) {
    return (
      <ListSetup
        locationId={locationId} owner={owner} items={items} onError={onError} onBack={() => setSetup(false)}
        onStarted={async (id) => { setSetup(false); await onChanged(); await onOpen(id); }}
      />
    );
  }
  if (suggest) {
    return (
      <Suggested
        locationId={locationId} onError={onError} onBack={() => setSuggest(false)}
        onStarted={async (id) => { setSuggest(false); await onChanged(); await onOpen(id); }}
      />
    );
  }
  return (
    <>
      <div className="mb-3" style={{ maxWidth: 560 }}>
        <label className="form-label fw-semibold" htmlFor="count-search">Count one item</label>
        <input
          id="count-search" className="form-control form-control-lg" placeholder="Search by name, size or code…" autoComplete="off" inputMode="search"
          value={q} onChange={(e) => setQ(e.target.value.slice(0, 40))}
          onKeyDown={(e) => { if (e.key === "Enter" && results[0]) { e.preventDefault(); setPicked(results[0]); } }}
        />
        {items === null && <div className="text-muted mt-2">Loading the items…</div>}
        {items && !q.trim() && results.length > 0 && <div className="small text-muted mt-2">Not counted for the longest time:</div>}
        <div className="list-group mt-2">
          {results.map((i) => (
            <button key={i.productId} type="button" className="list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-2" onClick={() => setPicked(i)}>
              <span>{i.name}</span>
              <span className="small text-muted">{ageText(i.lastCountedAt)}</span>
            </button>
          ))}
        </div>
        {items && q.trim() && results.length === 0 && <p className="text-muted mt-2">No item matches “{q.trim()}”.</p>}
      </div>
      <div className="d-flex flex-wrap gap-2 mb-3">
        <button type="button" className="btn btn-success btn-lg" disabled={!items} onClick={() => setSetup(true)}>Count a list</button>
        <button type="button" className="btn btn-outline-success btn-lg" onClick={() => setSuggest(true)}>Today&apos;s suggested list</button>
        <button type="button" className="btn btn-outline-dark btn-lg" onClick={onClosing} title="A quick count of the 5 items that sold most in the last day. Optional.">Quick count: 5 best sellers</button>
      </div>
      {children}
    </>
  );
}

type Mode = "all" | "variety" | "stale" | "pick";

function ListSetup({ locationId, owner, items, onStarted, onBack, onError }: {
  locationId: string; owner: boolean; items: CountItem[]; onStarted: (id: string) => void | Promise<void>; onBack: () => void; onError: (m: string | null) => void;
}) {
  const [mode, setMode] = useState<Mode>("all");
  const varieties = useMemo(() => Array.from(new Set(items.map((i) => i.variety).filter(Boolean))).sort(), [items]);
  const [variety, setVariety] = useState("");
  const [days, setDays] = useState("14");
  const [pickQ, setPickQ] = useState("");
  const [pickIds, setPickIds] = useState<string[]>([]);
  const [showSystem, setShowSystem] = useState(false);
  const [busy, setBusy] = useState(false);

  const n = mode === "all" ? items.length : mode === "variety" ? items.filter((i) => i.variety === variety).length : mode === "stale" ? staleCount(items, Number(days)) : pickIds.length;
  const found = useMemo(() => (pickQ.trim() ? searchItems(items, pickQ, 20) : []), [items, pickQ]);
  const byId = useMemo(() => new Map(items.map((i) => [i.productId, i] as const)), [items]);
  const toggle = (id: string) => setPickIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const ready = n > 0 && (mode !== "variety" || !!variety) && (mode !== "stale" || (Number.isInteger(Number(days)) && Number(days) >= 1));

  const start = async () => {
    setBusy(true); onError(null);
    const body: Record<string, unknown> = { locationId };
    if (mode === "variety") body.variety = variety;
    if (mode === "stale") body.staleDays = Number(days);
    if (mode === "pick") body.productIds = pickIds;
    if (owner && showSystem) body.showSystem = true;
    const r = await call("POST", "/admin/counts", body);
    setBusy(false);
    if (!r.ok) { onError(errText(r.data, "Could not start the count")); return; }
    toast(`Started: ${String(r.data?.docNumber ?? "")}`);
    await onStarted(String(r.data?.id));
  };

  const radio = (m: Mode, label: ReactNode) => (
    <div className="form-check mb-2">
      <input className="form-check-input" type="radio" name="count-mode" id={`cm-${m}`} checked={mode === m} onChange={() => setMode(m)} />
      <label className="form-check-label" htmlFor={`cm-${m}`}>{label}</label>
    </div>
  );

  return (
    <div style={{ maxWidth: 560 }}>
      <button type="button" className="btn btn-link px-0 mb-2" onClick={onBack}>← Counts</button>
      <h2 className="h5">Count a list</h2>
      <p className="mb-2">What do you want to count here?</p>
      {radio("all", <>Everything here <span className="text-muted">({items.length} items)</span></>)}
      {radio("variety", <>One kind of rice</>)}
      {mode === "variety" && (
        <select className="form-select form-select-lg mb-2" aria-label="Kind of rice" value={variety} onChange={(e) => setVariety(e.target.value)}>
          <option value="">Choose…</option>
          {varieties.map((v) => <option key={v} value={v}>{titleCase(v)}</option>)}
        </select>
      )}
      {radio("stale", <>Items not counted lately</>)}
      {mode === "stale" && (
        <div className="d-flex align-items-center gap-2 mb-2">
          <span>Not counted in the last</span>
          <input className="form-control" style={{ maxWidth: 90 }} inputMode="numeric" aria-label="Days" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, "").slice(0, 3))} />
          <span>days</span>
        </div>
      )}
      {radio("pick", <>Pick the items</>)}
      {mode === "pick" && (
        <div className="mb-2">
          <input className="form-control form-control-lg mb-2" placeholder="Search to add an item…" aria-label="Search to add an item" value={pickQ} onChange={(e) => setPickQ(e.target.value.slice(0, 40))} />
          <div className="list-group mb-2">
            {found.map((i) => (
              <label key={i.productId} className="list-group-item d-flex gap-2 align-items-center">
                <input className="form-check-input mt-0" type="checkbox" checked={pickIds.includes(i.productId)} onChange={() => toggle(i.productId)} />
                <span>{i.name}</span>
              </label>
            ))}
          </div>
          {pickIds.length > 0 && (
            <div className="d-flex flex-wrap gap-1">
              {pickIds.map((id) => <button key={id} type="button" className="btn btn-sm btn-outline-secondary" onClick={() => toggle(id)}>{byId.get(id)?.name ?? id} ✕</button>)}
            </div>
          )}
        </div>
      )}
      {owner && (
        <div className="form-check form-switch my-3">
          <input className="form-check-input" type="checkbox" id="cm-system" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
          <label className="form-check-label" htmlFor="cm-system">Show the system numbers while counting</label>
        </div>
      )}
      <p className="text-muted mb-2">{ready ? `${n} item${n === 1 ? "" : "s"} to count.` : mode === "stale" && n === 0 ? "Every item was counted in that time." : ""}</p>
      <button type="button" className="btn btn-success btn-lg w-100" disabled={busy || !ready} onClick={() => void start()}>{busy ? "Please wait…" : "Start counting"}</button>
    </div>
  );
}

interface Suggestion { productId: string; name: string; why: string; days: number | null; text: string }

/** About ten items to count today: never counted first, then fast sellers weekly and the rest monthly. */
function Suggested({ locationId, onStarted, onBack, onError }: { locationId: string; onStarted: (id: string) => void | Promise<void>; onBack: () => void; onError: (m: string | null) => void }) {
  const [list, setList] = useState<Suggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void call("GET", `/admin/counts/suggest?locationId=${encodeURIComponent(locationId)}`).then((r) => {
      if (!live) return;
      if (r.ok) setList((r.data?.items as Suggestion[] | undefined) ?? []); else { onError(errText(r.data, "Could not load the list")); setList([]); }
    });
    return () => { live = false; };
  }, [locationId, onError]);

  const start = async () => {
    if (!list?.length) return;
    setBusy(true); onError(null);
    const r = await call("POST", "/admin/counts", { locationId, productIds: list.map((x) => x.productId) });
    setBusy(false);
    if (!r.ok) { onError(errText(r.data, "Could not start the count")); return; }
    toast(`Started: ${String(r.data?.docNumber ?? "")}`);
    await onStarted(String(r.data?.id));
  };

  return (
    <div style={{ maxWidth: 560 }}>
      <button type="button" className="btn btn-link px-0 mb-2" onClick={onBack}>← Counts</button>
      <h2 className="h5">Today&apos;s suggested list</h2>
      <p className="mb-2">Items never counted come first, then fast sellers (every week) and the rest (every month). A few items each day keeps the numbers right.</p>
      {list === null && <p className="text-muted">Loading…</p>}
      {list && list.length === 0 && <div className="alert alert-success">Everything was counted recently. Nothing to suggest today.</div>}
      {list && list.length > 0 && (
        <>
          <ul className="list-group mb-3">
            {list.map((x) => <li key={x.productId} className="list-group-item d-flex justify-content-between gap-2"><span>{x.name}</span><span className="small text-muted text-end">{x.text}</span></li>)}
          </ul>
          <button type="button" className="btn btn-success btn-lg w-100" disabled={busy} onClick={() => void start()}>{busy ? "Please wait…" : `Start counting these ${list.length}`}</button>
        </>
      )}
    </div>
  );
}
