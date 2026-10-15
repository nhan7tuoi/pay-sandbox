import type { FastifyInstance } from "fastify";
import type { ProviderName, SignatureMode, WebhookLog, WebhookSource } from "../types.js";

export interface WebhookRequestSpec {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  /** Request body for POST; omitted for GET. */
  body?: string;
}

export interface ResponseEvaluation {
  /** The endpoint acknowledged the webhook; no further attempts are needed. */
  ok: boolean;
  /** When not ok: whether the real gateway would try again. */
  retryable: boolean;
  /** Human-readable interpretation shown in the dashboard and CLI. */
  note: string | null;
}

/** Everything the dispatcher needs to record and deliver one webhook. */
export interface DispatchInit {
  provider: ProviderName;
  type: string;
  eventId: string;
  objectId: string | null;
  summary: string | null;
  payload: Record<string, unknown>;
  source: WebhookSource;
  signatureMode?: SignatureMode;
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

export interface TriggerResult {
  trigger: string;
  objects: Record<string, string>;
}

export interface TriggerDefinition {
  id: string;
  provider: ProviderName;
  label: string;
  description: string;
  run: (baseUrl: string) => TriggerResult;
}

/**
 * Contract every payment gateway adapter implements.
 *
 * Adapters own their order state, their HTTP surface (create/query endpoints
 * and the hosted payment page), the signature scheme of their webhooks and the
 * way a merchant's answer to a webhook is interpreted.
 */
export interface BaseProvider {
  readonly name: ProviderName;
  readonly displayName: string;

  /**
   * Creates a transaction from a merchant request body, validating it and its
   * signature exactly like the real gateway, and stores it in memory.
   * Returns the gateway's response body.
   */
  createOrder(payload: Record<string, unknown>, baseUrl: string): Record<string, unknown>;

  /** Computes the gateway's signature for an outgoing webhook payload. */
  signWebhook(payload: Record<string, unknown>, secretKey: string): string;

  /**
   * Settles a stored order with the given gateway status code and sends the
   * corresponding webhook / IPN to the merchant. Returns the logs it created
   * (empty when the real gateway would not notify, e.g. a failed ZaloPay payment).
   */
  dispatchWebhook(orderId: string, status: string, source?: WebhookSource): WebhookLog[];

  /** Serializes a recorded webhook into an HTTP request; called for every attempt. */
  buildWebhookRequest(log: WebhookLog): WebhookRequestSpec;

  /** Interprets the merchant's answer the way the real gateway does. */
  evaluateResponse(statusCode: number, body: string): ResponseEvaluation;

  /**
   * Turns a payload edited in the dashboard into a deliverable webhook,
   * re-signing it with the real key or, in `invalid` mode, a wrong one.
   */
  prepareManualPayload(payload: Record<string, unknown>, mode: SignatureMode): DispatchInit;

  registerRoutes(app: FastifyInstance): Promise<void>;
  describe(baseUrl: string): ProviderDescription;
  updateSettings(patch: Record<string, unknown>): void;
  listOrders(): unknown[];
  triggers(): TriggerDefinition[];
  reset(): void;
}
