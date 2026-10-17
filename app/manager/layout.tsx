import { RequireAuth } from "@/components/require-auth";

/**
 * The manager area's guard.
 *
 * A layout, so every route nested under `/manager` is protected by adding it,
 * exactly once, in the one place that cannot be forgotten. The check itself is
 * client-side — see `components/require-auth.tsx`.
 */
export default function ManagerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RequireAuth role="manager">{children}</RequireAuth>;
}
