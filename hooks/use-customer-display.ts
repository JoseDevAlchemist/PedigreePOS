"use client";

import { useSyncExternalStore } from "react";

import {
  connectCustomerDisplay,
  getCustomerDisplayState,
  paintCustomerDisplay,
  subscribeCustomerDisplay,
  tryReconnectCustomerDisplay,
  type CustomerDisplayState,
} from "@/lib/customer-display";

export interface UseCustomerDisplayResult extends CustomerDisplayState {
  /** Ask the browser to open the serial port. Must be user-gesture driven. */
  connect: () => Promise<void>;
  /** Reconnect to the last used display via its stored vendor/product id. */
  tryReconnect: () => Promise<void>;
  /** Paint a total onto the customer display. */
  paint: (totalKes: number) => void;
}

/**
 * The customer display as seen from React.
 *
 * One `useSyncExternalStore` reads the connection status and the last painted
 * total; the imperative actions come straight from the controller singleton. The
 * POS screen uses the snapshot to render the connection pill and the store to
 * paint on every total change.
 */
export function useCustomerDisplay(): UseCustomerDisplayResult {
  const state = useSyncExternalStore(
    subscribeCustomerDisplay,
    getCustomerDisplayState,
    getCustomerDisplayState,
  );

  return {
    status: state.status,
    lastTotalKes: state.lastTotalKes,
    connect: connectCustomerDisplay,
    tryReconnect: tryReconnectCustomerDisplay,
    paint: paintCustomerDisplay,
  };
}
