import type { Metadata } from "next";

import { BrandMark } from "@/components/brand-mark";
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
 * The brand panel is a smooth solid dark brown with no decorative stripe, and
 * the Pedigree lockup is large and centred so the machine is unmistakable from
 * across the counter.
 */
export default function LoginPage() {
  return (
    <>
      <SyncProvider />
      <main className="relative h-screen min-h-screen flex-1 lg:grid lg:grid-cols-2">
        {/* Left: brand panel. A solid dark brown surface, large centred logo. */}
        <section
          aria-hidden="true"
          className="hidden lg:flex flex-col items-center justify-center gap-6 p-16 bg-primary-dark text-cream"
        >
          <BrandMark size={140} />
          <div className="text-center max-w-xs">
            <p className="text-[0.75rem] font-semibold tracking-[0.28em] text-accent-ink uppercase">
              Point of Sale
            </p>
            <h2 className="mt-3 font-serif text-3xl font-semibold tracking-tight text-cream leading-tight">
              Pedigree Leather
            </h2>
            <p className="mt-4 text-sm leading-6 text-cream/80">
              The workshop till, built to keep selling when the line goes down.
            </p>
          </div>
          <p className="text-xs text-cream/50">
            Pedigree Leather &middot; Nairobi
          </p>
        </section>

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
