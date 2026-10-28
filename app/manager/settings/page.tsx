/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useState } from "react";

import { useToast } from "@/components/ui/toast-provider";
import { getDb, type LocalDiscount } from "@/lib/db";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";

export default function ManagerSettingsPage() {
  const { toast } = useToast();
  const [rate, setRate] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [offline] = useState(() => !navigator.onLine || !isSupabaseConfigured());
  const [discounts, setDiscounts] = useState<LocalDiscount[]>([]);
  const [code, setCode] = useState("");
  const [pct, setPct] = useState("");

  useEffect(() => {
    if (!navigator.onLine || !isSupabaseConfigured()) {
      return;
    }
    const sb = createClient() as any;
    (async () => {
      const { data } = await sb
        .from("shop_settings" as any)
        .select("exchange_rate_kes_to_usd")
        .eq("id", "default")
        .single();
      if (data) setRate(String((data as any).exchange_rate_kes_to_usd));
      const { data: d } = await sb.from("pos_discounts" as any).select("*");
      if (d) {
        const rows = (d as any[]).map((r: any) => ({
          id: r.id,
          code: r.code,
          percentage: r.percentage,
          active: r.active,
        }));
        setDiscounts(rows);
        const db = getDb();
        await db.pos_discounts.clear();
        await db.pos_discounts.bulkPut(rows);
      }
      setLoading(false);
    })();
  }, []);

  async function saveRate() {
    if (offline) return;
    setSaving(true);
    const sb = createClient() as any;
    const { error } = await sb
      .from("shop_settings" as any)
      .update({ exchange_rate_kes_to_usd: Number(rate) })
      .eq("id", "default");
    setSaving(false);
    if (error) {
      toast({ variant: "error", description: error.message });
      return;
    }
    toast({ variant: "success", description: "Exchange rate updated. The website will reflect this immediately." });
  }

  async function addDiscount() {
    if (offline) return;
    const sb = createClient() as any;
    const { data, error } = await sb
      .from("pos_discounts" as any)
      .insert({ code: code.toUpperCase(), percentage: Number(pct), active: true })
      .select()
      .single();
    if (error || !data) {
      toast({ variant: "error", description: error?.message ?? "Failed" });
      return;
    }
    const row = data as any;
    const ld: LocalDiscount = { id: row.id, code: row.code, percentage: row.percentage, active: row.active };
    await getDb().pos_discounts.put(ld);
    setDiscounts((prev) => [...prev, ld]);
    setCode("");
    setPct("");
    toast({ variant: "success", description: "Discount created." });
  }

  if (offline) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold">Settings</h1>
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-800">
          You are offline. Please reconnect to view or edit global settings.
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-8">
      <h1 className="text-2xl font-bold">Settings</h1>
      {loading ? (
        <p>Loading…</p>
      ) : (
        <>
          <section className="rounded-2xl border p-6 space-y-4">
            <h2 className="text-lg font-semibold">Exchange Rate</h2>
            <label className="block text-sm">
              Exchange Rate (1 USD = ? KES)
              <input
                type="number"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                className="mt-1 w-full rounded-xl border px-3 py-2"
              />
            </label>
            <button
              onClick={saveRate}
              disabled={saving}
              className="rounded-xl bg-primary px-4 py-2 text-cream"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </section>

          <section className="rounded-2xl border p-6 space-y-4">
            <h2 className="text-lg font-semibold">Discounts</h2>
            <div className="flex gap-2">
              <input
                placeholder="Code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="rounded-xl border px-3 py-2"
              />
              <input
                placeholder="%"
                type="number"
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                className="w-20 rounded-xl border px-3 py-2"
              />
              <button onClick={addDiscount} className="rounded-xl bg-primary px-4 py-2 text-cream">
                Add
              </button>
            </div>
            <ul className="space-y-1">
              {discounts.map((d) => (
                <li key={d.id} className="text-sm">
                  {d.code}: {d.percentage}% {d.active ? "(active)" : ""}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}