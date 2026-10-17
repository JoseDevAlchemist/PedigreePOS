import type { Metadata } from "next";

import { ManagerDashboard } from "@/components/manager/manager-dashboard";

export const metadata: Metadata = {
  title: "Manager",
};

/**
 * The manager area. Access is enforced by `app/manager/layout.tsx`, which wraps
 * everything here in `<RequireAuth role="manager" />`.
 */
export default function ManagerPage() {
  return <ManagerDashboard />;
}
