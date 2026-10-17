"use client";

import { useEffect, useRef } from "react";

/**
 * Global barcode-scanner capture.
 *
 * A USB scanner is a keyboard that types very fast and finishes with Enter. So
 * the whole implementation is: collect printable keystrokes, treat a pause as a
 * new read, and act on Enter.
 *
 * The important part is *when it does not run*. If a text field has focus, the
 * scanner's characters belong to that field — typing "6001234" over someone's
 * half-written product search because they scanned mid-sentence would be worse
 * than not scanning at all. So an editable target, or an open modal, takes the
 * keyboard entirely and this hook steps aside.
 */

interface UseBarcodeScannerOptions {
  onScan: (code: string) => void;
  /** True while a modal or dialog owns the screen. */
  paused?: boolean;
  /** Shorter than this is a stray keypress, not a barcode. */
  minLength?: number;
  /** A gap longer than this ends the current read, in ms. Scanners type far
   * faster than people, which is the whole basis for telling them apart. */
  timeoutMs?: number;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

export function useBarcodeScanner({
  onScan,
  paused = false,
  minLength = 4,
  timeoutMs = 120,
}: UseBarcodeScannerOptions): void {
  const bufferRef = useRef("");
  const lastKeyAtRef = useRef(0);

  // Kept in a ref so a new `onScan` identity does not tear down the listener
  // and drop a half-read barcode on the floor.
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (paused) return;

    function handleKeyDown(event: KeyboardEvent) {
      // Modifier combos are application shortcuts, never scanner input.
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      // A dialog owns the keyboard while it is open. Checked against the DOM
      // rather than trusted to the `paused` prop, so a modal that forgets to
      // pass it cannot have the grid smuggled a product behind it.
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) {
        return;
      }

      if (isEditableTarget(event.target)) return;

      const now = Date.now();
      if (now - lastKeyAtRef.current > timeoutMs) {
        bufferRef.current = "";
      }
      lastKeyAtRef.current = now;

      if (event.key === "Enter") {
        const code = bufferRef.current;
        bufferRef.current = "";
        if (code.length >= minLength) {
          event.preventDefault();
          onScanRef.current(code);
        }
        return;
      }

      if (event.key.length === 1) {
        bufferRef.current += event.key;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [paused, minLength, timeoutMs]);
}
