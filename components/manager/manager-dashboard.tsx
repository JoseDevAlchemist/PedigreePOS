"use client";

import { useLiveQuery } from "dexie-react-hooks";
import {
  AlertTriangle,
  ArrowDownToLine,
  Banknote,
  CloudUpload,
  CreditCard,
  PackageSearch,
  ReceiptText,
  RefreshCcw,
  RefreshCw,
  ShoppingBag,
  Smartphone,
  SportShoe,
  Wallet,
} from "lucide-react";

import { AppHeader } from "@/components/app-header";
import { CashDrawer } from "@/components/manager/cash-drawer";
import { ManagerNav } from "@/components/manager/manager-nav";
import { NetworkStatus } from "@/components/network-status";
import { SyncProvider } from "@/components/sync-provider";
import { useSyncState } from "@/hooks/use-sync-state";
import type { PosPaymentMethod } from "@/lib/db";
import { getDb, type LocalProduct, type LocalSale } from "@/lib/db";
import { formatAmount, formatTime, pluralize } from "@/lib/format";
import { getDailyTotals, getRecentSales } from "@/lib/sales";
import { fetchProducts, runSync } from "@/lib/sync";
import { formatEatDate } from "@/lib/time";

/**
 * The manager's view.
 *
 * Everything on this page is read from the local database, never from Supabase.
 * That is not a limitation to work around — it is the point. A manager checking
 * the day's takings during an outage must see the same numbers as one checking
 * while online, and the local database is the only place that holds *every* sale
 * including the ones the server has not seen yet.
 *
 * "Today" is an East Africa Time day (see lib/time.ts), so the figures do not
 * shift when the till's clock is on the wrong side of midnight UTC.
 *
 * Sales that have not synced are marked, so an unsynced total is never mistaken
 * for a final one.
 */

/** Below this, a product earns a manager's attention. At this, it is urgent. */
const LOW_STOCK_THRESHOLD = 5;

