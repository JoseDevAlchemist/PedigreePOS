import { OfflineBanner } from "@/components/pos/offline-banner";

/**
 * The till layout carries the global connectivity warning. It sits above the
 * page so every POS screen shows the same offline state.
 */
export default function PosLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <OfflineBanner />
      {children}
    </>
  );
}
