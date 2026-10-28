"use client";

import { useEffect, useState } from "react";

import { useToast } from "@/components/ui/toast-provider";
import { getDb, type LocalProduct } from "@/lib/db";
import { addSyncQueueEntry } from "@/lib/sync";

export function StockAdjustment() {
  const { toast } = useToast();
  const [products, setProducts] = useState<LocalProduct[]>([]);
  const [productId, setProductId] = useState("");
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    getDb().products.toArray().then(setProducts);
  }, []);

  async function submit() {
    const db = getDb();
    const product = products.find((p) => p.id === productId);
    if (!product) return;
    const amount = Number(delta);
    if (!Number.isFinite(amount) || amount === 0) return;
    await db.transaction("rw", db.products, db.sync_queue, async () => {
      await db.products.update(productId, { stockQuantity: Math.max(0, product.stockQuantity + amount) });
      await addSyncQueueEntry({
        entity: "stock_adjustment",
        entityId: productId,
        payload: { delta: amount, reason },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    toast({ variant: "success", description: "Stock updated locally." });
    setDelta("");
    setReason("");
    const updated = await db.products.toArray();
    setProducts(updated);
  }

  return (
    <div className="p-8 space-y-4">
      <h1 className="text-2xl font-bold">Stock Adjustment</h1>
      <select value={productId} onChange={(e) => setProductId(e.target.value)} className="w-full rounded-xl border px-3 py-2">
        <option value="">Select product</option>
        {products.map((p) => (
          <option key={p.id} value={p.id}>{p.name} (stock {p.stockQuantity})</option>
        ))}
      </select>
      <input type="number" placeholder="Quantity (+/-)" value={delta} onChange={(e) => setDelta(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
      <input placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
      <button onClick={submit} className="rounded-xl bg-primary px-4 py-2 text-cream">Apply</button>
    </div>
  );
}
