import type { Metadata } from "next";

import { ProductForm } from "@/components/manager/product-form";

export const metadata: Metadata = {
  title: "Add Product",
};

/**
 * Add a product from the till.
 *
 * Protected by `app/manager/layout.tsx`, so only a manager can reach it.
 */
export default function InventoryPage() {
  return <ProductForm />;
}
