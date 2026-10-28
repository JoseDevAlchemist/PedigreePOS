import type { Metadata } from "next";

import { ProductForm } from "@/components/manager/product-form";
import { StockAdjustment } from "@/components/manager/stock-adjustment";

export const metadata: Metadata = {
  title: "Inventory",
};

export default function InventoryPage() {
  return (
    <div>
      <ProductForm />
      <StockAdjustment />
    </div>
  );
}