/**
 * Money and date formatting for the till.
 *
 * Copied from the storefront's `lib/format.ts` so a price reads identically in
 * both apps, and extended with the date/time formats a receipt needs.
 */

const GROUPED = new Intl.NumberFormat("en-KE", {
  maximumFractionDigits: 0,
  useGrouping: true,
});

/**
 * `KES 12,500`.
 *
 * Built from a locale formatter plus an explicit prefix rather than
 * `style: "currency"`, because the symbol varies by locale ("KSh" in en-KE) and
 * the house style is the literal `KES`.
 */
export function formatPrice(amount: number): string {
  return `KES ${GROUPED.format(Math.round(amount))}`;
}

/** Just the digits, for the numeric column of a receipt. */
export function formatAmount(amount: number): string {
  return GROUPED.format(Math.round(amount));
}

/**
 * Price after a percentage discount. Exact — no rounding to the nearest 50, so
 * the line total always reconciles with the percentage shown beside it.
 */
export function calculateDiscountedPrice(
  basePrice: number,
  discountPercent: number,
): number {
  if (discountPercent <= 0) return basePrice;
  return basePrice - calculateDiscountAmount(basePrice, discountPercent);
}

export function calculateDiscountAmount(
  basePrice: number,
  discountPercent: number,
): number {
  if (discountPercent <= 0) return 0;
  return (basePrice * discountPercent) / 100;
}

export function hasDiscount(discountPercent: number): boolean {
  return discountPercent > 0 && discountPercent < 100;
}

/** The price actually charged. Stored per line so a later price change cannot
 * silently reprice a cart that is already rung up. */
export function effectivePrice(
  basePrice: number,
  discountPercent: number,
): number {
  return hasDiscount(discountPercent)
    ? calculateDiscountedPrice(basePrice, discountPercent)
    : basePrice;
}

/** Round to whole shillings. Every stored amount goes through this. */
export function toWholeShillings(amount: number): number {
  return Math.round(amount);
}

/**
 * Receipt timestamps. `en-KE` 24-hour, e.g. `17/10/2026, 14:32`.
 * Deliberately not relative ("2 minutes ago"): a receipt is a legal-ish record
 * and a wall-clock stamp is what a customer can check against their phone.
 */
const DATE_TIME = new Intl.DateTimeFormat("en-KE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatDateTime(value: string | number | Date): string {
  return DATE_TIME.format(new Date(value));
}

const TIME_ONLY = new Intl.DateTimeFormat("en-KE", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatTime(value: string | number | Date): string {
  return TIME_ONLY.format(new Date(value));
}

/** `1 item` / `3 items`. Keeps the cart footer from reading "3 item(s)". */
export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}
