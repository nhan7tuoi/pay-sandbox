import { Eye, EyeOff, Info } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { CopyButton } from "@/components/ui/copy-button";
import { ProviderDot } from "@/components/ui/provider-badge";
import { useSandbox } from "@/lib/store";
import type { ProviderDescription, ProviderSetting } from "@/lib/types";
import { cn } from "@/lib/utils";

const mask = (value: string) => (value.length <= 8 ? "••••••••" : `${value.slice(0, 4)}••••••${value.slice(-4)}`);

function SettingField({ provider, setting }: { provider: ProviderDescription; setting: ProviderSetting }) {
  const updateProviderSettings = useSandbox((state) => state.updateProviderSettings);
  const [value, setValue] = useState(setting.value);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => setValue(setting.value), [setting.value]);

  const dirty = value !== setting.value;
  const commit = () => {
    if (dirty && value.trim()) void updateProviderSettings(provider.name, { [setting.key]: value.trim() });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    commit();
  };

  const labelEl = (
    <span className="flex shrink-0 items-center gap-1 font-sans text-[11px] text-subtle">
      {setting.label}
      {setting.hint ? (
        <span title={setting.hint} className="cursor-help">
          <Info className="size-3" />
        </span>
      ) : null}
    </span>
  );

  if (setting.kind === "select" && setting.options) {
    return (
      <label className="flex h-8 items-center gap-2 rounded-lg border border-border bg-surface pr-1 pl-2.5">
        {labelEl}
        <select
          value={setting.value}
          disabled={!setting.editable}
          onChange={(event) => void updateProviderSettings(provider.name, { [setting.key]: event.target.value })}
          className="h-6 rounded-md bg-surface-raised px-1.5 font-mono text-[12px] focus:outline-none"
        >
          {setting.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  const isSecret = setting.kind === "secret";
  const editable = setting.editable && (!isSecret || revealed);

  return (
    <form
      onSubmit={submit}
      className={cn(
        "flex h-8 min-w-0 items-center gap-2 rounded-lg border bg-surface pr-0.5 pl-2.5",
        setting.kind === "url" ? "grow basis-[26rem]" : "",
        dirty ? "border-accent/50" : "border-border",
      )}
    >
      {labelEl}
      {editable ? (
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={commit}
          spellCheck={false}
          aria-label={`${provider.displayName} ${setting.label}`}
          className="h-full min-w-0 flex-1 bg-transparent font-mono text-[12px] text-foreground focus:outline-none"
          size={Math.min(Math.max(value.length, 8), 44)}
        />
      ) : (
        <span className="min-w-0 truncate font-mono text-[12px] text-muted">{isSecret ? mask(setting.value) : setting.value}</span>
      )}
      {isSecret ? (
        <button
          type="button"
          onClick={() => setRevealed((current) => !current)}
          aria-label={revealed ? "Hide value" : "Reveal and edit value"}
          className="grid size-6 shrink-0 place-items-center rounded-md text-subtle hover:bg-surface-raised hover:text-foreground"
        >
          {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      ) : null}
      <CopyButton value={setting.value} label={`Copy ${setting.label}`} />
    </form>
  );
}

function EndpointChip({ method, url, label }: { method: string; url: string; label: string }) {
  return (
    <span className="flex h-8 min-w-0 items-center gap-2 rounded-lg border border-border bg-surface pr-0.5 pl-2 font-mono text-[12px]">
      <span className="rounded bg-accent/15 px-1 text-[10px] font-semibold text-accent">{method}</span>
      <span className="font-sans text-[11px] text-subtle">{label}</span>
      <span className="min-w-0 truncate text-muted">{url}</span>
      <CopyButton value={url} label={`Copy ${label} URL`} />
    </span>
  );
}

/**
 * Credentials and endpoints of the selected provider, so they can be copied
 * into the app under test. On the "All" tab it lists every gateway's entry point.
 */
export function ProviderSettingsBar() {
  const filter = useSandbox((state) => state.providerFilter);
  const providers = useSandbox((state) => state.config?.providers ?? null);
  if (!providers) return null;

  if (filter === "all") {
    return (
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        {providers.map((provider) => {
          const endpoint = provider.endpoints[0];
          if (!endpoint) return null;
          return (
            <span key={provider.name} className="flex min-w-0 items-center gap-1.5">
              <ProviderDot provider={provider.name} />
              <EndpointChip method={endpoint.method} url={endpoint.url} label={provider.displayName} />
            </span>
          );
        })}
      </div>
    );
  }

  const provider = providers.find((item) => item.name === filter);
  if (!provider) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
      {provider.settings.map((setting) => (
        <SettingField key={setting.key} provider={provider} setting={setting} />
      ))}
      {provider.endpoints.map((endpoint) => (
        <EndpointChip key={endpoint.label} {...endpoint} />
      ))}
    </div>
  );
}