export function ManagerDashboard() {
  const sync = useSyncState();

  // Either kind of problem is worth a manager's attention, so the banner shows
  // whichever exists — money first. The header's light draws the distinction;
  // this is the detail a person actually reads.
  const syncIssue = sync.lastError ?? sync.lastNotice;

  const totals = useLiveQuery(() => getDailyTotals(), [], undefined);
  const recent = useLiveQuery(() => getRecentSales(10), [], [] as LocalSale[]);
  const lowStock = useLiveQuery(
    async () => {
      const list = await getDb()
        .products.filter((product) => product.stockQuantity < LOW_STOCK_THRESHOLD)
        .toArray();
      return list
        .sort(
          (a, b) =>
            a.stockQuantity - b.stockQuantity || a.name.localeCompare(b.name),
        )
        .slice(0, 8);
    },
    [],
    [] as LocalProduct[],
  );
  const catalogueSize = useLiveQuery(
    () => getDb().products.count(),
    [],
    undefined,
  );

  const average =
    totals !== undefined && totals.saleCount > 0
      ? Math.round(totals.grossKes / totals.saleCount)
      : 0;

  return (
    <>
      <SyncProvider />
      <AppHeader current="manager" />

      <main className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-6 px-4 py-6 lg:px-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[0.6875rem] font-semibold tracking-[0.22em] text-muted uppercase">
              East Africa Time
            </p>
            <h1 className="mt-1 font-serif text-3xl font-semibold tracking-tight text-foreground">
              {totals === undefined ? "Today" : formatEatDate(totals.day)}
            </h1>
            <p className="mt-1 text-sm text-muted">
              Takings recorded on this till, synced or not.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void runSync().catch(() => {})}
              disabled={sync.syncing}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-cream transition-colors hover:bg-primary-deep disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <RefreshCw
                aria-hidden="true"
                className={`size-4 ${sync.syncing ? "animate-spin" : ""}`}
              />
              Sync now
            </button>
            <button
              type="button"
              onClick={() => void fetchProducts().catch(() => {})}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-semibold text-muted transition-colors hover:border-primary/40 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <ArrowDownToLine aria-hidden="true" className="size-4" />
              Refresh catalogue
            </button>
          </div>
        </header>

        <ManagerNav current="overview" />

        {syncIssue !== null ? (
          <p
            role="status"
            className="flex items-start gap-2 rounded-2xl border border-danger/25 bg-danger-soft px-4 py-3 text-sm text-danger"
          >
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{syncIssue}</span>
          </p>
        ) : null}

        <section
          aria-label="Today's figures"
          className="grid grid-cols-2 gap-3 xl:grid-cols-4"
        >
          <StatCard
            label="Total sales today"
            value={`KES ${formatAmount(totals?.grossKes ?? 0)}`}
            hint={`${totals?.saleCount ?? 0} ${pluralize(totals?.saleCount ?? 0, "sale")} · avg KES ${formatAmount(average)}`}
            icon={<Wallet aria-hidden="true" className="size-4" />}
            emphasis
          />
          <StatCard
            label="Bags sold today"
            value={formatAmount(totals?.bagsSold ?? 0)}
            hint={`${totals?.itemsSold ?? 0} ${pluralize(totals?.itemsSold ?? 0, "item")} in total`}
            icon={<ShoppingBag aria-hidden="true" className="size-4" />}
          />
          <StatCard
            label="Shoes sold today"
            value={formatAmount(totals?.shoesSold ?? 0)}
            hint="pairs across all styles"
            icon={<SportShoe aria-hidden="true" className="size-4" />}
          />
          <StatCard
            label="Payment mix"
            value={`${formatAmount(totals?.byPaymentMethod.cash.gross ?? 0)}`}
            hint={`cash · M-Pesa ${formatAmount(
              totals?.byPaymentMethod.mpesa.gross ?? 0,
            )} · card ${formatAmount(totals?.byPaymentMethod.card.gross ?? 0)}`}
            icon={<Banknote aria-hidden="true" className="size-4" />}
          />
        </section>

        <section
          aria-label="Till status"
          className="flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-border bg-card px-5 py-4 shadow-card"
        >
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
            <span className="text-muted">
              Catalogue:{" "}
              <strong className="font-semibold text-foreground tabular-nums">
                {catalogueSize ?? "—"}
              </strong>{" "}
              products
            </span>
            <span className="text-muted">
              Last sync:{" "}
              <strong className="font-semibold text-foreground">
                {sync.lastSyncedAt !== null
                  ? formatTime(sync.lastSyncedAt)
                  : "not yet this session"}
              </strong>
            </span>
            <span className="inline-flex items-center gap-1.5 text-muted">
              <CloudUpload aria-hidden="true" className="size-4" />
              Waiting to sync:{" "}
              <strong className="font-semibold text-foreground tabular-nums">
                {sync.pending}
              </strong>
            </span>
          </div>
          <NetworkStatus />
        </section>

        <CashDrawer />

        <section
          aria-label="Low stock alerts"
          className="overflow-hidden rounded-3xl border border-border bg-card shadow-card"
        >
          <header className="flex items-center gap-2 border-b border-border px-5 py-4">
            <PackageSearch aria-hidden="true" className="size-4 text-primary" />
            <h2 className="font-serif text-lg font-semibold tracking-tight text-foreground">
              Low stock
            </h2>
            <span className="rounded-full bg-well px-2 py-0.5 text-xs font-semibold text-muted">
              under {LOW_STOCK_THRESHOLD}
            </span>
          </header>

          {lowStock.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted">
              Every product is at {LOW_STOCK_THRESHOLD} or more. Nothing to
              reorder yet.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {lowStock.map((product) => (
                <li
                  key={product.id}
                  className="flex items-center justify-between gap-4 px-5 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {product.name}
                    </p>
                    <p className="text-xs text-muted capitalize">
                      {product.category}
                      {product.barcode !== null ? ` · ${product.barcode}` : ""}
                    </p>
                  </div>
                  <span
                    className={
                      product.stockQuantity === 0
                        ? "inline-flex shrink-0 items-center rounded-full bg-danger-soft px-3 py-1 text-xs font-semibold text-danger"
                        : "inline-flex shrink-0 items-center rounded-full bg-accent/20 px-3 py-1 text-xs font-semibold text-primary-deep"
                    }
                  >
                    {product.stockQuantity === 0
                      ? "Out of stock"
                      : `${product.stockQuantity} left`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section
          aria-label="Recent transactions"
          className="overflow-hidden rounded-3xl border border-border bg-card shadow-card"
        >
          <header className="flex items-center gap-2 border-b border-border px-5 py-4">
            <ReceiptText aria-hidden="true" className="size-4 text-primary" />
            <h2 className="font-serif text-lg font-semibold tracking-tight text-foreground">
              Recent transactions
            </h2>
            <span className="rounded-full bg-well px-2 py-0.5 text-xs font-semibold text-muted">
              last {recent.length}
            </span>
          </header>

          {recent.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-muted">
              No sales recorded on this till yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <caption className="sr-only">
                  The most recent sales on this till, newest first.
                </caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs font-semibold tracking-[0.12em] text-muted uppercase">
                    <th scope="col" className="px-5 py-3">
                      Time
                    </th>
                    <th scope="col" className="px-5 py-3">
                      Receipt
                    </th>
                    <th scope="col" className="px-5 py-3">
                      Cashier
                    </th>
                    <th scope="col" className="px-5 py-3 text-right">
                      Items
                    </th>
                    <th scope="col" className="px-5 py-3">
                      Payment
                    </th>
                    <th scope="col" className="px-5 py-3 text-right">
                      Total
                    </th>
                    <th scope="col" className="px-5 py-3">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((sale) => (
                    <tr
                      key={sale.clientUuid}
                      className="border-b border-border/60 last:border-b-0"
                    >
                      <td className="px-5 py-3 whitespace-nowrap text-muted tabular-nums">
                        {formatTime(sale.createdAt)}
                      </td>
                      <td className="px-5 py-3 font-mono text-xs text-foreground">
                        {sale.clientUuid.slice(0, 8).toUpperCase()}
                      </td>
                      <td className="px-5 py-3 text-foreground">
                        {sale.cashierName}
                      </td>
                      <td className="px-5 py-3 text-right text-foreground tabular-nums">
                        {sale.items.reduce((sum, item) => sum + item.quantity, 0)}
                      </td>
                      <td className="px-5 py-3">
                        <PaymentCell method={sale.paymentMethod} />
                      </td>
                      <td className="px-5 py-3 text-right font-semibold text-foreground tabular-nums">
                        {formatAmount(sale.totalKes)}
                      </td>
                      <td className="px-5 py-3">
                        {sale.syncedAt === null ? (
                          <span className="inline-flex rounded-full bg-accent/20 px-2.5 py-1 text-xs font-semibold text-primary-deep">
                            Saved locally
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-success-soft px-2.5 py-1 text-xs font-semibold text-success">
                            Synced
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="flex items-center justify-center gap-2 pb-2 text-center text-xs text-muted">
          <RefreshCcw aria-hidden="true" className="size-3.5" />
          Figures cover this device only, and include sales not yet sent to the
          server.
        </p>
      </main>
    </>
  );
}

function PaymentCell({ method }: { method: PosPaymentMethod }) {
  const Icon =
    method === "cash" ? Banknote : method === "mpesa" ? Smartphone : CreditCard;
  const label = method === "cash" ? "Cash" : method === "mpesa" ? "M-Pesa" : "Card";

  return (
    <span className="inline-flex items-center gap-1.5 text-muted">
      <Icon aria-hidden="true" className="size-3.5" />
      {label}
    </span>
  );
}

function StatCard({
  label,
  value,
  hint,
  icon,
  emphasis = false,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
  emphasis?: boolean;
}) {
  return (
    <article className="flex flex-col rounded-3xl border border-border bg-card p-5 shadow-card">
      <div className="flex items-center gap-2 text-muted">
        <span className={emphasis ? "text-primary" : "text-muted"}>{icon}</span>
        <h3 className="text-xs font-semibold tracking-[0.14em] uppercase">
          {label}
        </h3>
      </div>
      <p
        className={`mt-3 font-serif font-semibold tracking-tight tabular-nums ${
          emphasis ? "text-3xl text-primary" : "text-2xl text-foreground"
        }`}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </article>
  );
}
