# Progress — Pedigree POS

Implementation log for the M-Pesa STK Push (Lipa Na M-Pesa) work.

Each entry is appended as that step of the task is completed. Format:
date/time, files created/modified, brief change description, manual steps for the user.

---

## 2026-10-28 — Task start

- **Files created/modified:** none yet (this file created at project root).
- **Change:** Opened implementation of M-Pesa STK Push (Lipa Na M-Pesa) with manual fallback and error logging. Working branch: `phase-4-mpesa-stk-push`.
- **Manual steps needed:** none yet — will list as they arise.

## 2026-10-28 — Step 1/7 — Environment variables

- **Files created/modified:** `.env.example` (modified), `.env.local` (modified).
- **Change:** Added the M-Pesa / Lipa Na M-Pesa block: `MPESA_ENV=sandbox`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_PASSKEY`, `MPESA_SHORTCODE=174379`, `MPESA_CALLBACK_URL=https://your-ngrok-url.ngrok.io/api/pos/mpesa/callback`. The secret pair deliberately has no `NEXT_PUBLIC_` prefix and stays server-side only.
- **Manual steps needed:** Fill in real `MPESA_CONSUMER_KEY` / `MPESA_CONSUMER_SECRET` / `MPESA_PASSKEY` from the Safaricom Daraja developer portal; set `MPESA_ENV=production` and a live callback URL before handling real money.

## 2026-10-28 — Step 2/7 — Error logging system

- **Files created/modified:** `lib/logger.ts` (created).
- **Change:** Added the structured server-side error/event logger (`logError`, `logInfo`) producing JSON-able `{ scope, operation, context, message, error, loggedAt }` entries via `console`.
- **Manual steps needed:** none yet.

## 2026-10-28 — Step 3/7 — M-Pesa Daraja client

- **Files created/modified:** `lib/mpesa.ts` (created).
- **Change:** Added the server-only Lipa Na M-Pesa client: config from `MPESA_*` env vars, OAuth token fetch with expiry cache, STK Push initiation (`CustomerPayBill`) via `/mpesa/api/v1/stkpush/processrequest`, phone normalization (`07XXXXXXXXX`), and Safarici callback parsing (confirmation code from `CallbackMetadata`).
- **Manual steps needed:** none yet.

## 2026-10-28 — Step 4/7 — M-Pesa API routes

- **Files created/modified:** `app/api/pos/mpesa/stk-push/route.ts` (created), `app/api/pos/mpesa/callback/route.ts` (created).
- **Change:** Added `POST /api/pos/mpesa/stk-push` (validates amount + Kenyan phone, initiates STK push, returns checkout request id; 400/502/503 paths) and `POST /api/pos/mpesa/callback` (parses Safarici callback, logs success/failure, returns result code + confirmation code; acknowledges with 200). Verified with `pnpm build` and runtime smoke tests.
- **Manual steps needed:** Set `MPESA_CALLBACK_URL` in the Daraja portal to the public ngrok URL that points at `/api/pos/mpesa/callback`.

## 2026-10-28 — Step 5/7 — Checkout UI: STK push + manual fallback

- **Files created/modified:** `components/pos/checkout-dialog.tsx` (modified).
- **Change:** M-Pesa method now offers "Send M-Pesa prompt" (customer phone → `/api/pos/mpesa/stk-push`) with states `idle`/`sending`/`waiting`, and always retains the manual fallback ("Enter the code manually") where the cashier types the confirmation code. If the prompt cannot be sent, the UI falls back to manual entry with an explanatory error instead of dead-ending.
- **Manual steps needed:** none yet.

## 2026-10-28 — Step 6/7 — Verification

- **Files created/modified:** none.
- **Change:** `pnpm lint` clean; `tsc --noEmit` clean; `pnpm build` succeeds with the two new dynamic routes (`/api/pos/mpesa/stk-push`, `/api/pos/mpesa/callback`). Runtime smoke tests against a production server: bad phone → 400, STK push unconfigured/upstream → 502, callback success → 200 + confirmation code, callback decline → 200, malformed JSON → 200 + logged error.

## 2026-10-28 — Task complete — M-Pesa STK Push implementation

- **Files created/modified:** `PROGRESS.md` (this file), `.env.example`, `.env.local`, `lib/logger.ts`, `lib/mpesa.ts`, `app/api/pos/mpesa/stk-push/route.ts`, `app/api/pos/mpesa/callback/route.ts`, `components/pos/checkout-dialog.tsx`.
- **Change:** M-Pesa STK Push (Lipa Na M-Pesa) implemented with server-side credentials, structured error logging, callback handling and a robust manual fallback. Branch: `phase-4-mpesa-stk-push`; committed as `9e786fa`.
- **Manual steps needed:**
  1. Fill real `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_PASSKEY` in `.env.local` (Daraja developer portal) and keep them server-side only.
  2. Set the Daraja callback URL to the public tunnel, e.g. `https://<your-ngrok-url>.ngrok.io/api/pos/mpesa/callback`.
  3. Run `pnpm dev`, test the STK push against the Safaricom sandbox (shortcode 174379), then switch `MPESA_ENV=production` for live money.
  4. Remove the placeholder/manual fallback only when the STK push flow is proven against real money.
