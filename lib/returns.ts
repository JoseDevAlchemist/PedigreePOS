"use client";

import { getDb, newUuid, nowIso, type LocalSale } from "@/lib/db";
import { addSyncQueueEntry } from "@/lib/sync";

/**
 * Recording a return.
 *
 * A return is a stock correction: the goods came back across the counter, so
 * the till's own count goes back up. It is recorded locally first and queued
 * for Supabase, exactly like a sale. Nothing here waits on the network.
 *
 * A return always needs a manager's approval — that is enforced by the caller
 * (the return flow verifies a manager PIN before this is invoked) — and the
 * approving manager is stamped on the queue entry so the server can audit it.
 */

export interface ReturnItem {
  productId: string;
  productName: string;
  quantity: number;
}

export interface RecordReturnInput {
  /** The sale the goods came from, if returning against a receipt. */
  originalSale: LocalSale | null;
  /** The items being returned. */
  items: ReturnItem[];
  /** The cashier whose sale is being returned. */
  cashierId: string | null;
  cashierName: string;
  /** The manager who approved the return (the current session). */
  managerId: string;
  managerName: string;
}

export async function recordReturn(input: RecordReturnInput): Promise<string> {
  const db = getDb();
  const returnUuid = newUuid();
  const now = nowIso();

  await db.transaction(
    "rw",
    db.products,
    db.sync_queue,
    async () => {
      // Put the stock back on the shelf. A returned line may reference a
      // product that has since been delisted; missing products are skipped
      // rather than failing the whole return.
      for (const item of input.items) {
        const product = await db.products.get(item.productId);
        if (product === undefined) continue;
        await db.products.update(item.productId, {
          stockQuantity: product.stockQuantity + item.quantity,
        });
      }

      await addSyncQueueEntry({
        entity: "return",
        entityId: returnUuid,
        payload: {
          original_sale_id: input.originalSale?.clientUuid ?? null,
          cashier_id: input.cashierId,
          cashier_name: input.cashierName,
          manager_id: input.managerId,
          manager_name: input.managerName,
          items: input.items.map(({ productId, productName, quantity }) => ({
            product_id: productId,
            product_name: productName,
            quantity,
          })),
        },
        createdAt: now,
        updatedAt: now,
      });
    },
  );

  return returnUuid;
}

/** Increase stock locally for an already-synced return (idempotent replay). */
export async function applyReturnLocally(items: ReturnItem[]): Promise<void> {
  const db = getDb();
  for (const item of items) {
    const product = await db.products.get(item.productId);
    if (product === undefined) continue;
    await db.products.update(item.productId, {
      stockQuantity: product.stockQuantity + item.quantity,
    });
  }
}
