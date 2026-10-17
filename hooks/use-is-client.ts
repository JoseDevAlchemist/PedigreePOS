"use client";

import { useSyncExternalStore } from "react";

/**
 * `false` on the server and during hydration, `true` once the client owns the
 * tree.
 *
 * For the small class of components that cannot render until there is a DOM —
 * a portal is the one here — and that therefore have to know *when* that is.
 * An effect setting a `mounted` flag does the same job, but it renders twice
 * and cascades; `useSyncExternalStore` is the supported way to ask React
 * itself, and it answers in the same commit as hydration.
 *
 * There is no external system to subscribe to, so the subscription is a no-op.
 * The snapshot is a constant, which is what keeps React from seeing a change on
 * every render.
 */

const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

export function useIsClient(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
