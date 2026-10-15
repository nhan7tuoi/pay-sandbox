import { AlertTriangle, Clock, Hourglass, Info, Pencil, RotateCcw, Send, ShieldAlert, Undo2, Unplug, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { JsonView } from "@/components/JsonView";
import { LazyJsonEditor, preloadJsonEditor } from "@/components/LazyJsonEditor";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Kbd } from "@/components/ui/kbd";
import { ProviderBadge } from "@/components/ui/provider-badge";
import { RetryBadge } from "@/components/ui/retry-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { useSandbox } from "@/lib/store";
import type { SignatureMode, WebhookDelivery, WebhookLog } from "@/lib/types";
import { cn, formatClock, formatDuration, formatRelative, latestDelivery, prettyJson, prettyMaybeJson } from "@/lib/utils";

type Tab = "payload" | "request" | "response" | "attempts";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || !!target.closest(".cm-editor");
}

export function WebhookDetail({ log }: { log: WebhookLog }) {
  const replay = useSandbox((state) => state.replay);
  const fire = useSandbox((state) => state.fire);

  const [tab, setTab] = useState<Tab>("payload");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => prettyJson(log.payload));
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"replay" | "fire" | null>(null);
  const [signatureMode, setSignatureMode] = useState<SignatureMode>("valid");

  const delivery = latestDelivery(log);
  const original = prettyJson(log.payload);

  const startEditing = () => {
    setDraft(original);
    setParseError(null);
    setSignatureMode("valid");
    setTab("payload");
    setEditing(true);
  };

  const runReplay = async () => {
    setBusy("replay");
    await replay(log.id);
    setBusy(null);
  };

  const runFire = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (error) {
      setParseError(error instanceof Error ? error.message : "Invalid JSON");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setParseError("The payload must be a JSON object.");
      return;
    }
    setBusy("fire");
    await fire(log.provider, parsed as Record<string, unknown>, signatureMode);
    setBusy(null);
    setEditing(false);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        if (editing && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void runFire();
        }
        return;
      }
      if (isTypingTarget(event.target)) return;
      if (event.key === "r" && !editing) {
        event.preventDefault();
        void runReplay();
      } else if (event.key === "e" && !editing) {
        event.preventDefault();
        startEditing();
      } else if (event.key === "Escape" && editing) {
        setEditing(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "payload", label: "Payload" },
    { id: "request", label: "Request" },
    { id: "response", label: "Response" },
    { id: "attempts", label: "Attempts", count: log.deliveries.length },
  ];

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-5 pt-4 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <StatusBadge delivery={delivery} />
              <ProviderBadge provider={log.provider} />
              <h2 className="truncate font-mono text-[15px] font-medium tracking-tight">{log.type}</h2>
              <RetryBadge log={log} />
              {log.signatureMode === "invalid" ? (
                <span className="inline-flex h-5 items-center gap-1 rounded-md bg-danger/10 px-1.5 text-[11px] text-danger ring-1 ring-danger/25 ring-inset">
                  <ShieldAlert className="size-3" />
                  wrong signature
                </span>
              ) : null}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
              <span className="inline-flex items-center gap-1 font-mono text-muted">
                {log.eventId}
                <CopyButton value={log.eventId} label="Copy event ID" className="size-5" />
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3" />
                {formatRelative(log.createdAt)}
              </span>
              {delivery ? <span className="font-mono tabular-nums">{formatDuration(delivery.durationMs)}</span> : null}
              {log.summary ? <span className="text-muted">{log.summary}</span> : null}
              {log.provider === "stripe" && typeof log.payload.api_version === "string" ? (
                <span className="font-mono">{log.payload.api_version}</span>
              ) : null}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {editing ? (
              <>
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  <X />
                  Cancel
                </Button>
                <Button variant="ghost" onClick={() => setDraft(original)} disabled={draft === original}>
                  <Undo2 />
                  Reset
                </Button>
                <Button variant="primary" onClick={() => void runFire()} disabled={busy !== null}>
                  <Send />
                  {busy === "fire" ? "Firing…" : "Fire"}
                  <span className="ml-0.5 font-mono text-[10px] opacity-60">⌘↵</span>
                </Button>
              </>
            ) : (
              <>
                <Button onClick={() => void runReplay()} disabled={busy !== null} title="Replay (r)">
                  <RotateCcw className={cn(busy === "replay" && "animate-spin")} />
                  Replay
                  <Kbd>R</Kbd>
                </Button>
                <Button
                  onClick={startEditing}
                  onPointerEnter={preloadJsonEditor}
                  onFocus={preloadJsonEditor}
                  title="Edit & Fire (e)"
                >
                  <Pencil />
                  Edit &amp; Fire
                  <Kbd>E</Kbd>
                </Button>
              </>
            )}
          </div>
        </div>

        <nav className="mt-4 -mb-3 flex gap-1" aria-label="Detail sections">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={cn(
                "relative px-2.5 pb-2.5 text-[13px] transition-colors",
                tab === item.id ? "text-foreground" : "text-subtle hover:text-muted",
              )}
            >
              {item.label}
              {item.count !== undefined ? (
                <span className="ml-1.5 rounded bg-surface-raised px-1 font-mono text-[10px] text-muted">{item.count}</span>
              ) : null}
              {tab === item.id ? <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" /> : null}
            </button>
          ))}
        </nav>
      </header>

      {editing && parseError ? (
        <div className="flex items-center gap-2 border-b border-danger/20 bg-danger/10 px-5 py-2 text-xs text-danger">
          <AlertTriangle className="size-3.5 shrink-0" />
          {parseError}
        </div>
      ) : null}
      {editing ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-accent/5 px-5 py-2 text-xs text-muted">
          <span className="min-w-0 flex-1">
            Editing a copy. <span className="text-foreground">Fire</span> re-signs it and records it as a new webhook with
            its own retries.
          </span>
          <span className="flex items-center gap-0.5 rounded-lg bg-surface p-0.5" role="radiogroup" aria-label="Signature">
            {(
              [
                ["valid", "Valid signature"],
                ["invalid", "Wrong signature"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={signatureMode === mode}
                onClick={() => setSignatureMode(mode)}
                className={cn(
                  "rounded-md px-2 py-1 transition-colors",
                  signatureMode === mode
                    ? mode === "invalid"
                      ? "bg-danger/15 text-danger"
                      : "bg-surface-raised text-foreground"
                    : "text-subtle hover:text-muted",
                )}
              >
                {label}
              </button>
            ))}
          </span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "payload" ? (
          editing ? (
            <LazyJsonEditor
              value={draft}
              onChange={(value) => {
                setDraft(value);
                setParseError(null);
              }}
            />
          ) : (
            <JsonView value={original} />
          )
        ) : null}
        {tab === "request" ? <RequestPanel delivery={delivery} /> : null}
        {tab === "response" ? <ResponsePanel delivery={delivery} /> : null}
        {tab === "attempts" ? <AttemptsPanel log={log} /> : null}
      </div>
    </section>
  );
}

