import { cn, deliveryLabel, deliveryTone } from "@/lib/utils";
import type { WebhookDelivery } from "@/lib/types";

const TONES = {
  pending: "bg-surface-raised text-muted ring-border",
  success: "bg-success/10 text-success ring-success/25",
  warning: "bg-warning/10 text-warning ring-warning/25",
  danger: "bg-danger/10 text-danger ring-danger/25",
} as const;

export function StatusBadge({ delivery, className }: { delivery: WebhookDelivery | undefined; className?: string }) {
  const tone = deliveryTone(delivery);
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-10 items-center justify-center gap-1 rounded-md px-1.5 font-mono text-[11px] font-medium ring-1 ring-inset tabular-nums",
        TONES[tone],
        className,
      )}
    >
      {tone === "pending" ? <span className="size-1.5 animate-pulse-dot rounded-full bg-current" /> : null}
      {deliveryLabel(delivery)}
    </span>
  );
}
