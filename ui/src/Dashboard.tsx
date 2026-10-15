import { AlertTriangle, Search, Star, Trash2, Webhook, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ChaosControl } from "@/components/ChaosControl";
import { ProviderSettingsBar } from "@/components/ProviderSettingsBar";
import { ProviderTabs } from "@/components/ProviderTabs";
import { QuickTrigger } from "@/components/QuickTrigger";
import { RetryControl } from "@/components/RetryControl";
import { WebhookDetail } from "@/components/WebhookDetail";
import { WebhookList } from "@/components/WebhookList";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useSandbox } from "@/lib/store";
import type { ConnectionState } from "@/lib/types";
import { cn, isFailedLog } from "@/lib/utils";

type StatusFilter = "all" | "success" | "failed";

const CONNECTION_STYLES: Record<ConnectionState, { dot: string; label: string }> = {
  live: { dot: "bg-success", label: "Live" },
  connecting: { dot: "bg-warning", label: "Connecting" },
  offline: { dot: "bg-subtle", label: "Demo data" },
};

export function Dashboard() {
  const connect = useSandbox((state) => state.connect);
  const logs = useSandbox((state) => state.logs);
  const selectedId = useSandbox((state) => state.selectedId);
  const select = useSandbox((state) => state.select);
  const selectRelative = useSandbox((state) => state.selectRelative);
  const clearLogs = useSandbox((state) => state.clearLogs);
  const demo = useSandbox((state) => state.demo);
  const error = useSandbox((state) => state.error);
  const dismissError = useSandbox((state) => state.dismissError);
  const providerFilter = useSandbox((state) => state.providerFilter);

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  useEffect(() => connect(), [connect]);

  const providerLogs = useMemo(
    () => (providerFilter === "all" ? logs : logs.filter((log) => log.provider === providerFilter)),
    [logs, providerFilter],
  );

  const visibleLogs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return providerLogs.filter((log) => {
      if (needle) {
        const haystack = [log.type, log.eventId, log.objectId ?? "", log.summary ?? ""].join(" ").toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (statusFilter === "all") return true;
      return statusFilter === "success" ? log.status === "succeeded" : isFailedLog(log);
    });
  }, [providerLogs, query, statusFilter]);

  const selectedLog = providerLogs.find((log) => log.id === selectedId) ?? null;
  const failedCount = providerLogs.filter(isFailedLog).length;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (["INPUT", "TEXTAREA"].includes(target.tagName) || target.closest(".cm-editor"))) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const ids = visibleLogs.map((log) => log.id);
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        selectRelative(1, ids);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        selectRelative(-1, ids);
      } else if (event.key === "/") {
        event.preventDefault();
        document.getElementById("webhook-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visibleLogs, selectRelative]);

  return (
    <div className="flex h-full flex-col">
      <TopBar />

      {demo ? (
        <div className="flex items-center gap-2 border-b border-warning/20 bg-warning/5 px-4 py-2 text-xs text-warning">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>
            Can&apos;t reach pay-sandbox — showing sample webhooks. Run{" "}
            <code className="rounded bg-warning/10 px-1 font-mono">npx pay-sandbox</code> and this page will go live
            automatically.
          </span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <QuickTrigger />
        <ChaosControl />
        <RetryControl />
        <div className="ml-auto flex items-center gap-1 text-xs text-subtle max-md:hidden">
          <Kbd>J</Kbd>
          <Kbd>K</Kbd>
          <span className="mr-2">navigate</span>
          <Kbd>/</Kbd>
          <span>search</span>
        </div>
        <Button
          variant="ghost"
          onClick={() => void clearLogs()}
          disabled={logs.length === 0}
          className="max-md:ml-auto"
        >
          <Trash2 />
          Clear
        </Button>
      </div>

      <ProviderSettingsBar />

      <main className="grid min-h-0 flex-1 grid-rows-[minmax(240px,40%)_1fr] md:grid-cols-[minmax(320px,400px)_1fr] md:grid-rows-1">
        <aside className="flex min-h-0 flex-col border-border max-md:border-b md:border-r">
          <div className="space-y-2 border-b border-border p-3">
            <label className="relative block">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" />
              <input
                id="webhook-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter by type, event, order ID or result"
                className="h-8 w-full rounded-lg border border-border bg-surface pr-3 pl-8 text-[13px] placeholder:text-subtle focus:border-border-strong focus:outline-none"
              />
            </label>
            <div className="flex gap-1 rounded-lg bg-surface p-0.5 text-xs">
              {(
                [
                  ["all", `All ${providerLogs.length}`],
                  ["success", "Succeeded"],
                  ["failed", `Failed ${failedCount}`],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setStatusFilter(value)}
                  className={cn(
                    "flex-1 rounded-md px-2 py-1 transition-colors",
                    statusFilter === value ? "bg-surface-raised text-foreground shadow-sm" : "text-subtle hover:text-muted",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <WebhookList logs={visibleLogs} selectedId={selectedId} onSelect={select} />
          </div>
        </aside>

        <div className="min-h-0 min-w-0 bg-surface/40">
          {selectedLog ? (
            <WebhookDetail key={selectedLog.id} log={selectedLog} />
          ) : (
            <div className="grid h-full place-items-center p-8 text-center">
              <div>
                <Webhook className="mx-auto size-8 text-border-strong" />
                <p className="mt-3 text-sm text-subtle">Select a webhook to inspect its payload and delivery.</p>
              </div>
            </div>
          )}
        </div>
      </main>

      {error ? (
        <div
          role="alert"
          className="fixed right-4 bottom-4 left-4 z-40 flex animate-slide-in items-start gap-3 rounded-xl border border-danger/30 bg-surface px-4 py-3 text-[13px] shadow-2xl shadow-black/60 sm:left-auto sm:max-w-md"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-muted">{error}</p>
          <button type="button" onClick={dismissError} aria-label="Dismiss" className="text-subtle hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function TopBar() {
  const connection = useSandbox((state) => state.connection);
  const status = CONNECTION_STYLES[connection];

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3">
      <div className="flex items-center gap-2.5">
        <div className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent/50 shadow-lg shadow-accent/20">
          <Webhook className="size-4 text-accent-foreground" strokeWidth={2.5} />
        </div>
        <span className="text-[15px] font-semibold tracking-tight">pay-sandbox</span>
        <span className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">
          <span className={cn("size-1.5 rounded-full", status.dot, connection === "live" && "animate-pulse-dot")} />
          {status.label}
        </span>
      </div>
      <ProviderTabs />
      <a
        href="https://github.com/nhan7tuoi/pay-sandbox"
        target="_blank"
        rel="noreferrer"
        className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[13px] text-muted transition-colors hover:border-border-strong hover:text-foreground max-sm:hidden"
      >
        <Star className="size-3.5" />
        Star on GitHub
      </a>
    </header>
  );
}
