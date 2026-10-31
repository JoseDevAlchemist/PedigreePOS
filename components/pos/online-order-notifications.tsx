"use client";

import { useEffect } from "react";

import { useToast } from "@/components/ui/toast-provider";
import { formatPrice } from "@/lib/format";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";

interface OnlineOrderRow {
  id: string;
  customer_name?: string | null;
  order_number?: string | null;
  total?: number | null;
}

/**
 * Raises a till toast whenever the storefront inserts a new order.
 *
 * Realtime applies RLS to `postgres_changes`; the anon client must be allowed
 * to SELECT the inserted order row for the event to be delivered.
 */
export function OnlineOrderNotifications() {
  const { toast } = useToast();

  useEffect(() => {
    if (!isSupabaseConfigured()) return;

    const supabase = createClient();
    const channel = supabase
      .channel("online-orders")
      .on<OnlineOrderRow>(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "orders" },
        (payload) => {
          const order = payload.new;
          const reference =
            typeof order.order_number === "string" && order.order_number.length > 0
              ? order.order_number
              : "New website order";
          const total = typeof order.total === "number" ? ` · ${formatPrice(order.total)}` : "";
          const customer =
            typeof order.customer_name === "string" && order.customer_name.length > 0
              ? ` · ${order.customer_name}`
              : "";

          toast({
            variant: "info",
            title: "New website order",
            description: `${reference}${total}${customer}`,
            duration: 10_000,
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [toast]);

  return null;
}
