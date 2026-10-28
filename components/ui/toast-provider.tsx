"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence } from "framer-motion";

import { Toast, type ToastItem, type ToastOptions } from "@/components/ui/toast";
import { useIsClient } from "@/hooks/use-is-client";

/**
 * The toast context: whatever calls `toast(...)` gets a dismiss function back,
 * so a caller that dismisses early (a success that has already been acted on, a
 * retry that just succeeded) can remove it without waiting out the timer.
 */
interface ToastContextValue {
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS = 4000;

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context === null) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

let nextToastId = 1;

/**
 * The global toast provider.
 *
 * Mounted once in the root layout, so any client component — login, POS header,
 * checkout, sync — can raise a toast without prop-drilling a queue through the
 * tree. Toasts stack in a fixed, bottom-right column and animate in/out through
 * `AnimatePresence`. The container renders nothing until the client owns the
 * DOM, same as the modal's portal.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const isClient = useIsClient();

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (options: ToastOptions) => {
      const id = nextToastId++;
      const item: ToastItem = {
        id,
        variant: options.variant ?? "info",
        title: options.title,
        description: options.description,
        duration: options.duration ?? DEFAULT_DURATION_MS,
      };
      setToasts((current) => [...current, item]);
      // `Infinity` (persistent) never schedules a dismissal.
      if (Number.isFinite(item.duration)) {
        timers.current.set(id, setTimeout(() => dismiss(id), item.duration));
      }
      return id;
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({ toast, dismiss }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {isClient ? (
        <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2">
          <AnimatePresence>
            {toasts.map((item) => (
              <Toast key={item.id} toast={item} onDismiss={() => dismiss(item.id)} />
            ))}
          </AnimatePresence>
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}
