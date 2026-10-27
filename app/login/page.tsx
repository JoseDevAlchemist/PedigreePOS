import type { Metadata } from "next";

import { BrandMark } from "@/components/brand-mark";
import { BrandPanel } from "@/components/auth/brand-panel";
import { PinLogin } from "@/components/auth/pin-login";
import { SyncProvider } from "@/components/sync-provider";

export const metadata: Metadata = {
  title: "Sign in",
};

/**
 * The sign-in screen.
 *
 * A strict 50/50 split at `lg` and up: half the screen carries the brand, the
 * other half carries the keypad. Below `lg` the brand panel steps aside and the
 * keypad is all that matters, centred on the screen.
 *
 * The brand half is the `BrandPanel` component: a rich dark-leather surface
 * dressed by a radial glow, ghosted saddle-stitch artwork, and the lockup held
 * in a frosted glass panel that fades in on load.
 */
export default function LoginPage() {
  return (
    <>
      <SyncProvider />
      <main className="relative h-screen min-h-screen flex-1 lg:grid lg:grid-cols-2">
        {/* Left: brand panel. */}
        <BrandPanel />

        {/* Right: PIN keypad, perfectly centred. */}
        <section className="flex h-full min-h-screen items-center justify-center bg-background px-6 py-14 lg:px-12 lg:py-0">
          <div className="w-full max-w-md">
            <div className="mb-8 flex justify-center lg:hidden">
              <BrandMark size={64} tagline />
            </div>
            <PinLogin />
          </div>
        </section>
      </main>
    </>
  );
}
