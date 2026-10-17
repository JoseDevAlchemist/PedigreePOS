"use client";

import { useLiveQuery } from "dexie-react-hooks";

import { getDb, type LocalProduct } from "@/lib/db";

/**
 * The local catalogue, live.
 *
 * `useLiveQuery` re-runs the querier whenever IndexedDB changes, so a sync that
 * lands mid-shift updates the grid without anyone refreshing. The querier is
 * only ever invoked from an effect — never during render — which is what keeps
 * this safe to prerender on a server that has no `indexedDB`.
 */
export function useProducts(): LocalProduct[] {
  return useLiveQuery(
    () => getDb().products.orderBy("name").toArray(),
    [],
    [] as LocalProduct[],
  );
}
