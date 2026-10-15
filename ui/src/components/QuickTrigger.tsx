import { ChevronDown, Zap } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import { ProviderDot } from "@/components/ui/provider-badge";
import { PROVIDER_META } from "@/lib/providers";
import { useSandbox } from "@/lib/store";
import type { ProviderName, TriggerInfo } from "@/lib/types";

const NO_TRIGGERS: TriggerInfo[] = [];

/** Quick Trigger menu, grouped by provider and narrowed to the selected provider tab. */
export function QuickTrigger() {
  const triggers = useSandbox((state) => state.config?.triggers ?? NO_TRIGGERS);
  const filter = useSandbox((state) => state.providerFilter);
  const trigger = useSandbox((state) => state.trigger);
  const [running, setRunning] = useState<string | null>(null);

  const visible = filter === "all" ? triggers : triggers.filter((item) => item.provider === filter);
  const groups = visible.reduce<Array<{ provider: ProviderName; items: TriggerInfo[] }>>((acc, item) => {
    const group = acc.find((entry) => entry.provider === item.provider);
    if (group) group.items.push(item);
    else acc.push({ provider: item.provider, items: [item] });
    return acc;
  }, []);

  const run = async (id: string, close: () => void) => {
    setRunning(id);
    await trigger(id);
    setRunning(null);
    close();
  };

  return (
    <Popover
      className="max-h-[70vh] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto"
      trigger={({ open, toggle }) => (
        <Button onClick={toggle} aria-expanded={open}>
          <Zap className="text-accent" />
          Quick Trigger
          <ChevronDown className="text-subtle" />
        </Button>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-1">
          {groups.map((group) => (
            <section key={group.provider}>
              <p className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">
                <ProviderDot provider={group.provider} />
                {PROVIDER_META[group.provider].label}
              </p>
              <ul className="flex flex-col">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      disabled={running !== null}
                      onClick={() => void run(item.id, close)}
                      className="flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface-raised disabled:opacity-50"
                    >
                      <span className="truncate text-[13px] text-foreground">
                        {item.provider === "stripe" ? <span className="font-mono text-[12.5px]">{item.label}</span> : item.label}
                      </span>
                      <span className="truncate text-xs text-subtle">{running === item.id ? "Firing…" : item.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {groups.length === 0 ? <p className="px-2.5 py-3 text-xs text-subtle">No triggers for this provider.</p> : null}
        </div>
      )}
    </Popover>
  );
}
