// The beta server sleeps when nobody uses it and takes about half a minute to wake.
// While it wakes, the web site's /backend route answers 502/503/504 at once (or the
// request fails outright). For the first calls of a visit (log in, load my stores),
// keep asking for up to ~75 s instead of showing an error, and say what is happening.

const WAKING = new Set([502, 503, 504]);

export const isWaking = (status: number) => WAKING.has(status);

export async function wakeFetch(
  url: string,
  init: RequestInit | undefined,
  onWaiting: (waiting: boolean) => void,
  { tries = 15, everyMs = 5_000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) } = {},
): Promise<Response> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, init);
      if (!isWaking(res.status) || i >= tries) { onWaiting(false); return res; }
    } catch (e) {
      if (i >= tries) { onWaiting(false); throw e; }
    }
    onWaiting(true);
    await sleep(everyMs);
  }
}
