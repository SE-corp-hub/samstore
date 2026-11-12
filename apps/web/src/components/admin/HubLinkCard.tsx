"use client";

// Facebook orders (SE Corp Hub link) on the Orders screen: one quiet line while the link works, and a clear card
// when it doesn't: the hub can't be reached, or an order from a Page is waiting because this store can't take it
// yet (no stock, or the item's name here doesn't match). Staff fix it here and press "Check now".
// Nothing shows for a store with no hub link.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";

interface Stuck { key: string; ref: string; page: string; customer: string; items: string; error: string; since: string }
interface Status { on: boolean; lastTryAt: string | null; lastOkAt: string | null; lastError: string | null; stuck: Stuck[] }

const ago = (iso: string | null): string => {
  if (!iso) return "not yet";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

export default function HubLinkCard({ offline, onPlaced }: { offline: boolean; onPlaced?: () => void }) {
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = useCallback(async (check: boolean) => {
    try {
      const res = await fetch(`${API_URL}/admin/hub/${check ? "check" : "status"}`, { method: check ? "POST" : "GET", headers: adminHeaders() });
      if (res.ok) setSt((await res.json()) as Status);
    } catch { /* offline or waking: keep what is shown */ }
  }, []);

  useEffect(() => {
    if (offline) return;
    void ask(false);
    const t = setInterval(() => { if (document.visibilityState === "visible") void ask(false); }, 30_000);
    return () => clearInterval(t);
  }, [ask, offline]);

  if (offline || !st?.on) return null;

  const checkNow = async () => {
    setBusy(true);
    const before = st.stuck.length;
    await ask(true);
    setBusy(false);
    if (before > 0) onPlaced?.();
  };

  // Not answered for 3 minutes (the beat is every few seconds): say so, even with no error text yet.
  const stale = !st.lastOkAt || Date.now() - new Date(st.lastOkAt).getTime() > 180_000;
  const down = !!st.lastError || (stale && !!st.lastTryAt);
  if (!down && st.stuck.length === 0) {
    return (
      <p className="hub-link-ok mb-2" role="status">
        <i className="bi bi-facebook me-1" aria-hidden="true"></i>
        Facebook orders: linked. Last check {ago(st.lastOkAt)}.
      </p>
    );
  }

  return (
    <section className="hub-link-card mb-3" aria-label="Facebook orders" role="status">
      {down && (
        <p className="mb-2">
          <i className="bi bi-exclamation-triangle-fill me-2" aria-hidden="true"></i>
          <strong>Facebook orders are not coming in.</strong>{" "}
          {st.lastError ?? "The hub has not answered for a while."} Last worked {ago(st.lastOkAt)}.
        </p>
      )}
      {st.stuck.length > 0 && (
        <>
          <p className="mb-2">
            <i className="bi bi-hourglass-split me-2" aria-hidden="true"></i>
            <strong>{st.stuck.length === 1 ? "1 Facebook order is waiting" : `${st.stuck.length} Facebook orders are waiting`}.</strong>{" "}
            They are not in the list below yet. Fix the reason, then press Check now.
          </p>
          <ul className="hub-stuck-list">
            {st.stuck.map((o) => (
              <li key={o.key}>
                <div className="fw-bold">{o.customer || "Customer"} · {o.page} {o.ref}</div>
                <div>{o.items}</div>
                <div className="hub-stuck-why">{o.error}</div>
                <div className="text-muted small">Waiting since {ago(o.since)}</div>
              </li>
            ))}
          </ul>
        </>
      )}
      <button type="button" className="btn btn-dark fw-bold" onClick={() => void checkNow()} disabled={busy}>
        <i className={`bi bi-arrow-repeat me-1 ${busy ? "spin" : ""}`} aria-hidden="true"></i>
        {busy ? "Checking…" : "Check now"}
      </button>
    </section>
  );
}
