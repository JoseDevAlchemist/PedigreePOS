import Dexie, { type EntityTable } from "dexie";

import type { PosRole } from "@/lib/auth";

/**
 * The till's local database.
 *
 * Everything the POS needs to make a sale lives here, because the network is
 * the unreliable part. Supabase is the record of what *has* happened; this is
 * the record of what the cashier is doing right now, and it never blocks on a
 * round trip.
 *
 * Six tables, keyed for the access patterns that matter:
 *
 *   products      — the catalogue, keyed by the Supabase uuid.
 *   pos_sales     — sales, keyed by `clientUuid`, which is also the idempotency
 *                   key the sync upserts on.
 *   local_returns — the till's own return ledger (added in v3). It survives the
 *                   queue row, so a return can be audited and repeat returns
 *                   can be prevented without the server.
 *   pos_users     — the staff roster, *including* the bcrypt hash, so a PIN can
 *                   be checked with no network. See the note in
 *                   012_pos.sql — this is a deliberate, documented tradeoff.
 *   sync_queue    — work owed to the server.
 *   till_sessions — cash-drawer shifts (added in v2): open float, close count
 *                   and the variance between them. Local-only.
 *
 * Sale lines and return lines are embedded in their parent row rather than kept
 * in their own table. On the server they are normalised (`pos_sale_items`,
 * `pos_return_items`) because reporting wants to query them; on the device
 * nothing ever queries a line independently, and embedding means a sale or
 * return and its lines are written in one transaction that can never half-fail.
 */

export type PosPaymentMethod = "cash" | "mpesa" | "card";

export interface LocalProduct {
  /** Supabase `products.id`. */
  id: string;
  name: string;
  slug: string;
  category: string;
  barcode: string | null;
  basePrice: number;
  discountPercent: number;
  /** The till's own count: already reduced by every sale, synced or not. */
  stockQuantity: number;
  active: boolean;
  /**
   * A URL or a resized data URL. Server photography is preferred; a
   * POS-created product keeps its local image because it is not uploaded.
   */
  imageUrl: string | null;
  /** When this row was last pulled from Supabase. */
  updatedAt: string;
  /** Colourway names, from the storefront or chosen on this till. */
  colors: string[];
  /** Whether the product may be published to the storefront. Defaults false. */
  isWebsitePublished: boolean;
  /**
   * The QR code / bag serial number the cashier scans at the counter. Optional
   * so pre-QR products keep selling exactly as before; the till and the sync
   * engine both carry it as `qr_code`.
   */
  qrCode?: string | null;
}

export interface LocalPosUser {
  id: string;
  name: string;
  /** bcrypt. Never a PIN. See lib/auth.ts. */
  pinHash: string;
  role: PosRole;
  active: boolean;
  /** When this row was last pulled from Supabase. */
  updatedAt: string;
}

export interface LocalSaleItem {
  /** Client-generated uuid; becomes `pos_sale_items.id`. */
  id: string;
  productId: string | null;
  /** Denormalised: a receipt reprinted later must show the name as sold. */
  productName: string;
  /**
   * `bag` or `shoe` at the time of sale, so the manager's per-category figures
   * do not change if the product is recategorised or delisted later. Null on
   * sales recorded before the till started carrying it — reporting falls back
   * to the local catalogue for those.
   */
  category: string | null;
  quantity: number;
  priceAtSale: number;
}

export interface LocalSale {
  /** Primary key, and the server's idempotency key (`pos_sales.client_uuid`). */
  clientUuid: string;
  cashierId: string | null;
  cashierName: string;
  subtotalKes: number;
  discountKes: number;
  discountPercent: number;
  totalKes: number;
  paymentMethod: PosPaymentMethod;
  amountTendered: number | null;
  changeDue: number | null;
  /**
   * M-Pesa for `mpesa`, the card terminal's slip reference for `card`, null for
   * cash. One free-text column on the server (`pos_sales.mpesa_code`) because
   * both are "the code the cashier read off the machine" and nothing queries
   * them apart.
   */
  paymentReference: string | null;
  createdAt: string;
  /** Null until the sync lands. */
  syncedAt: string | null;
  items: LocalSaleItem[];
}

