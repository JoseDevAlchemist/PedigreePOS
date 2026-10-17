# Pedigree POS

The workshop till at **Pedigree Leather**, Nairobi. A desktop-first, offline-first
PWA that shares its Supabase project with the storefront — so a bag sold across
the counter is one fewer bag on the website.

The whole design turns on one constraint: **the shop must keep selling when the
connection drops.** Sales are written to the device first and pushed to the
server whenever there is a connection, in whatever order they come back.

```
pnpm install
cp .env.example .env.local   # then fill in the two Supabase values
pnpm dev                     # http://localhost:3000
```

Sign in with a PIN on the keypad. With the demo seed applied:

| Name          | Role    | PIN    |
| ------------- | ------- | ------ |
| Brian Otieno  | cashier | `1234` |
| Grace Wanjiru | manager | `9999` |

> These are throwaway demo credentials, and `1234`/`9999` are the only place the
> PINs exist in plain text. Change them before the till sees real money —
> `supabase/pos_seed.sql` explains how, and how to generate a hash properly
> rather than hand-writing one.

---

## Scripts

| Command      | What it does                     |
| ------------ | -------------------------------- |
| `pnpm dev`   | Development server (webpack)     |
| `pnpm build` | Production build (webpack)       |
| `pnpm start` | Serve the production build       |
| `pnpm lint`  | ESLint, including `react-hooks`  |

