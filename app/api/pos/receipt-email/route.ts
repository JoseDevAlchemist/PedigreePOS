import { NextResponse } from "next/server";

/**
 * Receipt email delivery.
 *
 * The till never talks to an email provider directly: that would mean shipping
 * the provider's key to every browser and trusting it. It posts here instead,
 * and this route forwards the request to whatever the shop actually uses.
 *
 * Configure `POS_RECEIPT_EMAIL_WEBHOOK` (a Supabase edge function, a Formspree
 * endpoint, a mail relay — anything that accepts a JSON POST) to turn it on.
 * Until then it answers 501, and the receipt stays queued on the till with a
 * visible error rather than being silently dropped.
 *
 * The receipt itself is rendered on the device at the moment of sale, so this
 * endpoint receives only what is needed to deliver it, not a copy of the sale.
 */

interface ReceiptEmailRequest {
  clientUuid?: unknown;
  email?: unknown;
}

export async function POST(request: Request) {
  const webhook = process.env.POS_RECEIPT_EMAIL_WEBHOOK;

  if (!webhook) {
    return NextResponse.json(
      {
        error:
          "Receipt email delivery is not configured. Set POS_RECEIPT_EMAIL_WEBHOOK to enable it.",
      },
      { status: 501 },
    );
  }

  let body: ReceiptEmailRequest;
  try {
    body = (await request.json()) as ReceiptEmailRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { clientUuid, email } = body;

  if (typeof clientUuid !== "string" || clientUuid.length === 0) {
    return NextResponse.json({ error: "clientUuid is required." }, { status: 400 });
  }

  // Deliberately permissive: an over-strict pattern is how a real customer's
  // address gets rejected at the counter and the cashier gives up on the
  // feature. The shape check catches typos; the provider is the real validator.
  if (typeof email !== "string" || !email.includes("@") || email.length > 254) {
    return NextResponse.json(
      { error: "A valid email address is required." },
      { status: 400 },
    );
  }

  try {
    const upstream = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientUuid, email }),
    });

    if (!upstream.ok) {
      return NextResponse.json(
        { error: `Receipt provider returned ${upstream.status}.` },
        { status: 502 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: "Could not reach the receipt provider." },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}
