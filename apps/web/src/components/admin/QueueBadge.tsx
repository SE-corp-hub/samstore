"use client";

// Rice Ops M10 — "Waiting to send (2)": steps waiting on this phone for signal, and
// any the server refused later (with the reason), so nothing silently disappears.

import { useEffect, useState } from "react";
import { clearFailed, failedSteps, flushQueue, QUEUE_EVENT, queuedSteps, startQueue, type FailedStep, type QueuedStep } from "../../lib/offlineQueue";
import { useLang } from "../../lib/lang";

export default function QueueBadge() {
  const { t } = useLang();
  const [waiting, setWaiting] = useState<QueuedStep[]>([]);
  const [failed, setFailed] = useState<FailedStep[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const refresh = () => { setWaiting(queuedSteps()); setFailed(failedSteps()); };
    refresh();
    startQueue();
    window.addEventListener(QUEUE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => { window.removeEventListener(QUEUE_EVENT, refresh); window.removeEventListener("storage", refresh); };
  }, []);
  if (waiting.length === 0 && failed.length === 0) return null;
  return (
    <div className="position-relative">
      <button type="button" className={`btn btn-sm ${failed.length ? "btn-danger" : "btn-warning"}`} onClick={() => setOpen(!open)}>
        {waiting.length > 0 && <>{t("queue.waiting")} ({waiting.length})</>}{waiting.length > 0 && failed.length > 0 && " · "}{failed.length > 0 && <>{t("queue.failed")} ({failed.length})</>}
      </button>
      {open && (
        <div className="card position-absolute end-0 mt-1 shadow" style={{ zIndex: 1050, width: 300 }}>
          <div className="card-body small">
            {waiting.map((s) => <div key={s.id}>⏳ {s.label} · {new Date(s.createdAt).toLocaleTimeString("en-PH")}</div>)}
            {waiting.length > 0 && <button type="button" className="btn btn-outline-dark btn-sm mt-2" onClick={() => void flushQueue()}>{t("queue.sendNow")}</button>}
            {failed.map((f) => <div key={f.id} className="text-danger mt-1">✕ {f.label}: {f.message}</div>)}
            {failed.length > 0 && <button type="button" className="btn btn-link btn-sm px-0" onClick={() => clearFailed()}>{t("queue.clear")}</button>}
          </div>
        </div>
      )}
    </div>
  );
}