**The `--webpack` flag is not decoration.** Next 16 builds with Turbopack by
default, and the PWA layer is [`@serwist/next`](https://serwist.pages.dev) — a
webpack plugin that bundles `app/sw.ts` into `public/sw.js`. Tailwind v4 also
had to move to the PostCSS route (`postcss.config.mjs`,
`@tailwindcss/postcss`) so that the two compilers agree on the CSS. Dropping the
flag does not fail loudly: it produces a build with no service worker and
unexpanded `@tailwind` directives. Verify `public/sw.js` exists after a build.

## Environment

`.env*` is gitignored. See `.env.example` for the full list.

| Variable                        | Needed | Notes                                            |
| ------------------------------- | ------ | ------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`      | yes    | The **shared** project, same as the storefront   |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes    | Publishable key; safe because of RLS (see below) |
| `POS_RECEIPT_EMAIL_WEBHOOK`     | no     | Server-side only; without it receipt email is 501 |

Without the two Supabase values the till still runs: sign-in finds no roster and
the catalogue stays empty, but nothing crashes and nothing pretends to have
synced. The header says so.

---

## The database

Both apps share one Supabase project, and therefore one migration history.

```
supabase/
  migrations/         001–011  storefront (mirrored, not owned here)
                      012      pos_users, pos_sales, pos_sale_items, RLS
                      013      pos_apply_sale_stock — stock, idempotently
                      014      pos_record_sale — the only write path
                      015      card as a third payment method
                      016      cashier enrolment from the manager screen
  pos_seed.sql        demo staff (optional, not a migration)
  config.toml         CLI config for this project
```

**Migrations 001–011 are copies.** They belong to the storefront repo and are
mirrored here only so `supabase db push` can reconcile the history and apply the
POS's own migrations on top. Never edit them here — change them in the
storefront, re-mirror, and let this repo stay a follower.

```bash
npx supabase link --project-ref <ref>   # once
npx supabase db push                    # applies 012–014
npx supabase db push --include-seed     # also inserts the demo staff
```

### What `anon` can do — the whole list

The publishable key is in a browser, so it is public. Everything below is what
it can reach, and nothing else does:

| Reach                       | Why                                                    |
| --------------------------- | ------------------------------------------------------ |
| `SELECT products`           | the catalogue, incl. stock                             |
| `SELECT product_colors`, `product_images` | each product's photography, for the till grid |
| `SELECT pos_users`          | bcrypt hashes, so a PIN can be checked offline (see below) |
| `INSERT pos_users`          | enrolling a cashier — `role = 'cashier'` only (016)    |
| `CALL pos_record_sale(...)` | record one sale, its lines and its stock decrement     |
| `CALL pos_daily_totals()`   | aggregate takings, for the manager view                |

It **cannot read a sale back**, and it cannot write the catalogue. See
`supabase/migrations/012_pos.sql`, `015_pos_card_payments.sql` and
`016_pos_staff_enrolment.sql`.

### Why recording a sale is a function, not an upsert

The obvious implementation is a client-side
`upsert(..., { onConflict: 'client_uuid', ignoreDuplicates: true })`. It does not
work here, and the reason is worth keeping written down:

```
POST /rest/v1/pos_sales?on_conflict=client_uuid
Prefer: resolution=ignore-duplicates
-> 401  new row violates row-level security policy for table "pos_sales"
```

`ON CONFLICT DO NOTHING` is not a blind insert — Postgres has to *see* the
conflicting row to decide to skip it, and there is no SELECT policy on
`pos_sales` for `anon`. That is exactly what stops the day's takings being
readable with a key that ships in a browser. **Any** `resolution=...`
preference fails the same way, whatever `return=` says; a plain `INSERT` is
unaffected.

So the upsert moved to where it can read and the browser cannot:
`pos_record_sale`, `SECURITY DEFINER`, which inserts with
`ON CONFLICT (client_uuid) DO NOTHING`. Same idempotency, same key — the uuid
the till mints at the moment of sale — and the renderer is now one transaction
instead of three calls that could die halfway and leave a sale with no lines.

---

## How it works

### Offline first

`IndexedDB` (via Dexie) is the database the till actually reads and writes.
Supabase is a mirror that is best-effort and idempotent, so a retry after a
timeout is always safe.

| Store          | Holds                                                     |
| -------------- | --------------------------------------------------------- |
| `products`     | the catalogue and its first photograph, written by `fetchProducts` |
| `pos_users`    | active staff and their PIN hashes, for offline sign-in      |
| `pos_sales`    | every sale this device has taken, synced or not            |
| `sync_queue`   | what is still owed to the server                           |
| `till_sessions`| cash-drawer shifts: float, close count and variance        |

`app/sw.ts` (Serwist) precaches the app shell, so `/login`, `/pos` and
`/~offline` are served from the cache with no network at all. `/` redirects to
`/pos`.

### Taking money

Three methods — **Cash** (the till works out the change), **M-Pesa** and
**Card** (both are a code the cashier reads off a machine and the till records
against the sale). The M-Pesa and Card handshakes are deliberately not wired to
a provider yet: the counter records what happened, and an API call must never be
able to block a sale.

`completeSale()` writes the sale, the local stock decrement and the queue entry
in **one** Dexie transaction, so they cannot half-apply. It never awaits the
network — that is the whole point — and it returns before the receipt is shown,
so printing can never lose a sale.

A USB barcode scanner is a keyboard that types fast and ends with Enter. A
global listener collects those keystrokes and drops the product in the cart —
but only when no dialog is open and no field has focus, so it can never type
over a half-written search. If the search box *is* focused, the scan lands in the
box and Enter resolves it there instead; neither path double-adds.

Stock is the interesting part. The local count is decremented immediately. When
the catalogue is refreshed, the server's figure is written as
`server − unsynced_units_on_this_till`, derived from the queue rather than
stored, so it cannot drift out of step with the sales that produced it.
Otherwise a refresh would quietly un-sell goods the cashier has already handed
over the counter.

### The manager's pages

`/manager` (Overview) and `/manager/staff`, both behind the client-side
`manager` guard. Everything a manager reads comes from the local database, so the
figures are the same online and offline — and they include sales the server has
not seen yet, marked as such.

- **Today's figures.** Total sales, bags sold and shoes sold, plus the payment
  mix. "Today" is an **East Africa Time (UTC+3)** day, not the device's day: a
  till left on UTC would otherwise file an 11pm sale under tomorrow. See
  `lib/time.ts`.
- **Low stock.** Every product under five units, worst first.
- **Recent transactions.** The last ten sales, with cashier, payment method and
  sync status.
- **Cash drawer.** Open a shift with its float; close it against a physical
  count. The difference between what should be in the drawer and what is —
  `counted − expected` — is stamped at close and kept.
- **Staff.** Enrol a cashier with a name and a PIN. The PIN is bcrypt-hashed in
  the browser with the same settings sign-in checks against, and only the hash is
  sent. Enrolment is the one write that needs a connection: the account has to
  exist on the server before any till can use it.

### Printing receipts

The receipt is an 80mm roll layout (`#receipt-print-area` in
`components/pos/receipt.tsx`), shown in the dialog and sent to the printer by
plain `window.print()`. The dialog is portalled to `document.body`, so the print
rules in `globals.css` can hide the entire app with one selector and leave only
the receipt on the roll.

