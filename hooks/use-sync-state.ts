"use client";

import { useSyncExternalStore } from "react";

import { getSyncState, subscribeSyncState } from "@/lib/sync";

/**
 * Subscribe the component to the sync store.
 *
 * `getSyncState` is passed as the server snapshot too: during prerender the
 * store holds its initial value, and that exact reference is what the client
 * hydrates against, so the two agree.
 */
export function useSyncState() {
  return useSyncExternalStore(subscribeSyncState, getSyncState, getSyncState);
}
