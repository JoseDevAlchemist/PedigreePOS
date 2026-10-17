import type { Metadata } from "next";

import { OfflineShell } from "@/components/offline-shell";

export const metadata: Metadata = {
  title: "Offline",
};

/**
 * The offline fallback shell, precached by Serwist and served for any document
 * request that misses the cache while the network is down. It is intentionally
 * static and self-contained: nothing here may depend on the network, because
 * the network is exactly what is missing when it is shown.
 */
export default function OfflinePage() {
  return <OfflineShell />;
}
