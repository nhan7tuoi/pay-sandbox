export interface ApiChaosConfig {
  enabled: boolean;
  /** Minimum artificial latency added to every /v1 response, in milliseconds. */
  minDelayMs: number;
  /** Maximum artificial latency added to every /v1 response, in milliseconds. */
  maxDelayMs: number;
  /** Probability in [0, 1] that a /v1 request is answered with a 500 api_error. */
  errorRate: number;
}

export interface WebhookChaosConfig {
  /** Delay every webhook delivery by a random amount before sending it. */
  latencyEnabled: boolean;
  minDelayMs: number;
  maxDelayMs: number;
  /** Silently drop a share of first delivery attempts so retries/reconciliation kick in. */
  dropEnabled: boolean;
  /** Probability in [0, 1] that a first delivery attempt is dropped. */
  dropRate: number;
}

export interface ChaosConfig {
  api: ApiChaosConfig;
  webhooks: WebhookChaosConfig;
}

export interface RetryConfig {
  enabled: boolean;
  /** Delay before each automatic retry; its length is the maximum number of retries. */
  scheduleMs: number[];
}

export interface MomoConfig {
  partnerCode: string;
  accessKey: string;
  secretKey: string;
  /** Used by Quick Triggers; real create requests carry their own `ipnUrl`. */
  defaultIpnUrl: string;
  defaultRedirectUrl: string;
}

export interface ZaloPayConfig {
  appId: number;
  /** Signs create/query requests (merchant → ZaloPay). */
  key1: string;
  /** Signs callbacks and redirect checksums (ZaloPay → merchant). */
  key2: string;
  /** Used when a create request has no `callback_url`. */
  defaultCallbackUrl: string;
  defaultRedirectUrl: string;
}

export interface VnpayConfig {
  tmnCode: string;
  hashSecret: string;
  /** VNPay sends IPNs to a URL registered in the merchant portal, not per request. */
  ipnUrl: string;
  ipnMethod: "GET" | "POST";
  defaultReturnUrl: string;
}

export interface ProvidersConfig {
  momo: MomoConfig;
  zalopay: ZaloPayConfig;
  vnpay: VnpayConfig;
}

export interface SandboxConfig {
  host: string;
  port: number;
  webhookUrl: string;
  webhookSecret: string;
  apiVersion: string;
  webhookTimeoutMs: number;
  retry: RetryConfig;
  chaos: ChaosConfig;
  providers: ProvidersConfig;
}

export const DEFAULT_CONFIG: SandboxConfig = {
  host: "127.0.0.1",
  port: 4242,
  webhookUrl: "http://localhost:3000/api/webhook",
  webhookSecret: "whsec_test_sandbox_secret",
  apiVersion: "2025-09-30.clover",
  webhookTimeoutMs: 5_000,
  retry: {
    enabled: true,
    scheduleMs: [3_000, 10_000, 30_000],
  },
  chaos: {
    api: {
      enabled: false,
      minDelayMs: 1_000,
      maxDelayMs: 5_000,
      errorRate: 0,
    },
    webhooks: {
      latencyEnabled: false,
      minDelayMs: 1_000,
      maxDelayMs: 5_000,
      dropEnabled: false,
      dropRate: 0.15,
    },
  },
  providers: {
    momo: {
      partnerCode: "MOMOSBX00001",
      accessKey: "paysandboxmomoaccess",
      secretKey: "paysandboxmomosecretkey000000001",
      defaultIpnUrl: "http://localhost:3000/api/momo/ipn",
      defaultRedirectUrl: "http://localhost:3000/payment/momo/return",
    },
    zalopay: {
      appId: 2554,
      key1: "paysandboxzalopaykey1000000000001",
      key2: "paysandboxzalopaykey2000000000002",
      defaultCallbackUrl: "http://localhost:3000/api/zalopay/callback",
      defaultRedirectUrl: "http://localhost:3000/payment/zalopay/return",
    },
    vnpay: {
      tmnCode: "PAYSBX01",
      hashSecret: "PAYSANDBOXVNPAYHASHSECRET0000001",
      ipnUrl: "http://localhost:3000/api/vnpay/ipn",
      ipnMethod: "GET",
      defaultReturnUrl: "http://localhost:3000/payment/vnpay/return",
    },
  },
};

