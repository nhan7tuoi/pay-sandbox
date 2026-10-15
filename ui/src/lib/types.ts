export type ProviderName = "stripe" | "momo" | "zalopay" | "vnpay";
export type ProviderFilter = ProviderName | "all";
export type SignatureMode = "valid" | "invalid";
export type WebhookSource = "api" | "trigger" | "manual" | "checkout";
export type DeliveryTrigger = "automatic" | "retry" | "replay";
export type WebhookStatus = "pending" | "succeeded" | "retrying" | "failed";

export interface StripeEvent {
  id: string;
  object: "event";
  api_version: string;
  created: number;
  data: { object: Record<string, unknown>; previous_attributes?: Record<string, unknown> };
  livemode: boolean;
  pending_webhooks: number;
  request: { id: string | null; idempotency_key: string | null };
  type: string;
  [key: string]: unknown;
}

export interface DeliveryChaos {
  delayMs: number;
  dropped: boolean;
}

export interface WebhookDelivery {
  id: string;
  trigger: DeliveryTrigger;
  attempt: number | null;
  attemptedAt: number;
  method: "GET" | "POST";
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  statusCode: number | null;
  ok: boolean;
  durationMs: number;
  responseBody: string;
  error: string | null;
  note: string | null;
  chaos: DeliveryChaos | null;
}

export interface WebhookLog {
  id: string;
  provider: ProviderName;
  eventId: string;
  type: string;
  objectId: string | null;
  summary: string | null;
  source: WebhookSource;
  signatureMode: SignatureMode;
  createdAt: number;
  payload: Record<string, unknown>;
  deliveries: WebhookDelivery[];
  status: WebhookStatus;
  attempt_count: number;
  max_retries: number;
  next_retry_at: number | null;
}

export interface ApiChaosConfig {
  enabled: boolean;
  minDelayMs: number;
  maxDelayMs: number;
  errorRate: number;
}

export interface WebhookChaosConfig {
  latencyEnabled: boolean;
  minDelayMs: number;
  maxDelayMs: number;
  dropEnabled: boolean;
  dropRate: number;
}

export interface ChaosConfig {
  api: ApiChaosConfig;
  webhooks: WebhookChaosConfig;
}

export interface RetryConfig {
  enabled: boolean;
  scheduleMs: number[];
}

export interface ProviderSetting {
  key: string;
  label: string;
  value: string;
  kind: "text" | "secret" | "url" | "select";
  editable: boolean;
  options?: string[];
  hint?: string;
}

export interface ProviderEndpoint {
  label: string;
  method: "GET" | "POST";
  url: string;
}

export interface ProviderDescription {
  name: ProviderName;
  displayName: string;
  settings: ProviderSetting[];
  endpoints: ProviderEndpoint[];
}

export interface TriggerInfo {
  id: string;
  provider: ProviderName;
  label: string;
  description: string;
}

export interface SandboxConfig {
  webhookUrl: string;
  webhookSecret: string;
  webhookTimeoutMs: number;
  apiVersion: string;
  apiBase: string;
  retry: RetryConfig;
  chaos: ChaosConfig;
  providers: ProviderDescription[];
  triggers: TriggerInfo[];
}

export type ConfigPatch = Partial<Pick<SandboxConfig, "webhookUrl" | "webhookSecret" | "webhookTimeoutMs">> & {
  retry?: Partial<RetryConfig>;
  chaos?: { api?: Partial<ApiChaosConfig>; webhooks?: Partial<WebhookChaosConfig> };
};

export type ConnectionState = "connecting" | "live" | "offline";
