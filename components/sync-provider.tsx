"use client";

import { useEffect, useRef } from "react";

import { isSupabaseConfigured } from "@/lib/supabase/client";
import { startAutoSync } from "@/lib/sync";
import { useToast } from "@/components/ui/toast-provider";

/**
 * Starts automatic syncing for the whole app.
 *
 * Rendered once, near the root. It draws nothing: mounting it only wires up the
 * `online`/`offline` listeners and the retry interval, and unmounting takes them
 * back down (which matters under React Strict Mode's double-invoke in dev —
 * without the teardown you would stack two intervals on every remount).
 *
 * It also owns the one piece of app-level feedback the sync engine cannot raise
 * itself: when no Supabase instance is configured at all, the till is running
 * fully offline and the cashier should hear it rather than discover it from a
 * PIN that will never verify.
 */
export function SyncProvider() {
  const { toast } = useToast();
  const warnedRef = useRef(false);

  useEffect(() => startAutoSync(), []);

  useEffect(() => {
    if (warnedRef.current) return;
    if (isSupabaseConfigured()) return;
    warnedRef.current = true;

    toast({
      variant: "warning",
      title: "Offline Mode",
      description: "Database disconnected.",
      duration: Number.POSITIVE_INFINITY,
    });
  }, [toast]);

  return null;
}
