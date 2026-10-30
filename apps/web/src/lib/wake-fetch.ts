// The beta server sleeps when nobody uses it and takes up to a minute or more to wake.
// While it wakes, the request fails before it reaches the API: Render answers 502/503/504,
// the web site's /backend proxy gives up with a plain-text 500 "Internal Server Error",
// or the request fails outright. For the first calls of a visit (log in, load my stores),
// keep asking for up to ~2 minutes instead of showing an error, and say what is happening.

import { API_DIRECT_URL } from "../config";

const WAKING = new Set([502, 503, 504]);

export const isWaking = (status: number) => WAKING.has(status);

/**
 * True when the answer did not come from the API itself (it stamps every answer with X-Request-Id).
 * Render also answers a sleeping service with 429 "Too Many Requests" (x-render-routing:
 * hibernate-rate-limited) when it is asked too often while asleep: that is waking, not a refusal.
 */
export const notFromApi = (res: Response) => isWaking(res.status) || ((res.status >= 500 || res.status === 429) && !res.headers.get("x-request-id"));

/** How often, at most, the tablet knocks on the sleeping API directly. */
export const WAKE_EVERY_MS = 20_000;
let lastWake = 0;

/**
 * Wake the API straight from the tablet. While it sleeps, Render answers the calls that come
 * through the web server's /backend proxy with an instant 429 and never wakes it, so the top bar
 * said "Connecting to server…" for an hour. A visit to its own address wakes it in about a minute.
 * The answer is not read (no-cors); the next check finds out whether it is awake.
 */
export function wakeApi(now = Date.now(), base = API_DIRECT_URL): void {
  if (!base || now - lastWake < WAKE_EVERY_MS) return;
  lastWake = now;
  void fetch(`${base}/health?wake=${now}`, { mode: "no-cors", cache: "no-store" }).catch(() => undefined);
}

export async function wakeFetch(
  url: string,
  init: RequestInit | undefined,
  onWaiting: (waiting: boolean) => void,
  { tries = 24, everyMs = 5_000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) } = {},
): Promise<Response> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, init);
      if (!notFromApi(res) || i >= tries) { onWaiting(false); return res; }
    } catch (e) {
      if (i >= tries) { onWaiting(false); throw e; }
    }
    onWaiting(true);
    wakeApi();
    await sleep(everyMs);
  }
}
