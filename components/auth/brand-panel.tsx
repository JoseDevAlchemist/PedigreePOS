"use client";

import { motion } from "framer-motion";

import { BrandMark } from "@/components/brand-mark";

/**
 * The leather strap with its saddle stitch — the workshop's signature motif,
 * used here as the decorative hero artwork behind the glass panel. Drawn inline
 * so the login screen ships with zero extra requests; opacity keeps it a ghost
 * of craft rather than a graphic.
 */
function StitchArtwork() {
  return (
    <svg
      viewBox="0 0 240 240"
      fill="none"
      aria-hidden="true"
      className="size-[28rem] text-cream opacity-[0.07]"
    >
      <path
        d="M24 96 H216"
        stroke="currentColor"
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray="2 14"
      />
      <path
        d="M24 144 H216"
        stroke="currentColor"
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray="2 14"
      />
      <path
        d="M84 96 V144 M120 96 V144 M156 96 V144 M192 96 V144"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray="2 11"
      />
    </svg>
  );
}

/**
 * The sign-in brand panel.
 *
 * Replaces the flat dark-brown block with a rich leather surface: a deep brown
 * base dressed by a radial glow (light pooling in from the centre) and a soft
 * vignette for depth. Above the copy sits a ghosted saddle-stitch strap. The
 * whole composition is contained in a frosted glass panel so the dark leather
 * reads as depth rather than a flat fill, and the lockup settles in with a
 * subtle fade-in.
 */
export function BrandPanel() {
  return (
    <section
      aria-hidden="true"
      className="relative hidden lg:flex flex-col items-center justify-center overflow-hidden bg-primary-dark px-16 py-16 text-cream"
    >
      {/* Leather surface: deep brown base, radial glow pooling in, vignette. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,var(--color-primary-dark)_0%,var(--color-primary)_55%,var(--color-primary-deep)_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(245,233,217,0.07),transparent_60%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_35%,rgba(20,12,10,0.65)_100%)]" />

      {/* Hero artwork: the workshop's saddle-stitch strap, very faint. */}
      <div className="absolute inset-0 grid place-items-center">
        <StitchArtwork />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.9, ease: "easeOut" }}
        className="relative z-10 flex w-full max-w-md flex-col items-center gap-8 rounded-2xl border border-white/10 bg-white/5 p-10 text-center backdrop-blur-md sm:p-12"
      >
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.15, ease: "easeOut" }}
        >
          <div className="drop-shadow-[0_18px_44px_rgba(0,0,0,0.65)]">
            <BrandMark size={180} />
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.3, ease: "easeOut" }}
        >
          <h2 className="font-serif text-3xl font-semibold tracking-tight text-cream leading-tight sm:text-4xl">
            The workshop till, built to keep selling when the line goes down.
          </h2>
          <p className="mt-4 text-[0.65rem] font-semibold tracking-[0.3em] text-accent-ink uppercase">
            Pedigree Leather • Nairobi
          </p>
        </motion.div>
      </motion.div>
    </section>
  );
}
