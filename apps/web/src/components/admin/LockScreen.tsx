"use client";

// PIN lock (2026-11-07): shown in place of a screen the owner locked. Four dots and the big number
// pad; the 4th digit checks the PIN on the tablet (works offline). Right PIN: the locked screens
// stay open for UNLOCK_MINUTES. 5 wrong tries: the pad waits a minute.

import { useEffect, useState } from "react";
import {
  MAX_TRIES, UNLOCK_MINUTES, WAIT_SECONDS, pinMatches, readTries, unlockForAWhile, writeTries, type FeatureLock,
} from "../../lib/feature-lock";

interface Props {
  lock: FeatureLock;
  screenName: string;
  /** Who is signed in, so the words fit: the owner types their own lock PIN, staff ask the owner. */
  ownerSignedIn: boolean;
  onBack: () => void;
}

export default function LockScreen({ lock, screenName, ownerSignedIn, onBack }: Props) {
  const [pin, setPin] = useState("");
  const [checking, setChecking] = useState(false);
  const [wrong, setWrong] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [tries, setTries] = useState(readTries);
  const waitLeft = Math.max(0, Math.ceil((tries.waitUntil - now) / 1000));

  useEffect(() => {
    if (waitLeft <= 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waitLeft]);

  const check = async (value: string) => {
    setChecking(true);
    const ok = await pinMatches(lock, value);
    setChecking(false);
    if (ok) {
      writeTries({ n: 0, waitUntil: 0 });
      unlockForAWhile();
      return;
    }
    const n = tries.n + 1;
    const next = n >= MAX_TRIES ? { n: 0, waitUntil: Date.now() + WAIT_SECONDS * 1000 } : { n, waitUntil: 0 };
    writeTries(next); setTries(next); setNow(Date.now());
    setPin("");
    setWrong(n >= MAX_TRIES ? `Wrong PIN ${MAX_TRIES} times. Wait one minute, then try again.` : `Wrong PIN. ${MAX_TRIES - n} ${MAX_TRIES - n === 1 ? "try" : "tries"} left.`);
  };

  const press = (k: string) => {
    if (checking || waitLeft > 0) return;
    setWrong(null);
    if (k === "⌫") return setPin((p) => p.slice(0, -1));
    if (k === "C") return setPin("");
    if (pin.length >= 4) return;
    const next = pin + k;
    setPin(next);
    if (next.length === 4) void check(next);
  };

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"];
  return (
    <div className="lock-screen rice-ui" role="region" aria-labelledby="lock-title">
      <div className="lock-card">
        <div className="lock-info">
        <div className="lock-icon" aria-hidden="true"><i className="bi bi-lock-fill"></i></div>
        <h1 id="lock-title" className="h4 mb-1">{screenName} is locked</h1>
        <p className="mb-3 lock-help">
          {ownerSignedIn ? "Type your lock PIN to open it." : "Ask the owner to type the lock PIN."}
          {" "}It stays open for {UNLOCK_MINUTES} minutes.
        </p>
        <div className="lock-dots" aria-label={`${pin.length} of 4 digits typed`} role="status">
          {[0, 1, 2, 3].map((i) => <span key={i} className={`lock-dot${i < pin.length ? " is-filled" : ""}`} aria-hidden="true"></span>)}
        </div>
        <div className="lock-message" role="alert" aria-live="assertive">
          {waitLeft > 0 ? <span className="text-danger fw-semibold">Too many wrong tries. Try again in {waitLeft} s.</span>
            : wrong ? <span className="text-danger fw-semibold">{wrong}</span>
            : checking ? <span>Checking…</span> : null}
        </div>
        <button type="button" className="btn btn-outline-dark btn-lg w-100 mt-2 lock-back-side" onClick={onBack}>
          <i className="bi bi-arrow-left me-2" aria-hidden="true"></i>Go back
        </button>
        </div>
        <div className="lock-pad">
        <div className="numpad-keys lock-keys">
          {keys.map((k) => (
            <button key={k} type="button" className="btn btn-light border numpad-key" disabled={checking || waitLeft > 0}
              aria-label={k === "⌫" ? "Delete last digit" : k === "C" ? "Clear all" : k} onClick={() => press(k)}>
              {k}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-outline-dark btn-lg w-100 mt-3 lock-back-up" onClick={onBack}>
          <i className="bi bi-arrow-left me-2" aria-hidden="true"></i>Go back
        </button>
        </div>
      </div>
    </div>
  );
}