The page box is declared as `@page { size: 80mm 297mm; margin: 0 }`. The height
is a fixed length because a content-sized one is not expressible: CSS Paged Media
allows a `size` of one length, two lengths, or `auto` — never a length *and*
`auto`, so the natural-looking `size: 80mm auto` is dropped by the parser and
falls back to Letter (a 216mm-wide sheet with a receipt in the corner). `size:
80mm` is wrong too, and less obviously: one length sets both sides, giving an
80mm square. 297mm matches the "80mm continuous roll" paper the Windows drivers
expose. On roll paper the driver normally stops at the end of the ink rather than
feeding a full sheet, but if a job ever advances too far, that setting — not this
CSS — is the knob.

**On the Windows till, launch the POS browser with `--kiosk-printing`** so a sale
prints silently instead of stopping at the print dialog:

```
chrome.exe --kiosk-printing --app=http://localhost:3000/pos
```

Without the flag the cashier gets the browser's print preview on every sale,
which is the wrong amount of ceremony for a customer standing at the counter.

### Syncing

Push before pull, always — the money already taken matters more than the
catalogue being a minute fresher.

1. `syncSales` — each queued sale through `pos_record_sale`
2. `syncReceiptEmails` — queued receipts, via the till's own endpoint
3. `fetchProducts` — the catalogue
4. `fetchPosUsers` — the roster, so the next offline sign-in works

Each step is isolated: a catalogue fetch that times out must not stop the day's
sales from being pushed. Failures land on the queue entry, the loop continues,
and the manager view marks what has not synced. Runs on mount, on the browser's
`online` event, and on a slow interval to catch a connection that flaps without
firing it.

### Sign-in and the route guard

- **The guard is a client component, not middleware.** Middleware runs on the
  server on every request, so a till with no connection would never reach it —
  the check would fail exactly when the shop most needs the app. `RequireAuth`
  reads `localStorage` in the browser and redirects with `window.location`,
  because a document request for a precached route is answered by the service
  worker, whereas client-side navigation needs an RSC payload from the server.
- **The session lives in `localStorage`**, so a reload or a crash mid-shift does
  not sign anyone out. It is read through `useSyncExternalStore`, so signing out
  in one tab updates the others for free.
- **PINs are never stored**, anywhere. `pos_users.pin_hash` holds bcrypt, and
  the comparison happens on the device.

### Known tradeoffs

Stated plainly, because each one is a decision rather than an oversight.

1. **`anon` can read the PIN hashes.** Offline sign-in is only possible if the
   device already holds them, which means the browser's key must be able to
   `SELECT pin_hash`. A 4-digit PIN has 10,000 possibilities, so assume a hash
   that leaks is a PIN that falls. Acceptable for Phase 1 — the PIN guards a
   shared shop floor, and the money is recorded server-side either way. The fix
   is a device token at enrolment plus a network PIN check, with a short-lived
   signed assertion cached for offline use.
2. **The role check is a convenience boundary, not a security one.** Anyone with
   the device and DevTools can edit `localStorage` and call themselves a manager.
   It stops honest mistakes. Real enforcement is RLS on the server.
3. **Receipt email needs a provider.** `/api/pos/receipt-email` answers `501`
   until `POS_RECEIPT_EMAIL_WEBHOOK` is set. Receipts queue rather than vanish,
   and the failure is visible instead of being swallowed.
4. **Enrolling a cashier is open to anyone holding the key.** `016` lets `anon`
   `INSERT` a `role = 'cashier'` row, because there is no server session to prove
   the caller is a manager. A cashier who edits `localStorage` can reach the
   staff screen. Same boundary as point 2, and the same fix: device tokens.
5. **Till sessions are local-only.** `till_sessions` records the float, the
   count and the variance on the device. Reconciling drawers across tills is a
   Phase 3 job; today a manager reads them on the till they were opened on.

