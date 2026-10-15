import type { ProviderName } from "../types.js";
import type { BaseProvider, TriggerDefinition } from "./types.js";

export const PROVIDER_NAMES: ProviderName[] = ["stripe", "momo", "zalopay", "vnpay"];

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDER_NAMES as string[]).includes(value);
}

/**
 * Holds the active provider adapters. The dispatcher receives the registry
 * before adapters are registered, which breaks the dispatcher ↔ provider cycle.
 */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderName, BaseProvider>();

  register(provider: BaseProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: ProviderName): BaseProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new Error(`Provider '${name}' is not registered`);
    return provider;
  }

  find(name: string): BaseProvider | undefined {
    return isProviderName(name) ? this.providers.get(name) : undefined;
  }

  all(): BaseProvider[] {
    return PROVIDER_NAMES.flatMap((name) => {
      const provider = this.providers.get(name);
      return provider ? [provider] : [];
    });
  }

  triggers(): TriggerDefinition[] {
    return this.all().flatMap((provider) => provider.triggers());
  }

  findTrigger(id: string): TriggerDefinition | undefined {
    return this.triggers().find((trigger) => trigger.id === id);
  }

  resetAll(): void {
    for (const provider of this.providers.values()) provider.reset();
  }
}
