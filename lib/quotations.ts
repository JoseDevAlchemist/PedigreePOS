import { formatAmount, toWholeShillings } from "@/lib/format";

export const MPESA_TILL = "5655972";
export const QUOTATION_VALIDITY_DAYS = 14;

export interface QuotationItem {
  productId: string | null;
  name: string;
  color: string | null;
  quantity: number;
  unitPrice: number;
  imageUrl: string | null;
}

export interface QuotationData {
  quotationNumber: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  items: QuotationItem[];
  discountPercent: number;
  createdAt: string;
}

export interface QuotationTotals {
  subtotalKes: number;
  discountKes: number;
  totalKes: number;
}

export function calculateQuotationTotals(
  data: Pick<QuotationData, "items" | "discountPercent">,
): QuotationTotals {
  const subtotal = data.items.reduce(
    (sum, item) => sum + item.unitPrice * item.quantity,
    0,
  );
  const discountPercent = clampPercent(data.discountPercent);
  const discount = toWholeShillings((subtotal * discountPercent) / 100);

  return {
    subtotalKes: toWholeShillings(subtotal),
    discountKes: discount,
    totalKes: Math.max(0, toWholeShillings(subtotal) - discount),
  };
}

export function createQuotationNumber(date: Date = new Date()): string {
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PED-Q-${date.getFullYear()}-${suffix}`;
}

/** The plain-text fallback the cashier can paste into WhatsApp. */
export function quotationWhatsAppText(data: QuotationData): string {
  const totals = calculateQuotationTotals(data);
  const lines = data.items.map((item) => {
    const color = item.color?.trim() ? ` (${item.color.trim()})` : "";
    return `${item.quantity}x ${item.name}${color} - KES ${formatAmount(item.unitPrice * item.quantity)}`;
  });

  return [
    "*Pedigree Leather Quotation*",
    `Name: ${data.customerName}`,
    "",
    ...lines,
    "",
    `*Total: KES ${formatAmount(totals.totalKes)}*`,
    "",
    `Pay via M-Pesa Till: ${MPESA_TILL}`,
    `Quote valid for ${QUOTATION_VALIDITY_DAYS} days.`,
  ].join("\n");
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
