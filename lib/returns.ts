"use client";

import {
  getDb,
  newUuid,
  nowIso,
  type LocalReturn,
  type LocalSale,
  type PosPaymentMethod,
} from "@/lib/db";
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
 * approving manager is stamped on the ledger and the queue entry so the server
 * can audit it.
 *
 * The ledger row is the durable local record. The queue row is only the work
 * owed to the server, so it is deleted once the push succeeds; the ledger row
 * stays behind with `syncedAt` set.
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
  /** Whole shillings handed back. Zero means a stock-only return. */
  refundKes: number;
  refundMethod: PosPaymentMethod | null;
  refundReference: string | null;
}

export async function recordReturn(input: RecordReturnInput): Promise<string> {
  const managerId = input.managerId.trim();
  if (managerId.length === 0) {
    throw new Error("A manager must approve the return.");
  }

  const items = normaliseItems(input.items);
  const refundKes = normaliseRefund(input.refundKes);
  const refundMethod = normaliseRefundMethod(refundKes, input.refundMethod);
  const refundReference =
    refundKes > 0 && refundMethod !== null && refundMethod !== "cash"
      ? (input.refundReference?.trim() || null)
      : null;

  const db = getDb();
  const returnUuid = newUuid();
  const now = nowIso();

  await db.transaction(
    "rw",
    db.products,
    db.local_returns,
    db.sync_queue,
    async () => {
      // A sale can only give back what it sold, and only once. The check and
      // the ledger write share a transaction, so two tabs cannot both decide
      // there is one unit left and return it twice.
      if (input.originalSale !== null) {
        const soldByProduct = quantitiesByProduct(input.originalSale);
        const previous = await db.local_returns
          .where("originalSaleUuid")
          .equals(input.originalSale.clientUuid)
          .toArray();
        const returnedByProduct = new Map<string, number>();
        for (const record of previous) {
          for (const item of record.items) {
            returnedByProduct.set(
              item.productId,
              (returnedByProduct.get(item.productId) ?? 0) + item.quantity,
            );
          }
        }

        for (const item of items) {
          const sold = soldByProduct.get(item.productId);
          if (sold === undefined) {
            throw new Error(
              `${item.productName} was not sold on this sale.`,
            );
          }
          const alreadyReturned = returnedByProduct.get(item.productId) ?? 0;
          const remaining = Math.max(0, sold - alreadyReturned);
          if (item.quantity > remaining) {
            throw new Error(
              remaining === 0
                ? `${item.productName} has already been fully returned.`
                : `Only ${remaining} of ${sold} ${sold === 1 ? "unit" : "units"} of ${item.productName} can still be returned.`,
            );
          }
        }
      }

      // Put the stock back on the shelf. A returned line may reference a
      // product that has since been delisted; missing products are skipped
      // rather than failing the whole return.
      for (const item of items) {
        const product = await db.products.get(item.productId);
        if (product === undefined) continue;
        await db.products.update(item.productId, {
          stockQuantity: product.stockQuantity + item.quantity,
        });
      }

      const localReturn: LocalReturn = {
        clientUuid: returnUuid,
        originalSaleUuid: input.originalSale?.clientUuid ?? null,
        cashierId: input.cashierId,
        cashierName: input.cashierName,
        managerId,
        managerName: input.managerName,
        items,
        refundKes,
        refundMethod,
        refundReference,
        createdAt: now,
        syncedAt: null,
      };
      await db.local_returns.add(localReturn);

      await addSyncQueueEntry({
        entity: "return",
        entityId: returnUuid,
        payload: {
          original_sale_id: localReturn.originalSaleUuid,
          cashier_id: localReturn.cashierId,
          cashier_name: localReturn.cashierName,
          manager_id: localReturn.managerId,
          manager_name: localReturn.managerName,
          items: localReturn.items.map(({ productId, productName, quantity }) => ({
            product_id: productId,
            product_name: productName,
            quantity,
          })),
          refund_kes: localReturn.refundKes,
          refund_method: localReturn.refundMethod,
          refund_reference: localReturn.refundReference,
        },
        createdAt: now,
        updatedAt: now,
      });
    },
  );

  return returnUuid;
}

function normaliseItems(input: ReturnItem[]): ReturnItem[] {
  const byProduct = new Map<string, ReturnItem>();

  for (const item of input) {
    const productId = item.productId.trim();
    if (productId.length === 0) {
      throw new Error("A return line is missing its product.");
    }

    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new Error("A return quantity must be a whole number of at least one unit.");
    }
    const quantity = item.quantity;

    // Two lines for one product would make the stock update and the audit
    // harder to reason about. The server aggregates them too; do it once here.
    const existing = byProduct.get(productId);
    if (existing !== undefined) {
      existing.quantity += quantity;
    } else {
      byProduct.set(productId, {
        productId,
        productName: item.productName.trim() || "Unknown product",
        quantity,
      });
    }
  }

  if (byProduct.size === 0) {
    throw new Error("A return must include at least one item.");
  }

  return Array.from(byProduct.values());
}

function normaliseRefund(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("A refund cannot be negative.");
  }
  return Math.round(value);
}

function normaliseRefundMethod(
  refundKes: number,
  method: PosPaymentMethod | null,
): PosPaymentMethod | null {
  if (refundKes === 0) return null;
  if (method === null) {
    throw new Error("Choose how the refund was paid.");
  }
  if (method !== "cash" && method !== "mpesa" && method !== "card") {
    throw new Error("The refund method must be cash, M-Pesa or card.");
  }
  return method;
}

function quantitiesByProduct(sale: LocalSale): Map<string, number> {
  const byProduct = new Map<string, number>();
  for (const item of sale.items) {
    if (item.productId === null) continue;
    byProduct.set(
      item.productId,
      (byProduct.get(item.productId) ?? 0) + item.quantity,
    );
  }
  return byProduct;
}
