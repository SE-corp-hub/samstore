"use client";

// Each store's own PIN lock (2026-11-20). The owner asked that a manager can set the PIN lock per
// location. A store's lock has its own 4-digit PIN and its own list of screens; the list applies to
// every login of that store (its head and the counter staff). The owner's lock still applies on top.
// Who can set it: the owner, a manager (any store) and the head of that store (its own store only).
// If the head forgets the store PIN, the owner of the app sets a new one here with no old PIN.

import { useEffect, useMemo, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders, isOwnerRole, NAV_GROUPS, storeLoginTabs } from "../../lib/admin";
import { askConfirm } from "../../lib/ask";
import { toast } from "../../lib/toast";
import { cachedGet, saveCopy, savedCopy } from "../../lib/offlineCache";
import { announceLockSaved, LOCK_PATH, SUGGESTED, UNLOCK_MINUTES, unlockForAWhile, type FeatureLock, type StoreLock } from "../../lib/feature-lock";

const digits = (v: string) => v.replace(/\D/g, "").slice(0, 4);
const sameList = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export default function StoreLockSettings({ role }: { role: string }) {
  const [lock, setLock] = useState<FeatureLock | null>(() => savedCopy<FeatureLock>(LOCK_PATH));
  const places = useMemo(() => lock?.places ?? [], [lock]);
  const [placeId, setPlaceId] = useState<string>("");
  const [picked, setPicked] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const [newPin, setNewPin] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const owner = isOwnerRole(role) || role === "PLATFORM_ADMIN";

  useEffect(() => {
    void cachedGet<FeatureLock>(LOCK_PATH).then((d) => { if (d) setLock(d); });
  }, []);
  // The first store is chosen at the start (a store head has only its own).
  useEffect(() => {
    if (!places.some((p) => p.id === placeId)) setPlaceId(places[0]?.id ?? "");
  }, [places, placeId]);

  const mine: StoreLock | null = (placeId && lock?.locations?.[placeId]) || null;
  const on = !!mine;
  useEffect(() => {
    setPicked(mine ? mine.screens : SUGGESTED.store);
    setCurrent(""); setNewPin(""); setAgain(""); setProblem(null);
  }, [placeId, mine?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const canLock = useMemo(() => new Set(storeLoginTabs()), []);
  const groups = useMemo(() => NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((i) => canLock.has(i.id)) }))
    .filter((g) => g.items.length > 0), [canLock]);

  if (places.length === 0) {
    return <div className="alert alert-secondary py-2" role="note">No store to set a PIN lock for. Connect to the internet and open this again.</div>;
  }

  const placeName = places.find((p) => p.id === placeId)?.name ?? "this store";
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const listChanged = !on || !sameList(picked, mine?.screens ?? []);
  const pinProblem = (!on && newPin.length !== 4) ? "Choose 4 digits."
    : newPin && newPin.length !== 4 ? "The PIN needs 4 digits."
    : newPin && again !== newPin ? "The two PINs are not the same."
    : null;
  // The owner of the app never needs the old store PIN (a head who forgot it asks the owner).
  const needCurrent = on && !owner && !current;
  const canSave = !busy && !pinProblem && !needCurrent && (listChanged || !!newPin);

  const send = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true); setProblem(null);
    try {
      const res = await fetch(`${API_URL}${LOCK_PATH}/location/${encodeURIComponent(placeId)}`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setProblem(d?.message ?? d?.errors?.join(", ") ?? "Did not save. Try again."); return false; }
      const base = savedCopy<FeatureLock>(LOCK_PATH) ?? lock ?? { on: false, owner: [], staff: [] };
      const locations = { ...(base.locations ?? {}) };
      if (d?.on && d.lock) locations[placeId] = d.lock; else delete locations[placeId];
      const next = { ...base, locations };
      saveCopy(LOCK_PATH, next);
      setLock(next);
      // The person who just saved proved who they are: this store's locked screens stay open for a while.
      if (d?.on) unlockForAWhile("store");
      announceLockSaved();
      return true;
    } catch {
      setProblem("No internet. Nothing was saved. Try again when the tablet is online.");
      return false;
    } finally { setBusy(false); }
  };

  const save = async () => {
    if (await send({ current, newPin: newPin || undefined, screens: picked })) toast(on ? `${placeName} PIN lock saved` : `${placeName} PIN lock is on`, "success");
  };
  const turnOff = async () => {
    if (needCurrent) { setProblem("Type the current store PIN (or your password) first."); return; }
    if (!(await askConfirm(`Turn the PIN lock off for ${placeName}? Its screens will open without the store PIN.`, { ok: "Turn off", cancel: "Keep it on", danger: true }))) return;
    if (await send({ current, off: true })) toast(`${placeName} PIN lock is off`, "success");
  };

  return (
    <div className="pin-lock-settings store-lock-settings">
      {places.length > 1 && (
        <div className="mb-3">
          <div className="fw-semibold mb-2" id="sl-which">Which store?</div>
          <div className="d-flex flex-wrap gap-2" role="group" aria-labelledby="sl-which">
            {places.map((p) => {
              const isOn = !!lock?.locations?.[p.id];
              return (
                <button key={p.id} type="button" className={`btn btn-lg ${placeId === p.id ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={placeId === p.id} onClick={() => setPlaceId(p.id)}>
                  {p.name} <span className={`badge ms-1 ${isOn ? "text-bg-success" : "text-bg-light"}`}>{isOn ? "On" : "Off"}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className={`alert ${on ? "alert-success" : "alert-secondary"} d-flex align-items-center gap-2 py-2`} role="status">
        <i className={`bi ${on ? "bi-lock-fill" : "bi-unlock"} fs-4`} aria-hidden="true"></i>
        <div>
          <div className="fw-semibold">{placeName}: the store PIN lock is {on ? "on" : "off"}</div>
          <div>Ticked screens ask for this store&apos;s PIN when its head or counter staff are signed in, also with no internet. After the right PIN they stay open for {UNLOCK_MINUTES} minutes. The owner&apos;s lock PIN opens them too.</div>
        </div>
      </div>

      <div className="border rounded-3 p-3 mb-3 bg-white">
        <h3 className="h6 text-uppercase text-muted">1. Store PIN</h3>
        {on && !owner && (
          <div className="mb-3">
            <label className="form-label fw-semibold mb-1" htmlFor="sl-cur">Current store PIN</label>
            <input id="sl-cur" className="form-control form-control-lg" style={{ maxWidth: 320 }} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            <div className="small text-muted mt-1">Forgot it? Type your account password here, or ask the owner to set a new PIN.</div>
          </div>
        )}
        {on && owner && (
          <p className="mb-3"><i className="bi bi-info-circle me-1" aria-hidden="true"></i>As the owner you can set a new PIN without the old one. Use this when the store head forgets the PIN.</p>
        )}
        <div className="d-flex flex-wrap gap-3">
          <div>
            <label className="form-label fw-semibold mb-1" htmlFor="sl-new">{on ? "New store PIN (empty = keep the old one)" : "Choose a store PIN (4 digits)"}</label>
            <input id="sl-new" className="form-control form-control-lg text-center pin-box" type="password" inputMode="numeric" autoComplete="new-password" maxLength={4}
              value={newPin} onChange={(e) => setNewPin(digits(e.target.value))} aria-describedby="sl-pin-problem" />
          </div>
          <div>
            <label className="form-label fw-semibold mb-1" htmlFor="sl-again">Type it again</label>
            <input id="sl-again" className="form-control form-control-lg text-center pin-box" type="password" inputMode="numeric" autoComplete="new-password" maxLength={4}
              value={again} onChange={(e) => setAgain(digits(e.target.value))} aria-describedby="sl-pin-problem" />
          </div>
        </div>
        <div id="sl-pin-problem" className="small mt-1">
          {(newPin || again) && pinProblem ? <span className="text-danger">{pinProblem}</span>
            : <span className="text-muted">Use a different PIN from the staff login PINs, and do not tell the counter staff.</span>}
        </div>
      </div>

      <div className="border rounded-3 p-3 mb-3 bg-white">
        <h3 className="h6 text-uppercase text-muted">2. Screens that ask for the store PIN</h3>
        <div className="d-flex flex-wrap gap-2 mb-3">
          <button type="button" className="btn btn-outline-primary btn-lg" onClick={() => setPicked(SUGGESTED.store)}>Use suggested</button>
          <button type="button" className="btn btn-outline-dark btn-lg" onClick={() => setPicked([])}>Untick all</button>
        </div>
        {groups.map((g) => (
          <fieldset key={g.group} className={`lock-pick-group tone-${g.tone} mb-3`}>
            <legend className="home-group-title">
              <span className="home-group-icon" aria-hidden="true"><i className={`bi ${g.icon}`}></i></span>{g.label}
            </legend>
            <div className="lock-pick-grid">
              {g.items.map((it) => {
                const checked = picked.includes(it.id);
                return (
                  <label key={it.id} className={`lock-pick${checked ? " is-on" : ""}`}>
                    <input type="checkbox" className="form-check-input" checked={checked} onChange={() => toggle(it.id)} />
                    <i className={`bi ${it.icon}`} aria-hidden="true"></i>
                    <span className="flex-grow-1">{it.label}</span>
                    {checked && <i className="bi bi-lock-fill" aria-hidden="true"></i>}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      {problem && <div className="alert alert-danger py-2" role="alert">{problem}</div>}
      <div className="settings-savebar position-sticky bottom-0 sticky-above-bar">
        <span className="me-auto" role="status">
          {busy ? "Saving…" : needCurrent && (listChanged || newPin) ? "Type the current store PIN to save" : listChanged || newPin ? "Not saved yet" : "All saved"}
        </span>
        {on && <button type="button" className="btn btn-outline-danger btn-lg" disabled={busy} onClick={() => void turnOff()}>Turn off</button>}
        <button type="button" className="btn btn-success btn-lg px-4" disabled={!canSave} onClick={() => void save()}>
          {busy ? "Saving…" : on ? "Save" : "Turn on the store lock"}
        </button>
      </div>
    </div>
  );
}
