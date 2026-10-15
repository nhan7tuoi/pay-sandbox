import { RefreshCw, XOctagon } from "lucide-react";
import type { WebhookLog } from "@/lib/types";
import { useNow } from "@/lib/useNow";
import { cn, formatCountdown, retryInfo } from "@/lib/utils";

const TONES = {
  warning: "bg-warning/10 text-warning ring-warning/25",
  danger: "bg-danger/10 text-danger ring-danger/25",
} as const;

/** Shows `Failed (Retrying 2/3…) · 8s` or `Failed (Max retries exceeded)` for a webhook log. */
export function RetryBadge({ log, className }: { log: WebhookLog; className?: string }) {
  const info = retryInfo(log);
  const now = useNow(info?.nextRetryAt != null);
  if (!info) return null;

  const Icon = info.tone === "warning" ? RefreshCw : XOctagon;

  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-full items-center gap-1 rounded-md px-1.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset",
        TONES[info.tone],
        className,
      )}
    >
      <Icon className={cn("size-3 shrink-0", info.tone === "warning" && info.nextRetryAt === null && "animate-spin")} />
      <span className="truncate">{info.label}</span>
      {info.nextRetryAt != null ? (
        <span className="font-mono tabular-nums opacity-75">· {formatCountdown(info.nextRetryAt, now)}</span>
      ) : null}
    </span>
  );
}
