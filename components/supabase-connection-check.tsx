"use client";

import { useEffect } from "react";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";

/**
 * Temporary diagnostic: proves on mount whether the anon client can reach
 * Supabase. Renders nothing; it only logs the outcome.
 */
export function SupabaseConnectionCheck() {
  useEffect(() => {
    if (!isSupabaseConfigured()) {
      console.error("Supabase Connection Error: credentials are not configured.");
      return;
    }

    const supabase = createClient();

    void (async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id")
        .limit(1);

      if (error) {
        console.error("Supabase Connection Error:", error);
      } else {
        console.log("Supabase Connected! Found products:", data);
      }
    })();
  }, []);

  return null;
}
