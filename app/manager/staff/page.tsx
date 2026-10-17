import type { Metadata } from "next";

import { StaffManager } from "@/components/manager/staff-manager";

export const metadata: Metadata = {
  title: "Staff",
};

/**
 * Staff management. Access is enforced by `app/manager/layout.tsx`, which wraps
 * everything under `/manager` — including this route — in
 * `<RequireAuth role="manager" />`.
 */
export default function StaffPage() {
  return <StaffManager />;
}
