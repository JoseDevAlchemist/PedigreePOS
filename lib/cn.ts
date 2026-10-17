import { clsx, type ClassValue } from "clsx";

/**
 * Conditional class names.
 *
 * `clsx` and nothing else — no `tailwind-merge`. The components here take a
 * `className` only where a caller needs to adjust layout, and in those places
 * the caller's class is meant to win, so there is nothing to reconcile.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
