import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

/**
 * The one place the POS's Supabase client is created.
 *
 * Adapted from the storefront's `lib/supabase/client.ts`, with one deliberate
 * difference: this uses `@supabase/supabase-js` directly rather than
 * `@supabase/ssr`.
 *
 * The storefront's browser client exists to carry a Supabase *auth session* in
 * cookies so the server can see who is signed in. The till has no Supabase auth
 * session — people sign in with a PIN that is verified on the device, so there
 * is nothing for SSR to read and no cookie to keep in step. Pulling in the SSR
 * client would mean carrying a session store that is never populated.
 *
 * The client runs under the anon key, so RLS applies in full: it may read
 * `products` and `pos_users`, call `pos_record_sale` to record a sale, and call
 * `pos_daily_totals` for aggregates. It cannot read a sale back, and it cannot
 * write the catalogue. It must never see the service role key.
 *
 * Not memoised on `globalThis` for correctness so much as for hygiene: one
 * client per tab, for the life of the tab.
 */

const globalForSupabase = globalThis as typeof globalThis & {
  __pedigreePosSupabase?: SupabaseClient<Database>;
};

interface SupabaseConfig {
  url: string;
  anonKey: string;
}

/**
 * The configured credentials, or null.
 *
 * Returning null rather than throwing is what lets the whole app build and run
 * with no `.env.local` at all: sync functions become no-ops and the till is
 * simply offline-only, instead of crashing at import time.
 */
export function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseConfig() !== null;
}

export function createClient(): SupabaseClient<Database> {
  const existing = globalForSupabase.__pedigreePosSupabase;
  if (existing) return existing;

  const config = getSupabaseConfig();
  if (config === null) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill both in.",
    );
  }

  const client = createSupabaseClient<Database>(config.url, config.anonKey, {
    auth: {
      // No session to persist, refresh, or detect. All three would be dead
      // configuration, and `persistSession` in particular would put a GoTrue
      // token in localStorage that nothing reads.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  globalForSupabase.__pedigreePosSupabase = client;
  return client;
}
