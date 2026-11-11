"use client";

// Settings → PIN lock (2026-11-07). The owner chooses a 4-digit lock PIN and ticks the screens
// that ask for it, one list for when the owner is signed in (the tablet is often left signed in at
// the counter) and one for staff (manager, staff, sales agents). Changing it needs the internet
// and, once a lock exists, the current lock PIN or the owner's password (forgot the PIN).

import { useEffect, useMemo, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders, allowedTabs, NAV_GROUPS } from "../../lib/admin";
import { askConfirm } from "../../lib/ask";
import { toast } from "../../lib/toast";
import { cachedGet, saveCopy, savedCopy } from "../../lib/offlineCache";
import { announceLockSaved, LOCK_PATH, SUGGESTED, UNLOCK_MINUTES, unlockForAWhile, type FeatureLock } from "../../lib/feature-lock";

type Who = "owner" | "staff";

/** The one line under "PIN lock" in the Settings list. */
export function lockSummary(lock: FeatureLock | null): string {
  if (!lock?.on) return "Off · no screen asks for a PIN";
  const n = (k: Who) => lock[k].length;
  return `On · owner ${n("owner")} screen${n("owner") === 1 ? "" : "s"}, staff ${n("staff")} screen${n("staff") === 1 ? "" : "s"}`;
}

/** Screens each list can lock: what that kind of sign-in can open at all. */
const SCREENS: Record<Who, Set<string>> = {
  owner: new Set(allowedTabs("OWNER")),
  staff: new Set([...allowedTabs("MANAGER"), ...allowedTabs("STAFF"), ...allowedTabs("SALES_AGENT")]),
};

const digits = (v: string) => v.replace(/\D/g, "").slice(0, 4);