export interface LocalReturnItem {
  productId: string;
  /** Denormalised: a return reprinted later must show the name as sold. */
  productName: string;
  quantity: number;
}

/**
 * A manager-approved return.
 *
 * The queue row is transient; this row is the local audit trail. It is written
 * in the same Dexie transaction as the stock increment and the queue entry, so
 * a crash cannot leave returned goods on the shelf with no record of why.
 *
 * `syncedAt` is stamped only after `pos_record_return` accepts the return.
 * Until then the ledger is also how `pendingStockByProduct()` knows the stock
 * delta a catalogue pull must preserve.
 */
export interface LocalReturn {
  /** Primary key, and the server's idempotency key (`pos_returns.client_uuid`). */
  clientUuid: string;
  originalSaleUuid: string | null;
  cashierId: string | null;
  cashierName: string;
  managerId: string;
  managerName: string;
  items: LocalReturnItem[];
  /** Whole shillings returned to the customer; zero for a stock-only return. */
  refundKes: number;
  refundMethod: PosPaymentMethod | null;
  /** M-Pesa code or card slip reference, when the refund had one. */
  refundReference: string | null;
  createdAt: string;
  /** Null until the sync lands. */
  syncedAt: string | null;
}

export interface LocalDiscount {
  id: string;
  code: string;
  percentage: number;
  active: boolean;
}

export type SyncQueueEntity = "sale" | "receipt_email" | "return" | "product" | "stock_adjustment";
export type SyncQueueStatus = "pending" | "error";

/**
 * A cash-drawer shift.
 *
 * Local-only for now: the pattern this app is built around is "write to the
 * device first", and a till session is no different. Nothing about opening a
 * drawer needs the network, so nothing about it blocks on one. Reconciling the
 * drawer to the server is a Phase 3 job.
 *
 * `expectedCash` and `variance` are stamped at close and kept, rather than
 * recomputed, so a manager reading a month later sees the shortage the cashier
 * was actually shown at the counter.
 */
export interface LocalTillSession {
  /** Auto-incrementing; a drawer shift is a log row, not an entity. */
  id?: number;
  openedAt: string;
  /** Name, not id: a deleted staff account must not blank a past shift. */
  openedBy: string;
  /** The float the drawer started with, in whole shillings. */
  openingFloat: number;
  closedAt: string | null;
  closedBy: string | null;
  /** Expected in the drawer at close: float + cash taken since open. */
  expectedCash: number | null;
  /** What the cashier counted. */
  countedCash: number | null;
  /** `counted − expected`: negative is short, positive is over. */
  variance: number | null;
}

export interface SyncQueueEntry {
  /** Auto-incrementing; the queue is a log, not an entity. */
  id?: number;
  entity: SyncQueueEntity;
  /** The `clientUuid` of the thing owed. */
  entityId: string;
  status: SyncQueueStatus;
  attempts: number;
  lastError: string | null;
  /** Extra arguments for the job — e.g. the receipt's email address. */
  payload: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Rebuild a ledger row from an old queue entry.
 *
 * v3 introduced `local_returns`, replacing the queue payload as the only copy
 * of a return. Existing tills may have pending returns when they upgrade, so
 * the version upgrade and the sync path both use this to adopt them without
 * losing the stock delta or the audit trail.
 */
export function localReturnFromQueueEntry(
  entry: SyncQueueEntry,
): LocalReturn | null {
  const payload = (entry.payload ?? {}) as Record<string, unknown>;
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const items: LocalReturnItem[] = [];

  for (const raw of rawItems) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const productId = asNonEmptyString(item.product_id);
    const productName = asNonEmptyString(item.product_name);
    const quantity = asPositiveInteger(item.quantity);
    if (productId === null || productName === null || quantity === null) {
      continue;
    }
    items.push({ productId, productName, quantity });
  }

  if (items.length === 0) return null;

