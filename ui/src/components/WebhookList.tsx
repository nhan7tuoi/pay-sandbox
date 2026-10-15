import { Inbox, RotateCcw } from "lucide-react";
import { useEffect, useRef } from "react";
import { ProviderDot } from "@/components/ui/provider-badge";
import { RetryBadge } from "@/components/ui/retry-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import type { WebhookLog } from "@/lib/types";
import { cn, formatClock, formatDuration, latestDelivery } from "@/lib/utils";

const SOURCE_LABEL: Record<WebhookLog["source"], string> = {
  api: "api",
  trigger: "trigger",
  manual: "edited",
  checkout: "checkout",
};

interface WebhookListProps {
  logs: WebhookLog[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function WebhookList({ logs, selectedId, onSelect }: WebhookListProps) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  if (logs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16 text-center">
        <div className="grid size-11 place-items-center rounded-xl border border-border bg-surface-raised">
          <Inbox className="size-5 text-subtle" />
        </div>
        <div>
          <p className="text-sm font-medium">No webhooks yet</p>
          <p className="mt-1 text-xs leading-relaxed text-subtle">
            Call the mock API or use <span className="text-muted">Quick Trigger</span> to fire your first event.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-px p-1.5" role="listbox" aria-label="Webhook activity">
      {logs.map((log) => {
        const delivery = latestDelivery(log);
        const selected = log.id === selectedId;
        const replays = log.deliveries.filter((item) => item.trigger === "replay").length;

        return (
          <li key={log.id} className="animate-slide-in">
            <button
              ref={selected ? selectedRef : undefined}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => onSelect(log.id)}
              className={cn(
                "group relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                selected ? "bg-surface-raised" : "hover:bg-surface-raised/60",
              )}
            >
              <span
                className={cn(
                  "absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent transition-opacity",
                  selected ? "opacity-100" : "opacity-0",
                )}
              />
              <StatusBadge delivery={delivery} />

              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <ProviderDot provider={log.provider} />
                  <span className="truncate font-mono text-[12.5px] text-foreground">{log.type}</span>
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-subtle">
                  <span className="truncate font-mono">{log.summary ?? log.eventId}</span>
                  <span aria-hidden>·</span>
                  <span className="shrink-0">{SOURCE_LABEL[log.source]}</span>
                  {replays > 0 ? (
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-muted">
                      <RotateCcw className="size-2.5" />
                      {replays}
                    </span>
                  ) : null}
                </span>
                <RetryBadge log={log} className="mt-1.5" />
              </span>

              <span className="flex shrink-0 flex-col items-end gap-0.5 font-mono text-[11px] tabular-nums">
                <span className="text-muted">{formatClock(log.createdAt)}</span>
                <span className="text-subtle">{delivery ? formatDuration(delivery.durationMs) : "—"}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
