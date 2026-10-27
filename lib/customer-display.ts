"use client";

import WebSerialCustomerDisplay, { type WebSerialDevice } from "@point-of-sale/webserial-customer-display";

/**
 * The customer-facing LED screen (VFD).
 *
 * A second screen facing the customer, driven over Web Serial: it shows the
 * running total while a sale is being rung up, so the cashier never has to
 * repeat the amount verbally.
 *
 * Like the sync store in `lib/sync.ts`, this is a singleton external store: the
 * connection status and the last painted total are read through
 * `useSyncExternalStore`, and mutations (`paint`, `connect`, `tryReconnect`)
 * publish through the same subscription. That keeps the React contract boring
 * — a component reads a snapshot — while the serial work happens imperatively
 * behind it.
 */

export type CustomerDisplayStatus = "disconnected" | "connecting" | "connected";

export interface CustomerDisplayState {
  status: CustomerDisplayStatus;
  /** The last amount painted; whole shillings, 0 when the cart is empty. */
  lastTotalKes: number;
}

const STORAGE_KEY = "pedigree-pos.customer-display";

const initialState: CustomerDisplayState = {
  status: "disconnected",
  lastTotalKes: 0,
};

let state: CustomerDisplayState = initialState;
const listeners = new Set<() => void>();

function setState(patch: Partial<CustomerDisplayState>): void {
  const previous = state;
  const next: CustomerDisplayState = { ...previous, ...patch };
  const changed =
    previous.status !== next.status || previous.lastTotalKes !== next.lastTotalKes;
  if (!changed) return;

  state = next;
  for (const listener of listeners) listener();
}

function setStatus(status: CustomerDisplayStatus): void {
  setState({ status });
}

export function getCustomerDisplayState(): CustomerDisplayState {
  return state;
}

export function subscribeCustomerDisplay(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/* ---------------------------------------------------------------------------
   Serial connection
   --------------------------------------------------------------------------- */

let display: WebSerialCustomerDisplay | null = null;
let lastUsedDevice: WebSerialDevice | null = null;
/** Latest paint while the display is not connected; superseded by newer paints. */
let pendingPaint: string | null = null;

function readStoredDevice(): WebSerialDevice | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    const record =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    const vendorId = record?.vendorId;
    const productId = record?.productId;
    if (typeof vendorId !== "number" || typeof productId !== "number") return null;
    if (vendorId <= 0 || productId <= 0) return null;
    return { vendorId, productId };
  } catch {
    return null;
  }
}

function storeDevice(device: WebSerialDevice | null): void {
  if (typeof window === "undefined") return;
  try {
    if (device === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(device));
  } catch {
    // Storage can be unavailable (private mode); reconnect just won't persist.
  }
}

function wireEvents(instance: WebSerialCustomerDisplay): void {
  instance.addEventListener("connected", (event) => {
    lastUsedDevice = {
      vendorId: typeof event.vendorId === "number" ? event.vendorId : 0,
      productId: typeof event.productId === "number" ? event.productId : 0,
    };
    storeDevice(
      lastUsedDevice.vendorId > 0 && lastUsedDevice.productId > 0 ? lastUsedDevice : null,
    );
    setStatus("connected");
    const pending = pendingPaint;
    pendingPaint = null;
    if (pending !== null) void instance.line(pending);
  });

  instance.addEventListener("disconnected", () => {
    setStatus("disconnected");
  });
}

export async function connectCustomerDisplay(): Promise<void> {
  const status = getCustomerDisplayState().status;
  if (status === "connecting" || status === "connected") return;

  setStatus("connecting");
  const instance = new WebSerialCustomerDisplay();
  display = instance;
  wireEvents(instance);
  await instance.connect();
}

export async function tryReconnectCustomerDisplay(): Promise<void> {
  const device = readStoredDevice();
  if (device === null) {
    setStatus("disconnected");
    return;
  }
  if (getCustomerDisplayState().status === "connected") return;

  setStatus("connecting");
  const instance = new WebSerialCustomerDisplay();
  display = instance;
  wireEvents(instance);
  await instance.reconnect(device);
}

/* ---------------------------------------------------------------------------
   Painting
   --------------------------------------------------------------------------- */

/**
 * Paint the customer display with a total, formatted as `TOTAL: KES [amount]`.
 *
 * Only the total is ever painted — no item names, no line prices, no tender or
 * change. The display is two lines of 20 characters, so the string is written
 * verbatim and the library pads/truncates.
 */
export function paintCustomerDisplay(totalKes: number): void {
  const amount = Math.max(0, Math.round(totalKes));
  const text = `TOTAL: KES ${amount}`;

  setState({ lastTotalKes: amount });

  if (getCustomerDisplayState().status === "connected" && display !== null) {
    void display.line(text);
    return;
  }

  // Latest-wins: drop any older pending paint before remembering this one.
  pendingPaint = text;
}

/** Paint the empty state — the cart was cleared or the sale completed. */
export function clearCustomerDisplay(): void {
  paintCustomerDisplay(0);
}