  const method =
    payload.refund_method === "cash" ||
    payload.refund_method === "mpesa" ||
    payload.refund_method === "card"
      ? payload.refund_method
      : null;

  return {
    clientUuid: entry.entityId,
    originalSaleUuid: asNonEmptyString(payload.original_sale_id),
    cashierId: asNonEmptyString(payload.cashier_id),
    cashierName: asNonEmptyString(payload.cashier_name) ?? "",
    managerId: asNonEmptyString(payload.manager_id) ?? "",
    managerName: asNonEmptyString(payload.manager_name) ?? "",
    items,
    refundKes: asNonNegativeInteger(payload.refund_kes) ?? 0,
    refundMethod: method,
    refundReference: asNonEmptyString(payload.refund_reference),
    createdAt: entry.createdAt,
    syncedAt: null,
  };
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const integer = Math.floor(value);
  return integer > 0 ? integer : null;
}

function asNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

class PosDatabase extends Dexie {
  products!: EntityTable<LocalProduct, "id">;
  pos_sales!: EntityTable<LocalSale, "clientUuid">;
  local_returns!: EntityTable<LocalReturn, "clientUuid">;
  pos_users!: EntityTable<LocalPosUser, "id">;
  sync_queue!: EntityTable<SyncQueueEntry, "id">;
  till_sessions!: EntityTable<LocalTillSession, "id">;
  pos_discounts!: EntityTable<LocalDiscount, "id">;

  constructor() {
    super("pedigree-pos");

    // Indexes are declared, not derived from the interface. Only what is
    // filtered or sorted on is indexed: every index is write cost on a device
    // that is busy taking money. `name` and `barcode` are indexed because both
    // the search box and the scanner look products up by them.
    this.version(1).stores({
      products: "id, name, slug, barcode, category, active, updatedAt",
      pos_sales: "clientUuid, createdAt, syncedAt, paymentMethod",
      pos_users: "id, role, active",
      sync_queue: "++id, entity, entityId, status, createdAt",
    });

    // v2 adds the cash drawer. Only the new table is named; Dexie carries the
    // rest forward from v1 untouched, so an existing till upgrades in place
    // with no migration step and no lost sales.
    this.version(2).stores({
      till_sessions: "++id, openedAt, closedAt",
    });

    // v3 adds the returns ledger. A pending return created before this version
    // exists only as a queue payload; adopt it into the ledger during the
    // upgrade so the stock delta and the audit trail survive.
    this.version(3)
      .stores({
        local_returns: "clientUuid, originalSaleUuid, createdAt, syncedAt",
      })
      .upgrade(async (tx) => {
        const queued = await tx
          .table<SyncQueueEntry, number>("sync_queue")
          .where("entity")
          .equals("return")
          .toArray();
        const ledger = tx.table<LocalReturn, string>("local_returns");

        for (const entry of queued) {
          const localReturn = localReturnFromQueueEntry(entry);
          if (localReturn !== null) await ledger.put(localReturn);
        }
      });

    // v4 adds the QR code / bag serial number to the catalogue index, so a QR
    // scan resolves a product exactly like a barcode scan does. Only the index
    // is added; the column is optional on the row and the table carries forward.
    this.version(4).stores({
      products: "id, name, slug, barcode, qrCode, category, active, updatedAt",
    });

    this.version(5).stores({
      pos_discounts: "id, code, active",
    });
  }
}

/**
 * One connection per tab, created on first use.
 *
 * Lazy on purpose: this module is evaluated during the server render of every
 * client component that imports it, and `indexedDB` does not exist there.
 * Opening at import time would break the build; opening in an effect would mean
 * every caller racing to open. First call wins, the rest share it.
 */
let instance: PosDatabase | null = null;

export function getDb(): PosDatabase {
  if (instance === null) {
    instance = new PosDatabase();
  }
  return instance;
}

/** A uuid for a sale or a line. `crypto.randomUUID` needs a secure context —
 * localhost and HTTPS both qualify, which covers every till we ship to. */
export function newUuid(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