function EmptyPanel({ children }: { children: ReactNode }) {
  return <p className="px-5 py-10 text-center text-sm text-subtle">{children}</p>;
}

function KeyValueTable({ entries }: { entries: Array<[string, string]> }) {
  return (
    <dl className="divide-y divide-border overflow-hidden rounded-lg border border-border">
      {entries.map(([key, value]) => (
        <div key={key} className="grid grid-cols-[minmax(120px,200px)_1fr_auto] items-start gap-3 px-3 py-2 font-mono text-[12px]">
          <dt className="break-all text-muted">{key}</dt>
          <dd className="break-all text-foreground">{value}</dd>
          <CopyButton value={value} label={`Copy ${key}`} className="size-5" />
        </div>
      ))}
    </dl>
  );
}

function RequestPanel({ delivery }: { delivery: WebhookDelivery | undefined }) {
  if (!delivery) return <EmptyPanel>Delivery in progress…</EmptyPanel>;

  const [target, query = ""] = delivery.url.split("?", 2) as [string, string?];
  const queryEntries = [...new URLSearchParams(query).entries()];
  const body = delivery.requestBody ? prettyMaybeJson(delivery.requestBody) : null;
  const formEntries =
    body && !body.isJson && delivery.requestHeaders["content-type"]?.includes("x-www-form-urlencoded")
      ? [...new URLSearchParams(delivery.requestBody).entries()]
      : null;

  return (
    <div className="space-y-5 p-5">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[12.5px]">
        <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-semibold text-accent">{delivery.method}</span>
        <span className="min-w-0 flex-1 truncate">{target}</span>
        <CopyButton value={delivery.url} label="Copy full URL" />
      </div>

      {queryEntries.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-subtle">Query parameters</h3>
          <KeyValueTable entries={queryEntries} />
        </section>
      ) : null}

      <section className="space-y-2">
        <h3 className="text-xs font-medium text-subtle">Headers</h3>
        <KeyValueTable entries={Object.entries(delivery.requestHeaders)} />
      </section>

      {formEntries ? (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-subtle">Form body</h3>
          <KeyValueTable entries={formEntries} />
        </section>
      ) : body ? (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-subtle">Body</h3>
          <div className="overflow-hidden rounded-lg border border-border bg-background/40">
            <JsonView value={body.text} json={body.isJson} />
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ResponsePanel({ delivery }: { delivery: WebhookDelivery | undefined }) {
  if (!delivery) return <EmptyPanel>Waiting for your endpoint to respond…</EmptyPanel>;
  const body = prettyMaybeJson(delivery.responseBody);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3 text-xs">
        <StatusBadge delivery={delivery} />
        <span className="font-mono text-muted tabular-nums">{formatDuration(delivery.durationMs)}</span>
        <span className="text-subtle">{formatClock(delivery.attemptedAt)}</span>
        <ChaosTags delivery={delivery} />
      </div>
      {delivery.note ? (
        <div
          className={cn(
            "mx-5 mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px]",
            delivery.ok ? "border-border bg-surface text-muted" : "border-warning/25 bg-warning/10 text-warning",
          )}
        >
          <Info className="mt-0.5 size-3.5 shrink-0" />
          {delivery.note}
        </div>
      ) : null}
      {delivery.error ? (
        <div className="m-5 flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger/10 px-3.5 py-3 text-[13px] text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">{delivery.chaos?.dropped ? "Dropped by Chaos Mode" : "Delivery failed"}</p>
            <p className="mt-0.5 font-mono text-xs opacity-90">{delivery.error}</p>
          </div>
        </div>
      ) : delivery.responseBody.length === 0 ? (
        <EmptyPanel>Empty response body{delivery.statusCode === 204 ? " (204 No Content)" : ""}.</EmptyPanel>
      ) : (
        <JsonView value={body.text} json={body.isJson} />
      )}
    </div>
  );
}

function ChaosTags({ delivery }: { delivery: WebhookDelivery }) {
  if (!delivery.chaos) return null;
  return (
    <span className="flex items-center gap-1.5">
      {delivery.chaos.dropped ? (
        <span className="inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">
          <Unplug className="size-3" />
          dropped
        </span>
      ) : null}
      {delivery.chaos.delayMs > 0 ? (
        <span className="inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] text-warning">
          <Hourglass className="size-3" />+{formatDuration(delivery.chaos.delayMs)}
        </span>
      ) : null}
    </span>
  );
}

function attemptLabel(delivery: WebhookDelivery, maxRetries: number): string {
  if (delivery.trigger === "replay") return "Manual replay";
  if (delivery.trigger === "retry") return `Automatic retry ${(delivery.attempt ?? 1) - 1}/${maxRetries}`;
  return "First delivery";
}

function AttemptsPanel({ log }: { log: WebhookLog }) {
  const { deliveries } = log;
  if (deliveries.length === 0) return <EmptyPanel>No delivery attempts yet.</EmptyPanel>;

  return (
    <div className="space-y-3 p-5">
      <RetryBadge log={log} />
      <ol className="space-y-2">
        {[...deliveries].reverse().map((delivery, index) => (
          <li
            key={delivery.id}
            className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-[13px]"
          >
            <StatusBadge delivery={delivery} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2 text-foreground">
                {attemptLabel(delivery, log.max_retries)}
                {index === 0 ? <span className="text-[11px] text-accent">latest</span> : null}
                <ChaosTags delivery={delivery} />
              </span>
              <span className="block truncate font-mono text-[11px] text-subtle">{delivery.error ?? delivery.url}</span>
            </span>
            <span className="flex shrink-0 flex-col items-end font-mono text-[11px] tabular-nums">
              <span className="text-muted">{formatClock(delivery.attemptedAt)}</span>
              <span className="text-subtle">{formatDuration(delivery.durationMs)}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
