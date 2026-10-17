"use client";

import { useEffect } from "react";

import { startAutoSync } from "@/lib/sync";

/**
 * Starts automatic syncing for the whole app.
 *
 * Rendered once, near the root. It draws nothing: mounting it only wires up the
 * `online`/`offline` listeners and the retry interval, and unmounting takes them
 * back down (which matters under React Strict Mode's double-invoke in dev —
 * without the teardown you would stack two intervals on every remount).
 */
export function SyncProvider() {
  useEffect(() => startAutoSync(), []);
  return null;
}