---

## Verifying it

### Build

```bash
pnpm lint          # clean
pnpm build         # must be --webpack; confirm public/sw.js was written
```

### Offline, in the browser

1. `pnpm build && pnpm start`, open `/pos`, sign in as the cashier.
2. DevTools → **Network → Offline**. The header pill goes red.
3. Add products, apply the 10% discount, **Charge**, take payment. The sale saves
   and the receipt renders; nothing blocks, nothing spins forever. Repeat with
   **Card** and a reference — it behaves exactly like M-Pesa.
4. Scan a barcode with no field focused: the product drops into the cart. Click
   into the search box and scan again: the code lands in the box, and Enter adds
   it from there.
5. `/manager` as the cashier must bounce to `/pos` — still offline.
6. Sign out, sign in as the manager, open `/manager`: the sale is in the recent
   list, marked **Saved locally**, and the day's figures — including bags and
   shoes — include it. **Open till** with a float, take a sale, **Close till**
   with a count and see the variance.
7. Open `/manager/staff` while online and enrol a cashier. The product grid shows
   photographs where the catalogue has them and a bag placeholder where it does
   not.
8. DevTools → **Online**. The queue drains, the row flips to **Synced**, and the
   pending count returns to zero.
9. Confirm in the Supabase dashboard — not with the anon key, which cannot read
   sales back and is not supposed to: a row in `pos_sales` with that
   `client_uuid`, its lines in `pos_sale_items`, and `products.stock_quantity`
   down by the quantity sold.
10. Press **Print receipt** and check the preview: it is a narrow 80mm receipt,
    with the app hidden behind it.

### The device path

The offline half was driven headlessly as well, with `fake-indexeddb` standing in
for the browser's `IndexedDB` so that `lib/sales.ts`, `lib/sync.ts` and
`lib/db.ts` ran **unmodified** against the live project:

- `fetchProducts()` caches the catalogue
- `completeSale()` writes the sale, its line, the local stock decrement and the
  queue entry, and the line comes back with it
- a catalogue refresh while the sale is still queued does **not** un-sell it
  (stock stays `server − 1`)
- `runSync()` pushes it: one row on the server, the money matching the till to
  the shilling, the shared stock down by one, the queue empty, `pending` back to
  zero, and neither `lastError` nor `lastNotice` set
- replaying the push adds no second row and decrements no further stock

Then the test rows were deleted and the shared stock restored, so the project is
exactly as it was found.

What none of that covers, because it needs a browser: the service worker
serving `/pos` offline, the route guard redirecting offline, and the actual
printing. Step 3 of the run-through above is the part still to be done by hand.

### The server contract

The parts that cannot be checked from the browser were checked directly against
the live project, as `anon`, replaying exactly what `lib/sync.ts` sends:

- a sale pushes and decrements the shared stock exactly once
- the same sale pushed again returns `false`, duplicates nothing, and decrements
  nothing (`ON CONFLICT (client_uuid) DO NOTHING`, and `stock_applied_at`)
- a sale with no lines is refused
- direct `INSERT` into `pos_sales` is now denied, and `pos_apply_sale_stock` is
  no longer callable by `anon`
- `pos_sales` still cannot be read back; the roster still can
- the documented demo PINs verify against the stored bcrypt hashes

---

## Layout

```
app/
  login/ pos/               screens (all statically prerendered)
  manager/ manager/staff/   dashboard and staff management
  ~offline/                 what the service worker serves when a nav fails
  api/pos/receipt-email/    the one server route
  sw.ts                     the service worker (Serwist)
  globals.css               brand tokens, the 80mm print rules
components/
  auth/ pos/ manager/ ui/    screens, panels, dialogs
  require-auth.tsx          the offline-proof route guard
hooks/ lib/                  Dexie schema, cart reducer, sync engine, auth,
                             time (EAT), the cash drawer, staff enrolment
supabase/                    migrations and the demo seed
```

The till is a **fixed-height shell** at 1024px and up: the header and the cart
stay put and only the catalogue scrolls, because a cart that scrolls off the
bottom is a cart that gets mis-charged. Below `lg` the constraint is dropped and
the page scrolls normally, since a squeezed desktop layout is worse than a plain
one.
