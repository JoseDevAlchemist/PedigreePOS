import { NextResponse } from "next/server";

import { logError, logInfo } from "@/lib/logger";
import { MpesaError, parseMpesaCallback, type MpesaCallback } from "@/lib/mpesa";

/**
 * The M-Pesa (Lipa Na M-Pesa) payment callback — the URL Safaricom calls when the
 * customer approves or declines the STK Push prompt.
 *
 * Registered as `MPESA_CALLBACK_URL` in the Daraja portal and set to this
 * handler's path, e.g. `https://<your-ngrok-url>.ngrok.io/api/pos/mpesa/callback`.
 *
 * On `ResultCode === 0` the payment succeeded and the confirmation code is read
 * from the callback metadata and returned to the caller (the till's client) so
 * the cashier can attach it to the sale. Anything else is logged with full
 * context and acknowledged with `200` so Safaricom does not retry a result that
 * has already been received.
 */

interface MpesaCallbackBody {
  MerchantRequestID?: unknown;
  CheckoutRequestID?: unknown;
  ResultCode?: unknown;
  ResultDesc?: unknown;
  Body?: unknown;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    const logged = logError(
      { scope: "mpesa", operation: "callback" },
      error instanceof Error ? error : new MpesaError("Malformed M-Pesa callback: invalid JSON body."),
    );
    // Acknowledge anyway: a retry of an unreadable body cannot succeed, and a
    // non-2xx would only cause Safaricom to hammer the endpoint.
    return NextResponse.json({ ResultCode: 0, error: logged.message }, { status: 200 });
  }

  let callback: MpesaCallback;
  try {
    callback = parseMpesaCallback(body as MpesaCallbackBody);
  } catch (error) {
    const logged = logError(
      { scope: "mpesa", operation: "callback" },
      error instanceof Error ? error : new MpesaError("Malformed M-Pesa callback."),
    );
    // Same reasoning as above: acknowledge receipt, the failure is logged.
    return NextResponse.json({ ResultCode: 0, error: logged.message }, { status: 200 });
  }

  const context = {
    resultCode: callback.resultCode,
    merchantRequestId: callback.merchantRequestId,
    checkoutRequestId: callback.checkoutRequestId,
    confirmationCode: callback.confirmationCode,
    amount: callback.amount,
    phoneNumber: callback.phoneNumber,
  };

  if (callback.resultCode === 0 && callback.confirmationCode !== null) {
    logInfo({ scope: "mpesa", operation: "callback" }, { ...context });
  } else {
    logError({ scope: "mpesa", operation: "callback", context }, new Error(`M-Pesa callback result: ${callback.resultCode}`));
  }

  return NextResponse.json({
    ResultCode: callback.resultCode,
    ...(callback.confirmationCode !== null ? { MpesaConfirmationCode: callback.confirmationCode } : {}),
  });
}
