import { Flame } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { useSandbox } from "@/lib/store";
import type { ApiChaosConfig, ChaosConfig, WebhookChaosConfig } from "@/lib/types";
import { cn } from "@/lib/utils";

const DEFAULT_CHAOS: ChaosConfig = {
  api: { enabled: false, minDelayMs: 1_000, maxDelayMs: 5_000, errorRate: 0 },
  webhooks: { latencyEnabled: false, minDelayMs: 1_000, maxDelayMs: 5_000, dropEnabled: false, dropRate: 0.15 },
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(2).replace(/\.?0+$/, "")}s`;
const percent = (value: number) => `${Math.round(value * 100)}%`;

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  onCommit: () => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="font-mono text-foreground tabular-nums">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-warning"
      />
    </label>
  );
}

function ChaosSection({
  title,
  description,
  checked,
  onCheckedChange,
  children,
}: {
  title: string;
  description: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-background/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium">{title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-subtle">{description}</p>
        </div>
        <Switch label={title} checked={checked} onCheckedChange={onCheckedChange} />
      </div>
      <div className={cn("space-y-3 transition-opacity", !checked && "pointer-events-none opacity-40")}>{children}</div>
    </div>
  );
}

export function ChaosControl() {
  const chaos = useSandbox((state) => state.config?.chaos ?? DEFAULT_CHAOS);
  const updateConfig = useSandbox((state) => state.updateConfig);
  const [api, setApi] = useState<ApiChaosConfig>(chaos.api);
  const [webhooks, setWebhooks] = useState<WebhookChaosConfig>(chaos.webhooks);

  useEffect(() => setApi(chaos.api), [chaos.api]);
  useEffect(() => setWebhooks(chaos.webhooks), [chaos.webhooks]);

  const commitApi = (patch: Partial<ApiChaosConfig> = {}) => {
    const next = { ...api, ...patch };
    setApi(next);
    void updateConfig({ chaos: { api: next } });
  };

  const commitWebhooks = (patch: Partial<WebhookChaosConfig> = {}) => {
    const next = { ...webhooks, ...patch };
    setWebhooks(next);
    void updateConfig({ chaos: { webhooks: next } });
  };

  const activeCount = [chaos.api.enabled, chaos.webhooks.latencyEnabled, chaos.webhooks.dropEnabled].filter(Boolean).length;
  const active = activeCount > 0;

  return (
    <Popover
      align="start"
      className="max-h-[75vh] w-[min(22rem,calc(100vw-2rem))] space-y-2 overflow-y-auto p-2"
      trigger={({ open, toggle }) => (
        <Button
          onClick={toggle}
          aria-expanded={open}
          className={cn(active && "border-warning/40 bg-warning/10 text-warning hover:bg-warning/15")}
        >
          <Flame className={active ? "text-warning" : "text-subtle"} />
          Chaos Mode
          <span
            className={cn(
              "rounded px-1 font-mono text-[10px] uppercase",
              active ? "bg-warning/20 text-warning" : "bg-border text-subtle",
            )}
          >
            {active ? `${activeCount} on` : "off"}
          </span>
        </Button>
      )}
    >
      {() => (
        <>
          <p className="px-1.5 pt-1 text-[11px] font-medium tracking-wide text-subtle uppercase">Mock API · /v1</p>
          <ChaosSection
            title="API latency & errors"
            description="Slows down or fails Stripe API calls to exercise timeouts and SDK retries."
            checked={api.enabled}
            onCheckedChange={(enabled) => commitApi({ enabled })}
          >
            <Slider
              label="Min latency"
              value={api.minDelayMs}
              min={0}
              max={5_000}
              step={250}
              format={seconds}
              onChange={(minDelayMs) =>
                setApi((value) => ({ ...value, minDelayMs, maxDelayMs: Math.max(value.maxDelayMs, minDelayMs) }))
              }
              onCommit={() => commitApi()}
            />
            <Slider
              label="Max latency"
              value={api.maxDelayMs}
              min={0}
              max={5_000}
              step={250}
              format={seconds}
              onChange={(maxDelayMs) =>
                setApi((value) => ({ ...value, maxDelayMs, minDelayMs: Math.min(value.minDelayMs, maxDelayMs) }))
              }
              onCommit={() => commitApi()}
            />
            <Slider
              label="Forced 500 rate"
              value={api.errorRate}
              min={0}
              max={1}
              step={0.05}
              format={percent}
              onChange={(errorRate) => setApi((value) => ({ ...value, errorRate }))}
              onCommit={() => commitApi()}
            />
          </ChaosSection>

          <p className="px-1.5 pt-2 text-[11px] font-medium tracking-wide text-subtle uppercase">Webhook dispatcher</p>
          <ChaosSection
            title="Webhook Latency Spike"
            description="Waits a random 1–5s before each delivery to your app, including retries."
            checked={webhooks.latencyEnabled}
            onCheckedChange={(latencyEnabled) => commitWebhooks({ latencyEnabled })}
          >
            <Slider
              label="Min delay"
              value={webhooks.minDelayMs}
              min={0}
              max={5_000}
              step={250}
              format={seconds}
              onChange={(minDelayMs) =>
                setWebhooks((value) => ({ ...value, minDelayMs, maxDelayMs: Math.max(value.maxDelayMs, minDelayMs) }))
              }
              onCommit={() => commitWebhooks()}
            />
            <Slider
              label="Max delay"
              value={webhooks.maxDelayMs}
              min={0}
              max={5_000}
              step={250}
              format={seconds}
              onChange={(maxDelayMs) =>
                setWebhooks((value) => ({ ...value, maxDelayMs, minDelayMs: Math.min(value.minDelayMs, maxDelayMs) }))
              }
              onCommit={() => commitWebhooks()}
            />
          </ChaosSection>

          <ChaosSection
            title="Simulate Dropped Webhook"
            description="Drops a share of first delivery attempts. Retries still go through, so you can test retry handling and reconciliation."
            checked={webhooks.dropEnabled}
            onCheckedChange={(dropEnabled) => commitWebhooks({ dropEnabled })}
          >
            <Slider
              label="Drop rate"
              value={webhooks.dropRate}
              min={0.05}
              max={0.5}
              step={0.05}
              format={percent}
              onChange={(dropRate) => setWebhooks((value) => ({ ...value, dropRate }))}
              onCommit={() => commitWebhooks()}
            />
          </ChaosSection>
        </>
      )}
    </Popover>
  );
}