export default function PinLockSettings({ canChange, onSaved }: { canChange: boolean; onSaved?: () => void }) {
  const [lock, setLock] = useState<FeatureLock | null>(() => savedCopy<FeatureLock>(LOCK_PATH));
  const [who, setWho] = useState<Who>("owner");
  const [picked, setPicked] = useState<Record<Who, string[]>>({ owner: [], staff: [] });
  const [current, setCurrent] = useState("");
  const [newPin, setNewPin] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const on = !!lock?.on;
  const fill = (l: FeatureLock | null) =>
    setPicked(l?.on ? { owner: l.owner, staff: l.staff } : { owner: SUGGESTED.owner, staff: SUGGESTED.staff });

  useEffect(() => {
    fill(savedCopy<FeatureLock>(LOCK_PATH));
    void cachedGet<FeatureLock>(LOCK_PATH).then((d) => { if (d) { setLock(d); fill(d); } });
  }, []);

  const groups = useMemo(() => NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((i) => SCREENS[who].has(i.id)) }))
    .filter((g) => g.items.length > 0), [who]);

  const toggle = (id: string) => setPicked((p) => ({ ...p, [who]: p[who].includes(id) ? p[who].filter((x) => x !== id) : [...p[who], id] }));

  const listChanged = !on || JSON.stringify([...picked.owner].sort()) !== JSON.stringify([...(lock?.owner ?? [])].sort())
    || JSON.stringify([...picked.staff].sort()) !== JSON.stringify([...(lock?.staff ?? [])].sort());
  const pinProblem = (!on && newPin.length !== 4) ? "Choose 4 digits."
    : newPin && newPin.length !== 4 ? "The PIN needs 4 digits."
    : newPin && again !== newPin ? "The two PINs are not the same."
    : null;
  const needCurrent = on && !current;
  const canSave = canChange && !busy && !pinProblem && !needCurrent && (listChanged || !!newPin);

  const send = async (body: Record<string, unknown>): Promise<FeatureLock | null> => {
    setBusy(true); setProblem(null);
    try {
      const res = await fetch(`${API_URL}${LOCK_PATH}`, { method: "PUT", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setProblem(d?.message ?? d?.errors?.join(", ") ?? "Did not save. Try again."); return null; }
      saveCopy(LOCK_PATH, d);
      setLock(d); fill(d);
      setCurrent(""); setNewPin(""); setAgain("");
      // The owner just proved the PIN: keep the locked screens (this one too) open for a while.
      if (d?.on) unlockForAWhile();
      announceLockSaved();
      onSaved?.();
      return d as FeatureLock;
    } catch {
      setProblem("No internet. Nothing was saved. Try again when the tablet is online.");
      return null;
    } finally { setBusy(false); }
  };

  const save = async () => {
    const d = await send({ current, newPin: newPin || undefined, owner: picked.owner, staff: picked.staff });
    if (d) toast(on ? "PIN lock saved" : "PIN lock is on", "success");
  };
  const turnOff = async () => {
    if (!current) { setProblem("Type the current lock PIN (or your password) first."); return; }
    if (!(await askConfirm("Turn the PIN lock off? Every screen will open without a PIN.", { ok: "Turn off", cancel: "Keep it on", danger: true }))) return;
    if (await send({ current, off: true })) toast("PIN lock is off", "success");
  };

  return (
    <div className="pin-lock-settings">
      <div className={`alert ${on ? "alert-success" : "alert-secondary"} d-flex align-items-center gap-2 py-2`} role="status">
        <i className={`bi ${on ? "bi-lock-fill" : "bi-unlock"} fs-4`} aria-hidden="true"></i>
        <div>
          <div className="fw-semibold">{on ? "The PIN lock is on" : "The PIN lock is off"}</div>
          <div>Ticked screens ask for the lock PIN before they open, also with no internet. After the right PIN they stay open for {UNLOCK_MINUTES} minutes, or until you press Lock.</div>
        </div>
      </div>
      {!canChange && <div className="alert alert-warning py-2" role="note">Only the owner can change the PIN lock.</div>}

      <fieldset disabled={!canChange} className="border-0 p-0 m-0">
        <div className="border rounded-3 p-3 mb-3 bg-white">
          <h3 className="h6 text-uppercase text-muted">1. Lock PIN</h3>
          {on && (
            <div className="mb-3">
              <label className="form-label fw-semibold mb-1" htmlFor="lk-cur">Current lock PIN</label>
              <input id="lk-cur" className="form-control form-control-lg" style={{ maxWidth: 320 }} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
              <div className="small text-muted mt-1">Forgot it? Type your account password here instead.</div>
            </div>
          )}
          <div className="d-flex flex-wrap gap-3">
            <div>
              <label className="form-label fw-semibold mb-1" htmlFor="lk-new">{on ? "New lock PIN (empty = keep the old one)" : "Choose a lock PIN (4 digits)"}</label>
              <input id="lk-new" className="form-control form-control-lg text-center pin-box" type="password" inputMode="numeric" autoComplete="new-password" maxLength={4}
                value={newPin} onChange={(e) => setNewPin(digits(e.target.value))} aria-describedby="lk-pin-problem" />
            </div>
            <div>
              <label className="form-label fw-semibold mb-1" htmlFor="lk-again">Type it again</label>
              <input id="lk-again" className="form-control form-control-lg text-center pin-box" type="password" inputMode="numeric" autoComplete="new-password" maxLength={4}
                value={again} onChange={(e) => setAgain(digits(e.target.value))} aria-describedby="lk-pin-problem" />
            </div>
          </div>
          <div id="lk-pin-problem" className="small mt-1">
            {(newPin || again) && pinProblem ? <span className="text-danger">{pinProblem}</span>
              : <span className="text-muted">Use a different PIN from the staff login PINs, and do not tell staff.</span>}
          </div>
        </div>

        <div className="border rounded-3 p-3 mb-3 bg-white">
          <h3 className="h6 text-uppercase text-muted">2. Screens that ask for the PIN</h3>
          <div className="btn-group w-100 mb-3" role="group" aria-label="Whose screens">
            {(["owner", "staff"] as Who[]).map((w) => (
              <button key={w} type="button" className={`btn btn-lg ${who === w ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={who === w} onClick={() => setWho(w)}>
                {w === "owner" ? "Owner signed in" : "Staff signed in"} <span className="badge text-bg-light ms-1">{picked[w].length}</span>
              </button>
            ))}
          </div>
          <p className="mb-2">{who === "owner"
            ? "For when the tablet is signed in as you, the owner, and someone else uses it."
            : "For when a manager, staff or sales agent is signed in. Screens they cannot open at all are not listed."}</p>
          <div className="d-flex flex-wrap gap-2 mb-3">
            <button type="button" className="btn btn-outline-primary" onClick={() => setPicked((p) => ({ ...p, [who]: SUGGESTED[who] }))}>Use suggested</button>
            <button type="button" className="btn btn-outline-dark" onClick={() => setPicked((p) => ({ ...p, [who]: [] }))}>Untick all</button>
          </div>
          {groups.map((g) => (
            <fieldset key={g.group} className={`lock-pick-group tone-${g.tone} mb-3`}>
              <legend className="home-group-title">
                <span className="home-group-icon" aria-hidden="true"><i className={`bi ${g.icon}`}></i></span>{g.label}
              </legend>
              <div className="lock-pick-grid">
                {g.items.map((it) => {
                  const checked = picked[who].includes(it.id);
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
            {busy ? "Saving…" : needCurrent && (listChanged || newPin) ? "Type the current lock PIN to save" : listChanged || newPin ? "Not saved yet" : "All saved"}
          </span>
          {on && <button type="button" className="btn btn-outline-danger btn-lg" disabled={busy} onClick={() => void turnOff()}>Turn off</button>}
          <button type="button" className="btn btn-success btn-lg px-4" disabled={!canSave} onClick={() => void save()}>
            {busy ? "Saving…" : on ? "Save" : "Turn on the lock"}
          </button>
        </div>
      </fieldset>
    </div>
  );
}
