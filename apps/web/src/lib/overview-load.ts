// Overview widgets on the free beta server. The dashboard opens at once from the store list
// saved on the tablet, so the Overview asks for its numbers while the server may still be asleep
// (or the tablet has no internet). That is not a failure: show the numbers saved last time, say
// the server is waking, and keep asking. Only a real "no" from the API counts as a failed load.

import { API_URL } from "../config";
import { adminHeaders, handleUnauthorized } from "./admin";
import { saveCopy, savedCopy } from "./offlineCache";
import { notFromApi } from "./wake-fetch";

export type Widget<T = unknown> =
  | { kind: "live"; data: T }
  | { kind: "saved"; data: T }
  | { kind: "waiting" }
  | { kind: "refused"; status: number }
  | { kind: "unauthorized" };

/** How long one ask waits before the saved numbers show instead. */
export const WIDGET_WAIT_MS = 10_000;
/** While the server wakes, ask again this often, this many times (~5 minutes). */
export const RETRY_EVERY_MS = 10_000;
export const MAX_RETRIES = 30;

export async function getWidget<T = unknown>(path: string, waitMs = WIDGET_WAIT_MS): Promise<Widget<T>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), waitMs);
  try {
    const res = await fetch(`${API_URL}${path}`, { headers: adminHeaders(), signal: ctl.signal });
    if (handleUnauthorized(res)) return { kind: "unauthorized" };
    if (res.ok) {
      const data = (await res.json()) as T;
      saveCopy(path, data);
      return { kind: "live", data };
    }
    if (!notFromApi(res)) return { kind: "refused", status: res.status };
  } catch {
    /* no internet, too slow, or the proxy's plain-text error: the server is not up yet */
  } finally {
    clearTimeout(timer);
  }
  const kept = savedCopy<T>(path);
  return kept !== null ? { kind: "saved", data: kept } : { kind: "waiting" };
}

export type Notice = { text: string; tone: "info" | "warning" | "danger"; askAgain: boolean };

/** The line above the Overview cards, or null when everything is live. */
export function overviewNotice(widgets: Widget[], { offline, tries }: { offline: boolean; tries: number }): Notice | null {
  const refused = widgets.filter((w) => w.kind === "refused") as { kind: "refused"; status: number }[];
  const notUp = widgets.filter((w) => w.kind === "saved" || w.kind === "waiting");
  if (refused.length === widgets.length) {
    return refused.every((w) => w.status === 403)
      ? { text: "Select a store from the switcher above to view its dashboard.", tone: "danger", askAgain: false }
      : { text: "Failed to load overview", tone: "danger", askAgain: false };
  }
  if (notUp.length > 0) {
    if (tries >= MAX_RETRIES) return { text: "The server is not answering yet. Tap Retry in a minute.", tone: "danger", askAgain: false };
    const hasSaved = notUp.some((w) => w.kind === "saved");
    const what = hasSaved ? "Showing the numbers saved on this tablet." : "Your numbers will show in a moment.";
    return offline
      ? { text: `No internet. ${what}`, tone: "warning", askAgain: true }
      : { text: `Connecting to the server… ${what}`, tone: "info", askAgain: true };
  }
  if (refused.length > 0) return { text: "Some widgets couldn't load — showing what's available.", tone: "warning", askAgain: false };
  return null;
}
