/**
 * East Africa Time (UTC+3).
 *
 * Every "today" figure on the manager dashboard is a Nairobi day, not the day
 * the till's clock happens to be in. A terminal in UTC — a server render, a
 * Windows box left on the wrong timezone, a browser reporting UTC — would
 * otherwise file an 11pm sale under tomorrow, and two people checking the same
 * afternoon would read two different totals.
 *
 * Kenya has never observed daylight saving, so the offset is a constant and the
 * arithmetic below is exact rather than approximate. If that ever changes, this
 * is the one file to move to an `Intl`/tz-database lookup.
 */

export const EAT_TIME_ZONE = "Africa/Nairobi";

/** +03:00 in milliseconds. */
export const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The EAT calendar date for an instant, as `YYYY-MM-DD`.
 *
 * Shift the instant by the offset and read the UTC fields: what UTC calls the
 * date after adding three hours is what a Nairobi wall clock calls today.
 */
export function eatDayKey(now: Date = new Date()): string {
  return new Date(now.getTime() + EAT_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The half-open UTC window `[start, end)` that a Nairobi day covers.
 *
 * Used directly against the `pos_sales.createdAt` index: sales are stored as
 * UTC ISO strings, so the boundary has to be converted rather than the rows.
 */
export function eatDayRange(now: Date = new Date()): { start: Date; end: Date } {
  const key = eatDayKey(now);
  const [year, month, day] = key.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, day) - EAT_OFFSET_MS);
  const end = new Date(start.getTime() + MS_PER_DAY);
  return { start, end };
}

const EAT_DATE = new Intl.DateTimeFormat("en-KE", {
  timeZone: EAT_TIME_ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** `Sat, 17 Oct 2026`, in Nairobi. For the dashboard heading. */
export function formatEatDate(value: string | number | Date): string {
  return EAT_DATE.format(new Date(value));
}

const EAT_DATE_TIME = new Intl.DateTimeFormat("en-KE", {
  timeZone: EAT_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * The same wall-clock format as `formatDateTime`, pinned to Nairobi.
 *
 * A receipt handed to a customer in Nairobi must read the shop's time even if
 * the till is misconfigured, so receipts and the dashboard share this one.
 */
export function formatEatDateTime(value: string | number | Date): string {
  return EAT_DATE_TIME.format(new Date(value));
}
