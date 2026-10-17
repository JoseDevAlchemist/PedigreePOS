"use client";

import { hashPin, isValidPinFormat, verifyPin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { fetchPosUsers } from "@/lib/sync";

/**
 * Enrolling a cashier.
 *
 * This is the one write in the POS that is *not* local-first, and the reason is
 * worth stating: a new cashier has to exist on the server to sign in anywhere,
 * and there is nothing to queue against — a pending "create user" that lands two
 * days later is worse than an honest "connect to add staff". Everything else
 * the manager does (the drawer, the dashboard) still works offline.
 *
 * The PIN never leaves the browser. It is bcrypt-hashed here with the same
 * settings the offline sign-in checks against (`lib/auth.ts`), and only the hash
 * is sent.
 */

/** The demo/PIN rules: 4–6 digits, mirrored from the sign-in keypad. */
export async function createCashier(input: {
  name: string;
  pin: string;
}): Promise<void> {
  const name = input.name.trim();
  if (name.length < 2) {
    throw new Error("Enter the cashier's name.");
  }
  if (!isValidPinFormat(input.pin)) {
    throw new Error("The PIN must be 4 to 6 digits.");
  }
  if (!isSupabaseConfigured()) {
    throw new Error(
      "Adding staff needs a connection to Supabase. The till is running offline.",
    );
  }

  // Sign-in is a bare PIN with no user picker — the first hash that matches
  // wins — so two active staff sharing a PIN would silently sign in as
  // whichever was synced first. Refuse the collision here rather than let it
  // become a mystery later.
  const roster = await getDb()
    .pos_users.filter((user) => user.active)
    .toArray();
  for (const user of roster) {
    if (await verifyPin(input.pin, user.pinHash)) {
      throw new Error("That PIN is already in use. Choose another.");
    }
  }

  const pinHash = await hashPin(input.pin);

  const { error } = await createClient()
    .from("pos_users")
    .insert({ name, pin_hash: pinHash, role: "cashier", active: true });

  if (error) {
    throw new Error(`Could not add the cashier: ${error.message}`);
  }

  // Pull the roster back so the new cashier can sign in on this till without a
  // reload or a manual sync. A failure here is not a failed enrolment — the row
  // is on the server — so it is deliberately swallowed; the next sync repairs it.
  await fetchPosUsers().catch(() => {});
}
