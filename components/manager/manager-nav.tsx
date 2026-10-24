"use client";

import { PackagePlus, Users, Wallet } from "lucide-react";

import { cn } from "@/lib/cn";

/**
 * The manager section's own navigation.
 *
 * Separate from the app header's Till/Manager switch because it moves between
 * pages *inside* the manager area. Plain anchors again — a document request for
 * a precached route is answered by the service worker, so moving between the
 * dashboard and the staff list keeps working with no connection.
 */
export function ManagerNav({
  current,
}: {
  current: "overview" | "staff" | "inventory";
}) {
  const tabs = [
    { href: "/manager", label: "Overview", key: "overview" as const, icon: Wallet },
    { href: "/manager/staff", label: "Staff", key: "staff" as const, icon: Users },
    { href: "/manager/inventory", label: "Inventory", key: "inventory" as const, icon: PackagePlus },
  ];

  return (
    <nav
      aria-label="Manager sections"
      className="inline-flex items-center gap-1 rounded-2xl border border-border bg-card p-1 shadow-card"
    >
      {tabs.map((tab) => {
        const active = tab.key === current;
        const Icon = tab.icon;
        return (
          <a
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              active
                ? "bg-primary text-cream"
                : "text-muted hover:bg-well hover:text-foreground",
            )}
          >
            <Icon aria-hidden="true" className="size-4" />
            {tab.label}
          </a>
        );
      })}
    </nav>
  );
}
