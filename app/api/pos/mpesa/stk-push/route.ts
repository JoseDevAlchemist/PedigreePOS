import { NextResponse } from "next/server";

import { logError } from "@/lib/logger";
import { MpesaError, normalizePhoneNumber, requestMpesaStkPush } from "@/lib/mpesa";

/**
 * Initiate a M-Pesa Lipa Na M-Pesa STK Push for a sale.
 *
 * The till (browser) calls this and never sees the credentials: the Consumer
 * Secret and Passkey live server-side in `lib/mpesa.ts`, behind this route.
 *
 * Body:
 * ```json
 * { "amountKes": 12500, "phoneNumber": "0700000000", "accountReference": "PED-…" }
 * ```
 *
 * Responses:
 * | Status | When |
 * | --- | --- |
 * | `200` | STK push accepted; the customer should now see the prompt on their phone |
 * | `400` | Malformed body, missing amount, or a phone that is not a Kenyan mobile number |
 * | `503` | M-Pesa is not configured, or the token/STK push failed — the till falls back to manual entry |
 *
 * The response carries the `CheckoutRequestID`, which the Safarici webhook later
 * references and the till uses to reconcile.
 */

interface StkPushRequest {
  amountKes?: unknown;
  phoneNumber?: unknown;
  accountReference?: unknown;
}

export async function POST(request: Request) {
  let body: StkPushRequest;
  try {
    body = (await request.json()) as StkPushRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const amountKes = typeof body.amountKes === "number" ? Math.round(body.amountKes) : null;
  if (amountKes === null || !Number.isFinite(amountKes) || amountKes <= 0) {
    return NextResponse.json({ error: "A positive amountKes is required." }, { status: 400 });
  }

  const rawPhone =
    typeof body.phoneNumber === "string" ? body.phoneNumber : "";
  const phoneNumber = normalizePhoneNumber(rawPhone);
  if (phoneNumber === null) {
    return NextResponse.json(
      { error: "A valid Kenyan phone number (07XXXXXXXXX) is required." },
      { status: 400 },
    );
  }

  const accountReference =
    typeof body.accountReference === "string" && body.accountReference.trim().length > 0
      ? body.accountReference.trim()
      : `PED-${crypto.randomUUID()}`;

  try {
    const result = await requestMpesaStkPush({
      amountKes,
      phoneNumber,
      accountReference,
      transactionDesc: "Pedigree POS",
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const logged = logError(
      { scope: "mpesa", operation: "stkpush" },
      error,
    );

    const status = error instanceof MpesaError ? 503 : 502;
    return NextResponse.json({ error: logged.message }, { status });
  }
}
