import type { Metadata } from "next";

import { OnlineOrderNotifications } from "@/components/pos/online-order-notifications";
import { PosScreen } from "@/components/pos/pos-screen";
import { RequireAuth } from "@/components/require-auth";

export const metadata: Metadata = {
  title: "Till",
};

/**
 * The till.
 *
 * A server component so `metadata` can be exported, wrapping a client screen in
 * the guard. The guard is client-side and reads `localStorage`; see
 * `components/require-auth.tsx` for why that is not middleware.
 */
export default function PosPage() {
  return (
    <RequireAuth>
      <OnlineOrderNotifications />
      <PosScreen />
    </RequireAuth>
  );
}
