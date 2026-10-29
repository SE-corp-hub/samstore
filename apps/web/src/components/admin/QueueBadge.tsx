"use client";

// Rice Ops M10 + offline store mode — what is waiting on this tablet, shown on the screen
// (no pop-ups):
//   * QueueBadge (top bar): always shows Online or Offline.
//   * SyncBar (under the top bar): "3 records saved on this tablet" with an "Upload now" button,
//     the result of the last upload, and anything the server refused (with the reason),
//     so nothing silently disappears. Waiting records still upload by themselves too.

import { useEffect, useState } from "react";
import { clearFailed, failedSteps, flushQueue, QUEUE_EVENT, queuedSteps, startQueue, type FailedStep, type QueuedStep } from "../../lib/offlineQueue";
import { useLang } from "../../lib/lang";
import { isOffline, OFFLINE_EVENT } from "../../lib/offlineCache";

function useSync() {
  const [waiting, setWaiting] = useState<QueuedStep[]>([]);
  const [failed, setFailed] = useState<FailedStep[]>([]);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const refresh = () => { setWaiting(queuedSteps()); setFailed(failedSteps()); setOffline(isOffline()); };
    const events = [QUEUE_EVENT, OFFLINE_EVENT, "storage", "online", "offline"];
    refresh();
    startQueue();
    for (const e of events) window.addEventListener(e, refresh);
    return () => { for (const e of events) window.removeEventListener(e, refresh); };
  }, []);
  return { waiting, failed, offline };
}

/** Top bar: Online / Offline, always visible. */
export default function QueueBadge() {
  const { t } = useLang();
  const { offline } = useSync();
  return offline ? (
    <span className="badge rounded-pill text-bg-danger fs-6 px-3 py-2" role="status"><i className="bi bi-wifi-off me-1"></i>{t("sync.offline")}</span>
  ) : (
    <span className="badge rounded-pill text-bg-success px-3 py-2" role="status"><i className="bi bi-wifi me-1"></i>{t("sync.online")}</span>
  );
}

/** Under the top bar: records waiting on this tablet and the "Upload now" button. */
export function SyncBar() {
  const { t } = useLang();
  const { waiting, failed, offline } = useSync();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [details, setDetails] = useState(false);

  // An earlier result goes away once something new is waiting.
  useEffect(() => { if (waiting.length > 0 && !busy) setResult(null); }, [waiting.length, busy]);

  const upload = async () => {
    setBusy(true); setResult(null);
    const r = await flushQueue();
    setBusy(false);
    const left = queuedSteps().length;
    setResult(left === 0 ? t("sync.done", { n: r.sent }) : t("sync.notYet", { n: left }));
  };

  if (waiting.length === 0 && failed.length === 0 && !result) return null;
  return (
    <div className="px-3 pt-2">
      {waiting.length > 0 && (
        <div className={`alert ${offline ? "alert-secondary" : "alert-warning"} d-flex flex-wrap align-items-center gap-2 py-2 mb-2`} role="status">
          <i className={`bi ${offline ? "bi-wifi-off" : "bi-cloud-arrow-up"} fs-4`}></i>
          <div className="flex-grow-1">
            <div className="fw-semibold">{t("sync.waiting", { n: waiting.length })}</div>
            <div className="small">{offline ? t("sync.whenWifi") : t("sync.auto")}</div>
          </div>
          <button type="button" className="btn btn-link btn-sm" onClick={() => setDetails(!details)}>{details ? t("sync.hide") : t("sync.show")}</button>
          <button type="button" className="btn btn-dark btn-lg" disabled={busy || (typeof navigator !== "undefined" && navigator.onLine === false)} onClick={() => void upload()}>
            {busy ? <><span className="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>{t("sync.uploading")}</> : <><i className="bi bi-cloud-arrow-up me-1"></i>{t("sync.upload")}</>}
          </button>
          {details && (
            <div className="w-100 small">
              {waiting.map((s) => <div key={s.id}>⏳ {s.label} · {new Date(s.createdAt).toLocaleTimeString("en-PH")}</div>)}
            </div>
          )}
        </div>
      )}
      {result && waiting.length === 0 && (
        <div className="alert alert-success d-flex align-items-center gap-2 py-2 mb-2" role="status">
          <i className="bi bi-check-circle fs-4"></i><div className="flex-grow-1 fw-semibold">{result}</div>
          <button type="button" className="btn-close" aria-label="Close" onClick={() => setResult(null)}></button>
        </div>
      )}
      {result && waiting.length > 0 && !busy && <div className="small text-danger mb-2">{result}</div>}
      {failed.length > 0 && (
        <div className="alert alert-danger py-2 mb-2" role="alert">
          <div className="fw-semibold">{t("queue.failed")} ({failed.length})</div>
          {failed.map((f) => <div key={f.id} className="small">✕ {f.label}: {f.message}</div>)}
          <button type="button" className="btn btn-link btn-sm px-0" onClick={() => clearFailed()}>{t("queue.clear")}</button>
        </div>
      )}
    </div>
  );
}
