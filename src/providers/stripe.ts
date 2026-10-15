import type { FastifyInstance } from "fastify";
import { applyConfigPatch } from "../config.js";
import { StripeError } from "../errors.js";
import { generateId, nowSeconds } from "../ids.js";
import { checkoutPageRoutes } from "../routes/checkout-page.js";
import { stripeRoutes } from "../routes/stripe.js";
import { type ServiceContext, confirmPaymentIntent, createPaymentIntent } from "../services/payments.js";
import { TRIGGERS } from "../services/triggers.js";
import type { SignatureMode, StripeEvent, WebhookLog, WebhookSource } from "../types.js";
import { signPayload } from "../webhook/signer.js";
import { isRecord, tamperedKey } from "./shared.js";
import type {
  BaseProvider,
  DispatchInit,
  ProviderDescription,
  ResponseEvaluation,
  TriggerDefinition,
  WebhookRequestSpec,
} from "./types.js";

/** Runs `action` and returns the webhook logs it created, newest last. */
export function collectNewLogs(ctx: ServiceContext, action: () => void): WebhookLog[] {
  const before = new Set(ctx.store.listWebhookLogs().map((log) => log.id));
  action();
  return ctx.store
    .listWebhookLogs()
    .filter((log) => !before.has(log.id))
    .reverse();
}

/**
 * Stripe adapter. Requests are form-encoded `/v1` calls; webhooks are JSON
 * `Event` objects signed with `Stripe-Signature: t=…,v1=HMAC_SHA256(t.body)`.
 * The signature is recomputed for every attempt with a fresh timestamp.
 */
export class StripeProvider implements BaseProvider {
  readonly name = "stripe" as const;
  readonly displayName = "Stripe";

  constructor(private readonly ctx: ServiceContext) {}

  createOrder(payload: Record<string, unknown>): Record<string, unknown> {
    return createPaymentIntent(this.ctx, payload) as unknown as Record<string, unknown>;
  }

  signWebhook(payload: Record<string, unknown>, secretKey: string): string {
    return signPayload(JSON.stringify(payload, null, 2), secretKey).header;
  }

  /** `status` is `succeeded` or a decline outcome such as `card_declined` / `insufficient_funds`. */
  dispatchWebhook(orderId: string, status: string, source: WebhookSource = "trigger"): WebhookLog[] {
    const paymentIntent = this.ctx.store.paymentIntents.get(orderId);
    if (!paymentIntent) throw new Error(`No such payment_intent: '${orderId}'`);

    const forcedOutcome = status === "succeeded" ? "success" : status;
    return collectNewLogs(this.ctx, () => {
      try {
        confirmPaymentIntent(
          this.ctx,
          orderId,
          paymentIntent.payment_method ? {} : { payment_method: "pm_card_visa" },
          { source, forcedOutcome },
        );
      } catch (error) {
        if (!(error instanceof StripeError) || error.statusCode !== 402) throw error;
      }
    });
  }

  buildWebhookRequest(log: WebhookLog): WebhookRequestSpec {
    const body = JSON.stringify(log.payload, null, 2);
    const secret =
      log.signatureMode === "valid" ? this.ctx.config.webhookSecret : tamperedKey(this.ctx.config.webhookSecret);
    return {
      method: "POST",
      url: this.ctx.config.webhookUrl,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "user-agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks)",
        "cache-control": "no-cache",
        "stripe-signature": signPayload(body, secret).header,
      },
      body,
    };
  }

  evaluateResponse(statusCode: number): ResponseEvaluation {
    if (statusCode >= 200 && statusCode < 300) return { ok: true, retryable: false, note: null };
    return {
      ok: false,
      retryable: true,
      note: `Stripe treats any non-2xx response (${statusCode}) as a failed delivery and retries it.`,
    };
  }

  prepareManualPayload(payload: Record<string, unknown>, mode: SignatureMode): DispatchInit {
    const event = normalizeEvent(payload, this.ctx.config.apiVersion);
    const objectId = event.data.object.id;
    return {
      provider: "stripe",
      type: event.type,
      eventId: event.id,
      objectId: typeof objectId === "string" ? objectId : null,
      summary: mode === "invalid" ? "Signed with a wrong secret" : null,
      payload: event as unknown as Record<string, unknown>,
      source: "manual",
      signatureMode: mode,
    };
  }

  async registerRoutes(app: FastifyInstance): Promise<void> {
    await app.register((instance) => stripeRoutes(instance, this.ctx), { prefix: "/v1" });
    await app.register((instance) => checkoutPageRoutes(instance, this.ctx));
  }

  describe(baseUrl: string): ProviderDescription {
    const { config } = this.ctx;
    return {
      name: this.name,
      displayName: this.displayName,
      settings: [
        { key: "webhookUrl", label: "Webhook URL", value: config.webhookUrl, kind: "url", editable: true },
        { key: "webhookSecret", label: "Signing secret", value: config.webhookSecret, kind: "secret", editable: true },
        { key: "apiVersion", label: "API version", value: config.apiVersion, kind: "text", editable: false },
      ],
      endpoints: [{ label: "API base", method: "POST", url: `${baseUrl}/v1` }],
    };
  }

  updateSettings(patch: Record<string, unknown>): void {
    applyConfigPatch(this.ctx.config, {
      ...(typeof patch.webhookUrl === "string" ? { webhookUrl: patch.webhookUrl } : {}),
      ...(typeof patch.webhookSecret === "string" ? { webhookSecret: patch.webhookSecret } : {}),
    });
  }

  listOrders(): unknown[] {
    return this.ctx.store.paymentIntents.list("/v1/payment_intents", { limit: 100 }).data;
  }

  triggers(): TriggerDefinition[] {
    return Object.entries(TRIGGERS).map(([type, run]) => ({
      id: `stripe:${type}`,
      provider: "stripe" as const,
      label: type,
      description: STRIPE_TRIGGER_DESCRIPTIONS[type] ?? "Fire a sample Stripe event",
      run: (baseUrl: string) => run(this.ctx, baseUrl),
    }));
  }

  reset(): void {
    return;
  }
}

const STRIPE_TRIGGER_DESCRIPTIONS: Record<string, string> = {
  "customer.created": "Customer jenny.rosen@example.com",
  "payment_intent.succeeded": "PaymentIntent + Charge, $20.00",
  "payment_intent.payment_failed": "Declined with card_declined",
  "checkout.session.completed": "Paid Checkout Session, $49.00",
  "charge.refunded": "Partial $5.00 refund on a new charge",
  "charge.dispute.created": "Fraudulent dispute on a new charge",
};

function normalizeEvent(payload: Record<string, unknown>, apiVersion: string): StripeEvent {
  const data = isRecord(payload.data) ? payload.data : { object: {} };
  const dataObject = isRecord(data.object) ? data.object : {};
  const request = isRecord(payload.request) ? payload.request : {};

  return {
    ...payload,
    id: typeof payload.id === "string" && payload.id.length > 0 ? payload.id : generateId("evt"),
    object: "event",
    api_version: typeof payload.api_version === "string" ? payload.api_version : apiVersion,
    created: typeof payload.created === "number" ? payload.created : nowSeconds(),
    data: { ...data, object: dataObject },
    livemode: false,
    pending_webhooks: 1,
    request: {
      id: typeof request.id === "string" ? request.id : null,
      idempotency_key: typeof request.idempotency_key === "string" ? request.idempotency_key : null,
    },
    type: typeof payload.type === "string" && payload.type.length > 0 ? payload.type : "sandbox.custom",
  };
}
