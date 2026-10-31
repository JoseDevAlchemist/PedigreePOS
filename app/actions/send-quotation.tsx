"use server";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { headers } from "next/headers";
import { renderToBuffer } from "@react-pdf/renderer";
import { Resend } from "resend";

import { QuotationPDF } from "@/lib/emails/QuotationPDF";
import {
  calculateQuotationTotals,
  MPESA_TILL,
  QUOTATION_VALIDITY_DAYS,
  type QuotationData,
} from "@/lib/quotations";
import { formatAmount } from "@/lib/format";

export type SendQuotationResult =
  | { ok: true }
  | { ok: false; error: string };

export async function sendQuotationEmail(
  email: string,
  quotationData: QuotationData,
): Promise<SendQuotationResult> {
  const recipient = email.trim();
  if (!looksLikeEmail(recipient)) {
    return { ok: false, error: "Enter a valid customer email address." };
  }

  const validationError = validateQuotation(quotationData);
  if (validationError !== null) {
    return { ok: false, error: validationError };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error:
        "Email is not configured. Set RESEND_API_KEY (and optionally QUOTATION_FROM_EMAIL) on the server.",
    };
  }

  const from =
    process.env.QUOTATION_FROM_EMAIL ??
    process.env.RESEND_FROM_EMAIL ??
    "Pedigree Leather <onboarding@resend.dev>";

  const logoSrc = await readLogoDataUri();
  const pdf = await renderQuotationPdf(quotationData, logoSrc);
  const totals = calculateQuotationTotals(quotationData);
  const resend = new Resend(apiKey);

  const { error } = await resend.emails.send({
    from,
    to: recipient,
    subject: `Quotation ${quotationData.quotationNumber} — Pedigree Leather`,
    text: [
      `Dear ${quotationData.customerName},`,
      "",
      "Thank you for your interest in Pedigree Leather. Your quotation is attached as a PDF.",
      "",
      `Quotation: ${quotationData.quotationNumber}`,
      `Total: KES ${formatAmount(totals.totalKes)}`,
      `Pay via M-Pesa Till: ${MPESA_TILL}`,
      `This quotation is valid for ${QUOTATION_VALIDITY_DAYS} days.`,
      "",
      "Karibu tena.",
      "Pedigree Leather",
    ].join("\n"),
    attachments: [
      {
        filename: `${quotationData.quotationNumber}.pdf`,
        content: pdf,
        contentType: "application/pdf",
      },
    ],
  });

  if (error) {
    return {
      ok: false,
      error: error.message || "Resend could not send the quotation email.",
    };
  }

  return { ok: true };
}

async function renderQuotationPdf(
  quotationData: QuotationData,
  logoSrc: string | null,
): Promise<Buffer> {
  try {
    return await renderToBuffer(
      <QuotationPDF data={quotationData} logoSrc={logoSrc} />,
    );
  } catch {
    // A broken or slow product image must not stop the quotation from being
    // sent. Retry once with the image column left empty.
    return renderToBuffer(
      <QuotationPDF
        data={quotationData}
        logoSrc={logoSrc}
        includeImages={false}
      />,
    );
  }
}

async function readLogoDataUri(): Promise<string | null> {
  try {
    const bytes = await readFile(
      path.join(process.cwd(), "public", "pedigree-logo.png"),
    );
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch {
    // Hosted deployments serve `public/` from the CDN rather than the server
    // bundle, so fall back to the current origin before giving up on the logo.
    try {
      const requestHeaders = await headers();
      const host =
        requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
      if (!host) return null;
      const proto = requestHeaders.get("x-forwarded-proto") ?? "https";
      const response = await fetch(`${proto}://${host}/pedigree-logo.png`);
      if (!response.ok) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      return `data:image/png;base64,${bytes.toString("base64")}`;
    } catch {
      return null;
    }
  }
}

function validateQuotation(data: QuotationData): string | null {
  if (typeof data.customerName !== "string" || data.customerName.trim().length === 0) {
    return "Enter the customer's name.";
  }
  if (typeof data.quotationNumber !== "string" || data.quotationNumber.length === 0) {
    return "The quotation number is missing.";
  }
  if (!Array.isArray(data.items) || data.items.length === 0) {
    return "Add at least one item to the quotation.";
  }
  if (data.items.length > 100) {
    return "A quotation cannot contain more than 100 lines.";
  }

  for (const item of data.items) {
    if (typeof item.name !== "string" || item.name.trim().length === 0) {
      return "Every quotation line needs an item name.";
    }
    if (!Number.isFinite(item.quantity) || item.quantity < 1) {
      return "Every quotation line needs a quantity of at least one.";
    }
    if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
      return "Every quotation line needs a valid unit price.";
    }
  }

  return null;
}

function looksLikeEmail(value: string): boolean {
  return (
    value.includes("@") &&
    value.length >= 5 &&
    value.length <= 254 &&
    !/\s/.test(value)
  );
}
