import { RefreshCw } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useSandbox } from "@/lib/store";
import { cn } from "@/lib/utils";

const formatDelay = (ms: number) => (ms >= 60_000 ? `${ms / 60_000}m` : `${ms / 1000}s`);

/** Toolbar toggle for automatic webhook retries, showing the active backoff schedule. */
export function RetryControl() {
  const retry = useSandbox((state) => state.config?.retry ?? null);
  const updateConfig = useSandbox((state) => state.updateConfig);
  if (!retry) return null;

  return (
    <div
      className={cn(
        "flex h-8 items-center gap-2.5 rounded-lg border border-border bg-surface-raised pr-2 pl-3 text-[13px]",
        !retry.enabled && "text-muted",
      )}
      title={`Failed deliveries are retried after ${retry.scheduleMs.map(formatDelay).join(", ")}`}
    >
      <RefreshCw className={cn("size-3.5", retry.enabled ? "text-accent" : "text-subtle")} />
      <span className="font-medium">Auto-retry</span>
      <span className="font-mono text-[11px] text-subtle max-sm:hidden">
        {retry.scheduleMs.map(formatDelay).join(" · ")}
      </span>
      <Switch
        label="Toggle automatic webhook retries"
        checked={retry.enabled}
        onCheckedChange={(enabled) => void updateConfig({ retry: { enabled } })}
        className={cn(retry.enabled && "bg-accent")}
      />
    </div>
  );
}
