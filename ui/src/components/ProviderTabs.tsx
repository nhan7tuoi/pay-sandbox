import { useMemo } from "react";
import { ProviderDot } from "@/components/ui/provider-badge";
import { PROVIDER_TABS } from "@/lib/providers";
import { useSandbox } from "@/lib/store";
import type { ProviderName } from "@/lib/types";
import { cn } from "@/lib/utils";

/** `All | Stripe | MoMo | ZaloPay | VNPay` switcher with a webhook count per provider. */
export function ProviderTabs() {
  const logs = useSandbox((state) => state.logs);
  const filter = useSandbox((state) => state.providerFilter);
  const setFilter = useSandbox((state) => state.setProviderFilter);

  const counts = useMemo(() => {
    const result: Record<string, number> = { all: logs.length };
    for (const log of logs) result[log.provider] = (result[log.provider] ?? 0) + 1;
    return result;
  }, [logs]);

  return (
    <nav
      aria-label="Payment provider"
      className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-border bg-surface p-0.5"
    >
      {PROVIDER_TABS.map((tab) => {
        const active = tab.id === filter;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => setFilter(tab.id)}
            aria-pressed={active}
            className={cn(
              "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors",
              active ? "bg-surface-raised text-foreground shadow-sm" : "text-subtle hover:text-muted",
            )}
          >
            {tab.id !== "all" ? <ProviderDot provider={tab.id as ProviderName} /> : null}
            {tab.label}
            <span className={cn("font-mono text-[10px] tabular-nums", active ? "text-muted" : "text-subtle")}>
              {counts[tab.id] ?? 0}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
