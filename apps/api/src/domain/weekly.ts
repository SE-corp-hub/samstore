// Weekly owner summary: pure date and percent helpers.

const DAY = 86_400_000;
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

export interface WeekRanges {
  thisFrom: string;
  thisTo: string;
  lastFrom: string;
  lastTo: string;
}

/** The 7 days ending on `endDate` (inclusive), and the 7 days before them. Throws on a date that is not YYYY-MM-DD. */
export function weekRanges(endDate: string): WeekRanges {
  if (!isDay(endDate)) throw new Error("Wrong date");
  const thisFrom = addDays(endDate, -6);
  return { thisFrom, thisTo: endDate, lastFrom: addDays(thisFrom, -7), lastTo: addDays(thisFrom, -1) };
}

/** Percent change from last to this, one decimal; null when there was nothing last time to compare with. */
export function changePct(thisValue: number, lastValue: number): number | null {
  if (!(lastValue > 0)) return null;
  return Math.round(((thisValue - lastValue) / lastValue) * 1000) / 10;
}

/** Whole days from a past moment to now (rounded down); null when there is no such moment. */
export function daysSince(then: Date | null | undefined, now: Date): number | null {
  if (!then) return null;
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / DAY));
}
