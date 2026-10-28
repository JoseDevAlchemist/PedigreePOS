"use client";

import { motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

import { useIsClient } from "@/hooks/use-is-client";
import { cn } from "@/lib/cn";

/**
 * The tones a POS toast can take. Each maps onto an existing design token where
 * the brand has one and a Tailwind palette colour where it does not.
 */
export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastOptions {
  variant?: ToastVariant;
  title?: string;
  description?: string;
  /** Auto-dismiss after this many milliseconds; `Infinity` keeps it until dismissed. */
  duration?: number;
}

export interface ToastItem extends Required<Pick<ToastOptions, "variant">> {
  id: number;
  title?: string;
  description?: string;
  duration: number;
}

interface ToastProps {
  toast: ToastItem;
  onDismiss: () => void;
}

const VARIANT_ICON: Record<
  ToastVariant,
  { icon: typeof Info; iconClass: string }
> = {
  success: { icon: CheckCircle2, iconClass: "text-success" },
  error: { icon: XCircle, iconClass: "text-danger" },
  warning: { icon: AlertTriangle, iconClass: "text-amber-500" },
  info: { icon: Info, iconClass: "text-blue-500" },
};

/**
 * A single toast.
 *
 * Motion is short and one-directional — a 16px rise plus a fade, 0.2s, ease-out —
 * and is skipped entirely under `prefers-reduced-motion`, matching the modal so
 * the two choreographies stay identical. The exit callback is what removes the
 * toast from the provider's queue once the slide-out finishes.
 */
export function Toast({ toast, onDismiss }: ToastProps) {
  const reduceMotion = useReducedMotion();
  const isClient = useIsClient();

  const { icon: Icon, iconClass } = VARIANT_ICON[toast.variant];

  if (!isClient) return null;

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 16, scale: 0.97 }}
      animate={
        reduceMotion
          ? { opacity: 1, y: 0, scale: 1 }
          : { opacity: 1, y: 0, scale: 1 }
      }
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.97 }}
       transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
       className="pointer-events-auto flex w-full items-start gap-3 rounded-2xl border border-white/10 bg-charcoal/90 px-4 py-3 shadow-overlay backdrop-blur-md"
    >
      <span className={cn("mt-0.5 rounded-full bg-white/5 p-1.5", iconClass)}>
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        {toast.title ? (
          <p className="text-sm font-semibold text-cream">{toast.title}</p>
        ) : null}
        {toast.description ? (
          <p className="mt-0.5 text-sm leading-5 text-cream/70">{toast.description}</p>
        ) : null}
      </div>
    </motion.div>
  );
}
