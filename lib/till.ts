"use client";

import { getDb, nowIso, type LocalTillSession } from "@/lib/db";
import { toWholeShillings } from "@/lib/format";

/**
 * The cash drawer.
 *
 * Opening a drawer and closing one are separate acts around a shift, and the
 * interesting number is the one only the shop can produce: `counted − expected`
 * at close. The till keeps the whole story — float, the cash taken since open,
 * what was counted and the difference — because a shortage is something a
 * manager has to be able to look at the next morning.
 *
 * Local-only, like everything else the till writes. Opening a drawer has no
 * reason to touch the network, so it does not, and the counter keeps moving
 * during an outage.
 */

/** The open shift, or null. Newest first, in case a close was ever missed. */
export async function getOpenTill(): Promise<LocalTillSession | null> {
  const db = getDb();
  // `closedAt` is not indexed: IndexedDB cannot index null, and an open shift
  // is exactly the row with `closedAt === null`. The table is a handful of rows
  // per day, so a scan is the right cost.
  const open = await db.till_sessions
    .filter((session) => session.closedAt === null)
    .toArray();
  if (open.length === 0) return null;
  return open[open.length - 1] ?? null;
}

/** Recent shifts, newest first, for the dashboard's history line. */
export async function getRecentTills(limit = 5): Promise<LocalTillSession[]> {
  return getDb().till_sessions.orderBy("openedAt").reverse().limit(limit).toArray();
}

export async function openTill(input: {
  openingFloat: number;
  openedBy: string;
}): Promise<LocalTillSession> {
  const existing = await getOpenTill();
  if (existing !== null) {
    throw new Error("A till is already open. Close it before opening another.");
  }

  const session: LocalTillSession = {
    openedAt: nowIso(),
    openedBy: input.openedBy,
    openingFloat: toWholeShillings(input.openingFloat),
    closedAt: null,
    closedBy: null,
    expectedCash: null,
    countedCash: null,
    variance: null,
  };

  const id = await getDb().till_sessions.add(session);
  return { ...session, id };
}

/**
 * What should be in the drawer: the float plus every cash sale since opening,
 * less every cash refund paid out of it.
 *
 * Cash only, on purpose — an M-Pesa payment never enters the drawer, and
 * counting it here is how a close comes up mysteriously "over" by the day's
 * mobile money. A cash refund leaves the drawer, so ignoring it would make the
 * close look short by exactly the money the manager handed back.
 */
export async function getExpectedCash(till: LocalTillSession): Promise<number> {
  const upper = till.closedAt ?? nowIso();
  const db = getDb();
  const cashSales = await db.pos_sales
    .where("createdAt")
    .between(till.openedAt, upper, true, true)
    .and((sale) => sale.paymentMethod === "cash")
    .toArray();
  const cashRefunds = await db.local_returns
    .where("createdAt")
    .between(till.openedAt, upper, true, true)
    .and((record) => record.refundMethod === "cash" && record.refundKes > 0)
    .toArray();

  const cashTaken = cashSales.reduce((sum, sale) => sum + sale.totalKes, 0);
  const cashReturned = cashRefunds.reduce(
    (sum, record) => sum + record.refundKes,
    0,
  );
  return till.openingFloat + cashTaken - cashReturned;
}

/**
 * Close the open shift against a physical count.
 *
 * `expectedCash` and `variance` are written down rather than recomputed later,
 * so the number shown to the cashier at the counter is the number a manager
 * sees afterwards, even if a sale is voided or synced in between.
 */
export async function closeTill(input: {
  countedCash: number;
  closedBy: string;
}): Promise<LocalTillSession> {
  const db = getDb();
  const open = await getOpenTill();
  if (open === null || open.id === undefined) {
    throw new Error("No till is open.");
  }

  const expectedCash = await getExpectedCash(open);
  const countedCash = toWholeShillings(input.countedCash);
  const closedAt = nowIso();

  await db.till_sessions.update(open.id, {
    closedAt,
    closedBy: input.closedBy,
    expectedCash,
    countedCash,
    variance: countedCash - expectedCash,
  });

  return {
    ...open,
    closedAt,
    closedBy: input.closedBy,
    expectedCash,
    countedCash,
    variance: countedCash - expectedCash,
  };
}