const MAX_DELAY_MS = 30_000;
const MAX_RETRIES = 10;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

export type MutableConfigPatch = Partial<
  Pick<SandboxConfig, "webhookUrl" | "webhookSecret" | "webhookTimeoutMs">
> & {
  retry?: Partial<RetryConfig>;
  chaos?: { api?: Partial<ApiChaosConfig>; webhooks?: Partial<WebhookChaosConfig> };
};

/** Builds a full config from defaults plus a partial override, deep-merging nested sections. */
export function resolveConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    retry: { ...DEFAULT_CONFIG.retry, ...overrides.retry },
    chaos: {
      api: { ...DEFAULT_CONFIG.chaos.api, ...overrides.chaos?.api },
      webhooks: { ...DEFAULT_CONFIG.chaos.webhooks, ...overrides.chaos?.webhooks },
    },
    providers: {
      momo: { ...DEFAULT_CONFIG.providers.momo, ...overrides.providers?.momo },
      zalopay: { ...DEFAULT_CONFIG.providers.zalopay, ...overrides.providers?.zalopay },
      vnpay: { ...DEFAULT_CONFIG.providers.vnpay, ...overrides.providers?.vnpay },
    },
  };
}

export function applyConfigPatch(config: SandboxConfig, patch: MutableConfigPatch): SandboxConfig {
  if (typeof patch.webhookUrl === "string") {
    const parsed = new URL(patch.webhookUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("webhookUrl must use http or https");
    }
    config.webhookUrl = parsed.toString();
  }
  if (typeof patch.webhookSecret === "string") {
    if (patch.webhookSecret.length === 0) {
      throw new Error("webhookSecret must not be empty");
    }
    config.webhookSecret = patch.webhookSecret;
  }
  if (typeof patch.webhookTimeoutMs === "number") {
    config.webhookTimeoutMs = clamp(patch.webhookTimeoutMs, 100, 60_000);
  }

  if (patch.retry) {
    const retry = { ...config.retry };
    if (typeof patch.retry.enabled === "boolean") retry.enabled = patch.retry.enabled;
    if (Array.isArray(patch.retry.scheduleMs)) {
      retry.scheduleMs = parseRetrySchedule(patch.retry.scheduleMs);
    }
    config.retry = retry;
  }

  if (patch.chaos?.api) {
    const api = { ...config.chaos.api, ...patch.chaos.api };
    api.enabled = Boolean(api.enabled);
    api.minDelayMs = clamp(api.minDelayMs, 0, MAX_DELAY_MS);
    api.maxDelayMs = clamp(api.maxDelayMs, api.minDelayMs, MAX_DELAY_MS);
    api.errorRate = clamp(api.errorRate, 0, 1);
    config.chaos = { ...config.chaos, api };
  }

  if (patch.chaos?.webhooks) {
    const webhooks = { ...config.chaos.webhooks, ...patch.chaos.webhooks };
    webhooks.latencyEnabled = Boolean(webhooks.latencyEnabled);
    webhooks.dropEnabled = Boolean(webhooks.dropEnabled);
    webhooks.minDelayMs = clamp(webhooks.minDelayMs, 0, MAX_DELAY_MS);
    webhooks.maxDelayMs = clamp(webhooks.maxDelayMs, webhooks.minDelayMs, MAX_DELAY_MS);
    webhooks.dropRate = clamp(webhooks.dropRate, 0, 1);
    config.chaos = { ...config.chaos, webhooks };
  }

  return config;
}

/** Accepts an absolute http(s) URL and returns its normalized form. */
export function parseHttpUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a URL`);
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} must use http or https`);
  }
  return parsed.toString();
}

/** Validates a retry schedule given in milliseconds. */
export function parseRetrySchedule(values: unknown[]): number[] {
  if (values.length > MAX_RETRIES) {
    throw new Error(`retry schedule supports at most ${MAX_RETRIES} retries`);
  }
  return values.map((value) => {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms < 100 || ms > MAX_RETRY_DELAY_MS) {
      throw new Error(`invalid retry delay ${String(value)}: must be between 100ms and 1h`);
    }
    return Math.round(ms);
  });
}

export function randomBetween(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

function clamp(value: number, min: number, max: number): number {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return min;
  return Math.min(Math.max(numeric, min), max);
}
