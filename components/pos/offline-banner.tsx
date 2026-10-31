"use client";

import { WifiOff } from "lucide-react";

import { useOnlineStatus } from "@/hooks/use-online-status";

/**
 * The offline warning the cashier cannot miss.
 *
 * Sales still work offline, so the banner is not a block. It is the honest
 * counter-message: the money is only on this device until sync catches up.
 */
export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex items-center justify-center gap-2 bg-red-600 px-4 py-2 text-center font-bold text-white"
    >
      <WifiOff aria-hidden="true" className="size-4 shrink-0" />
      OFFLINE MODE: Sales are being saved to this device only. Do not clear your
      browser cache.
    </div>
  );
}
