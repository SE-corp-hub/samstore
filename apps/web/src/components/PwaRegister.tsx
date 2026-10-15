"use client";

// Rice Ops M10 — install to the home screen: register the service worker (production
// builds only, so development never serves stale screens).
import { useEffect } from "react";

export default function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => { /* the app still works without it */ });
  }, []);
  return null;
}
