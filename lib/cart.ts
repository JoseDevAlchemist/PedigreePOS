import type { CheckoutLine } from "@/lib/sales";

/**
 * The cart, as a pure reducer.
 *
 * Kept out of React so the arithmetic and the merge rules can be reasoned about
 * (and tested) without a renderer. The one rule that matters: **a product is a
 * line, not a row.** Scanning the same barcode twice increments a quantity
 * rather than appending a second line, which is what makes a receipt readable
 * and what lets `pos_sale_items` carry a UNIQUE (sale_id, product_id).
 */

export interface CartLine {
  productId: string;
  name: string;
  /** `bag` or `shoe`. Carried through to the sale line for reporting. */
  category: string | null;
  /** Price charged per unit, captured when the line was created. */
  unitPrice: number;
  quantity: number;
  /** Local stock at the time the line was created, to cap the quantity. */
  maxQuantity: number;
}

export interface CartState {
  lines: CartLine[];
  discountPercent: number;
}

export const emptyCart: CartState = { lines: [], discountPercent: 0 };

export type CartAction =
  | {
      type: "add";
      product: {
        productId: string;
        name: string;
        category: string | null;
        unitPrice: number;
        maxQuantity: number;
      };
      quantity?: number;
    }
  | { type: "setQuantity"; productId: string; quantity: number }
  | { type: "increment"; productId: string }
  | { type: "decrement"; productId: string }
  | { type: "remove"; productId: string }
  | { type: "clear" }
  | { type: "setDiscount"; percent: number }
  | { type: "reset"; state: CartState };

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case "add": {
      const { product, quantity = 1 } = action;

      // A product with no stock can still be added when the line already
      // exists (the cap is enforced below); a brand new line cannot.
      const existing = state.lines.find(
        (line) => line.productId === product.productId,
      );

      if (existing === undefined) {
        if (product.maxQuantity <= 0) return state;
        return {
          ...state,
          lines: [
            ...state.lines,
            {
              productId: product.productId,
              name: product.name,
              category: product.category,
              unitPrice: product.unitPrice,
              quantity: Math.min(quantity, product.maxQuantity),
              maxQuantity: product.maxQuantity,
            },
          ],
        };
      }

      const ceiling = Math.max(
        existing.maxQuantity,
        product.maxQuantity,
        existing.quantity,
      );

      return {
        ...state,
        lines: state.lines.map((line) =>
          line.productId === product.productId
            ? {
                ...line,
                // Refresh the price and name from the catalogue: a line that
                // already exists should reflect a price change, since the
                // cashier is still building the basket.
                name: product.name,
                category: product.category,
                unitPrice: product.unitPrice,
                maxQuantity: ceiling,
                quantity: clampQuantity(line.quantity + quantity, ceiling),
              }
            : line,
        ),
      };
    }

    case "increment": {
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.productId === action.productId
            ? {
                ...line,
                quantity: clampQuantity(line.quantity + 1, line.maxQuantity),
              }
            : line,
        ),
      };
    }

    case "decrement": {
      return {
        ...state,
        lines: state.lines
          .map((line) =>
            line.productId === action.productId
              ? { ...line, quantity: line.quantity - 1 }
              : line,
          )
          // Dropping to zero removes the line: a zero-quantity line has no
          // meaning on a receipt and would violate the quantity > 0 check
          // server-side.
          .filter((line) => line.quantity > 0),
      };
    }

    case "setQuantity": {
      return {
        ...state,
        lines: state.lines
          .map((line) =>
            line.productId === action.productId
              ? {
                  ...line,
                  quantity: clampQuantity(action.quantity, line.maxQuantity),
                }
              : line,
          )
          .filter((line) => line.quantity > 0),
      };
    }

    case "remove": {
      return {
        ...state,
        lines: state.lines.filter((line) => line.productId !== action.productId),
      };
    }

    case "clear": {
      return { lines: [], discountPercent: 0 };
    }

    case "setDiscount": {
      return { ...state, discountPercent: clampPercent(action.percent) };
    }

    case "reset": {
      return action.state;
    }

    default: {
      return state;
    }
  }
}

function clampQuantity(quantity: number, max: number): number {
  if (!Number.isFinite(quantity)) return 1;
  const rounded = Math.floor(quantity);
  if (rounded < 1) return 1;
  // `max` of 0 means stock is exhausted; the line is kept at its current size
  // rather than being forced to zero, because the goods are already bagged.
  if (max <= 0) return Math.max(1, rounded);
  return Math.min(rounded, max);
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

export function cartItemCount(state: CartState): number {
  return state.lines.reduce((sum, line) => sum + line.quantity, 0);
}

/** The cart in the shape the checkout service and the receipt both want. */
export function cartToCheckoutLines(state: CartState): CheckoutLine[] {
  return state.lines.map((line) => ({
    productId: line.productId,
    productName: line.name,
    category: line.category,
    quantity: line.quantity,
    priceAtSale: line.unitPrice,
  }));
}
