// The beta server sleeps when nobody uses it and takes up to a minute or more to wake.
// While it wakes, the request fails before it reaches the API: Render answers 502/503/504,
// the web site's /backend proxy gives up with a plain-text 500 "Internal Server Error",
// or the request fails outright. For the first calls of a visit (log in, load my stores),
// keep asking for up to ~2 minutes instead of showing an error, and say what is happening.

const WAKING = new Set([502, 503, 504]);

export const isWaking = (status: number) => WAKING.has(status);

/** True when the answer did not come from the API itself (it stamps every answer with X-Request-Id). */
export const notFromApi = (res: Response) => isWaking(res.status) || (res.status >= 500 && !res.headers.get("x-request-id"));

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
    await sleep(everyMs);
  }
}
