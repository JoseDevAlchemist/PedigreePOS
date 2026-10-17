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
 * A two-panel composition rather than a small centred card: at 1024px and up,
 * half the screen carries the brand and a plain statement of what this machine
 * is, and the other half is the keypad. The brand panel is decorative and
 * disappears below `lg`, where the keypad is all that matters.
 */
export default function LoginPage() {
  return (
    <>
      <SyncProvider />
      <main className="flex min-h-full flex-1 flex-col lg:flex-row">
        <section className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-primary-dark p-12 lg:flex">
          {/* The stitch rule, oversized and very low contrast: texture from the
              brand's own vocabulary rather than a decorative gradient. */}
          <div
            aria-hidden="true"
            className="stitch pointer-events-none absolute -right-24 top-1/4 h-64 w-[140%] rotate-[-14deg] text-accent/15"
          />
          <BrandMark size={64} />
          <div className="relative">
            <p className="text-[0.6875rem] font-semibold tracking-[0.28em] text-accent-ink uppercase">
              Point of Sale
            </p>
            <h2 className="mt-4 max-w-md font-serif text-4xl leading-tight font-semibold text-cream">
              The workshop till, built to keep selling when the line goes down.
            </h2>
            <p className="mt-4 max-w-sm text-sm leading-6 text-cream/70">
              Sales are recorded on this device first and reach the shared
              catalogue the moment a connection returns. Nothing waits on the
              network.
            </p>
          </div>
          <p className="relative text-xs text-cream/50">
            Pedigree Leather &middot; Nairobi
          </p>
        </section>

        <section className="flex flex-1 items-center justify-center bg-background px-6 py-14">
          <div className="w-full max-w-sm">
            <div className="mb-10 flex justify-center lg:hidden">
              <BrandMark size={56} tagline />
            </div>
            <PinLogin />
          </div>
        </section>
      </main>
    </>
  );
}
