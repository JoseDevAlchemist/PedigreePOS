"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";

import { useIsClient } from "@/hooks/use-is-client";
import { cn } from "@/lib/cn";

/**
 * A modal dialog.
 *
 * Written rather than pulled from a library because the till only needs one
 * shape of overlay and the details that matter are behavioural, not visual:
 *
 *   - `role="dialog"` + `aria-modal` + a label, so a screen reader announces it
 *     as a dialog and not as loose content.
 *   - Escape closes, and the keydown listener runs in the *capture* phase so it
 *     beats anything inside that would otherwise swallow the key.
 *   - Tab is trapped. Without that, tabbing walks into the product grid behind
 *     the overlay, which is the classic screen-reader-user trap.
 *   - Focus moves in on open and returns to whatever opened it on close, so the
 *     keyboard does not silently reset to the top of the document.
 *   - Body scroll is locked, and restored to whatever it was rather than
 *     blindly set back to `""`.
 *
 * Motion is short and one-directional — a 12px rise and a fade — and is
 * skipped entirely under `prefers-reduced-motion`.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = "md",
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  size?: "md" | "lg";
  /** False for a step in progress that must be finished or abandoned explicitly. */
  dismissible?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const reduceMotion = useReducedMotion();

  // Portalled into `document.body` rather than rendered in place. Two reasons:
  // no ancestor can trap it in a stacking context or clip it, and — the one that
  // matters here — printing can hide the whole app with a single
  // `body > *:not(.print-root)` rule and leave only the receipt on the page.
  // A portal needs a DOM, so this is false through the server render.
  const isClient = useIsClient();

  // Held in a ref, not read from props inside the effect. Callers pass an inline
  // arrow (`onClose={() => setOpen(false)}`), so its identity changes on every
  // render of the parent — and the setup below moves focus and locks body
  // scroll. Re-running it on a parent render would yank focus back to the first
  // control mid-form, which is exactly the kind of bug that is invisible until
  // someone is typing an amount.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // Move focus to the first useful control inside the panel. Falling back to
    // the panel itself keeps focus inside even when there is nothing focusable.
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(
      "input, button, [href], select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    (first ?? panel)?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && dismissible) {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;

      const node = panelRef.current;
      if (node === null) return;

      const focusable = Array.from(
        node.querySelectorAll<HTMLElement>(
          "input:not([disabled]), button:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((element) => element.offsetParent !== null);

      if (focusable.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }

      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (firstEl === undefined || lastEl === undefined) return;

      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus?.();
    };
    // `onCloseRef` deliberately replaces `onClose` here: see the comment above.
  }, [open, dismissible]);

  if (!isClient) return null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div className="print-root fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8">
          <motion.div
            aria-hidden="true"
            onClick={dismissible ? onClose : undefined}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.18 }}
            className="no-print absolute inset-0 bg-charcoal/55 backdrop-blur-[2px]"
          />

          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description !== undefined ? descriptionId : undefined}
            tabIndex={-1}
            initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.995 }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              "relative flex max-h-[calc(100vh-4rem)] w-full flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-overlay outline-none",
              size === "lg" ? "max-w-3xl" : "max-w-lg",
            )}
          >
            <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
              <div>
                <h2
                  id={titleId}
                  className="font-serif text-xl font-semibold tracking-tight text-foreground"
                >
                  {title}
                </h2>
                {description !== undefined ? (
                  <p id={descriptionId} className="mt-1 text-sm text-muted">
                    {description}
                  </p>
                ) : null}
              </div>
              {dismissible ? (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="-mr-1 -mt-1 rounded-xl p-2 text-muted transition-colors hover:bg-well hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <X aria-hidden="true" className="size-5" />
                </button>
              ) : null}
            </header>

            <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {children}
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
