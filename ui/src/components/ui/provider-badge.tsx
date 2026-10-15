import { PROVIDER_META } from "@/lib/providers";
import type { ProviderName } from "@/lib/types";
import { cn } from "@/lib/utils";

export function ProviderDot({ provider, className }: { provider: ProviderName; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-1.5 shrink-0 rounded-full", className)}
      style={{ backgroundColor: PROVIDER_META[provider].color }}
    />
  );
}

export function ProviderBadge({ provider, className }: { provider: ProviderName; className?: string }) {
  const meta = PROVIDER_META[provider];
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-raised px-1.5 text-[11px] font-medium text-muted",
        className,
      )}
    >
      <ProviderDot provider={provider} />
      {meta.label}
    </span>
  );
}
