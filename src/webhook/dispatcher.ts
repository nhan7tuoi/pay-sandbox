import { setTimeout as sleep } from "node:timers/promises";
import type { SandboxBus } from "../bus.js";
import { type SandboxConfig, randomBetween } from "../config.js";
import { generateId, nowSeconds } from "../ids.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { DispatchInit, ResponseEvaluation } from "../providers/types.js";
import type { MemoryStore } from "../store.js";
import type {
  DeliveryChaos,
  DeliveryTrigger,
  ProviderName,
  SignatureMode,
  StripeEvent,
  WebhookDelivery,
  WebhookLog,
  WebhookSource,
} from "../types.js";

const MAX_RESPONSE_BODY_CHARS = 8_192;

export interface EmitOptions {
  source?: WebhookSource;
  requestId?: string | null;
  idempotencyKey?: string | null;
  previousAttributes?: Record<string, unknown>;
}

class DispatcherClosedError extends Error {
  constructor() {
    super("Webhook dispatcher is shutting down");
  }
}

interface AttemptResult {
  delivery: WebhookDelivery;
  retryable: boolean;
}

/**
 * Records webhooks for every provider and delivers them to the merchant.
 *
 * The provider adapter decides how a webhook is serialized and signed
 * (`buildWebhookRequest`) and whether the merchant's answer counts as an
 * acknowledgement (`evaluateResponse`). The dispatcher owns everything that is
 * common: chaos injection, timeouts, the retry schedule and log bookkeeping.
 */
export class WebhookDispatcher {
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly shutdown = new AbortController();

  constructor(
    private readonly config: SandboxConfig,
    private readonly store: MemoryStore,
    private readonly bus: SandboxBus,
    private readonly providers: ProviderRegistry,
  ) {}

  /** Records a webhook and starts delivering it in the background. */
  enqueue(init: DispatchInit): WebhookLog {
    const log = this.createLog(init);
    this.track(this.attempt(log, "automatic"));
    return log;
  }

  /** Creates a Stripe `Event` for `object`, records it and delivers it in the background. */
  emit(type: string, object: { id?: unknown }, options: EmitOptions = {}): StripeEvent {
    const event: StripeEvent = {
      id: generateId("evt"),
      object: "event",
      api_version: this.config.apiVersion,
      created: nowSeconds(),
      data: {
        object: structuredClone(object) as Record<string, unknown>,
        ...(options.previousAttributes ? { previous_attributes: options.previousAttributes } : {}),
      },
      livemode: false,
      pending_webhooks: 1,
      request: {
        id: options.requestId ?? null,
        idempotency_key: options.idempotencyKey ?? null,
      },
      type,
    };

    this.store.events.set(event);
    this.enqueue({
      provider: "stripe",
      type,
      eventId: event.id,
      objectId: typeof object.id === "string" ? object.id : null,
      summary: null,
      payload: event as unknown as Record<string, unknown>,
      source: options.source ?? "api",
    });
    return event;
  }

  /**
   * Sends a payload edited in the dashboard. The provider re-signs it (or
   * deliberately mis-signs it in `invalid` mode). Resolves after the first
   * attempt; retries continue in the background.
   */
  async fire(provider: ProviderName, payload: Record<string, unknown>, mode: SignatureMode): Promise<WebhookLog> {
    const init = this.providers.get(provider).prepareManualPayload(payload, mode);
    const log = this.createLog({ ...init, source: "manual", signatureMode: mode });
    await this.track(this.attempt(log, "automatic"));
    return log;
  }

  /**
   * Re-sends a recorded webhook right now. Stripe events get a fresh signature
   * timestamp; other providers resend the identical signed payload.
   * A successful replay cancels any pending automatic retry.
   */
  async replay(logId: string): Promise<WebhookLog | undefined> {
    const log = this.store.getWebhookLog(logId);
    if (!log) return undefined;
    await this.track(this.attempt(log, "replay"));
    return log;
  }

  /**
   * Re-evaluates scheduled retries after a config change: turning auto-retry
   * off cancels every pending retry and marks those webhooks as failed.
   */
  applyConfig(): void {
    if (this.config.retry.enabled) return;
    for (const logId of [...this.retryTimers.keys()]) {
      const log = this.store.getWebhookLog(logId);
      this.cancelRetry(logId);
      if (log && log.status === "retrying") {
        log.status = "failed";
        log.next_retry_at = null;
        this.bus.emit("log", log);
      }
    }
  }

  cancelRetry(logId: string): void {
    const timer = this.retryTimers.get(logId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(logId);
    }
  }

  cancelAllRetries(): void {
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  get pendingRetries(): number {
    return this.retryTimers.size;
  }

  /** Resolves once every in-flight delivery has finished. Scheduled retries are not awaited. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /** Stops all timers and aborts in-flight requests and chaos delays. */
  async close(): Promise<void> {
    this.cancelAllRetries();
    this.shutdown.abort(new DispatcherClosedError());
    await this.drain();
  }

  private createLog(init: DispatchInit): WebhookLog {
    const log: WebhookLog = {
      id: generateId("whl", 16),
      provider: init.provider,
      eventId: init.eventId,
      type: init.type,
      objectId: init.objectId,
      summary: init.summary,
      source: init.source,
      signatureMode: init.signatureMode ?? "valid",
      createdAt: Date.now(),
      payload: init.payload,
      deliveries: [],
      status: "pending",
      attempt_count: 0,
      max_retries: this.config.retry.enabled ? this.config.retry.scheduleMs.length : 0,
      next_retry_at: null,
    };
    const evicted = this.store.saveWebhookLog(log);
    if (evicted) this.cancelRetry(evicted.id);
    this.bus.emit("log", log);
    return log;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise)).catch(() => undefined);
    return promise;
  }

  private async attempt(log: WebhookLog, trigger: DeliveryTrigger): Promise<WebhookDelivery | null> {
    if (this.shutdown.signal.aborted) return null;

    const isAutomatic = trigger !== "replay";
    const attemptNumber = isAutomatic ? log.attempt_count + 1 : null;
    if (isAutomatic) {
      log.attempt_count += 1;
      log.next_retry_at = null;
    }
    log.status = "pending";
    this.bus.emit("log", log);

    let result: AttemptResult;
    try {
      result = await this.deliver(log, trigger, attemptNumber);
    } catch (error) {
      if (error instanceof DispatcherClosedError || this.shutdown.signal.aborted) return null;
      throw error;
    }

    log.deliveries.push(result.delivery);
    this.settle(log, result);
    this.bus.emit("log", log);
    return result.delivery;
  }

  /** Updates the log status after an attempt and schedules the next retry when needed. */
  private settle(log: WebhookLog, { delivery, retryable }: AttemptResult): void {
    const isStripe = log.provider === "stripe";

    if (delivery.ok) {
      this.cancelRetry(log.id);
      log.status = "succeeded";
      log.next_retry_at = null;
      if (isStripe) log.payload.pending_webhooks = 0;
      return;
    }

    if (isStripe) log.payload.pending_webhooks = 1;

    if (delivery.trigger === "replay") {
      log.status = this.retryTimers.has(log.id) ? "retrying" : "failed";
      return;
    }

    const retriesDone = log.attempt_count - 1;
    const delay = this.config.retry.scheduleMs[retriesDone];
    const canRetry =
      retryable && this.config.retry.enabled && retriesDone < log.max_retries && delay !== undefined;

    if (!canRetry) {
      log.status = "failed";
      log.next_retry_at = null;
      return;
    }

    log.status = "retrying";
    log.next_retry_at = Date.now() + delay;
    this.cancelRetry(log.id);
    const timer = setTimeout(() => {
      this.retryTimers.delete(log.id);
      if (!this.store.getWebhookLog(log.id)) return;
      this.track(this.attempt(log, "retry"));
    }, delay);
    this.retryTimers.set(log.id, timer);
  }

  private async deliver(log: WebhookLog, trigger: DeliveryTrigger, attempt: number | null): Promise<AttemptResult> {
    const chaosConfig = this.config.chaos.webhooks;
    const chaos: DeliveryChaos = { delayMs: 0, dropped: false };

    if (chaosConfig.latencyEnabled) {
      chaos.delayMs = randomBetween(chaosConfig.minDelayMs, chaosConfig.maxDelayMs);
      if (chaos.delayMs > 0) {
        await sleep(chaos.delayMs, undefined, { signal: this.shutdown.signal }).catch(() => {
          throw new DispatcherClosedError();
        });
      }
    }

    const provider = this.providers.get(log.provider);
    const request = provider.buildWebhookRequest(log);
    const base = {
      id: generateId("whd", 16),
      trigger,
      attempt,
      attemptedAt: Date.now(),
      method: request.method,
      url: request.url,
      requestHeaders: request.headers,
      requestBody: request.body ?? "",
    };
    const chaosRecord = chaos.delayMs > 0 ? chaos : null;

    if (trigger === "automatic" && chaosConfig.dropEnabled && Math.random() < chaosConfig.dropRate) {
      return {
        retryable: true,
        delivery: {
          ...base,
          statusCode: null,
          ok: false,
          durationMs: 0,
          responseBody: "",
          error: "Chaos Mode: webhook dropped before reaching your endpoint",
          note: null,
          chaos: { ...chaos, dropped: true },
        },
      };
    }

    const startedHr = performance.now();
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        redirect: "manual",
        signal: AbortSignal.any([AbortSignal.timeout(this.config.webhookTimeoutMs), this.shutdown.signal]),
      });
      const responseText = await response.text();
      const evaluation: ResponseEvaluation = provider.evaluateResponse(response.status, responseText);
      return {
        retryable: evaluation.retryable,
        delivery: {
          ...base,
          statusCode: response.status,
          ok: evaluation.ok,
          durationMs: Math.round(performance.now() - startedHr),
          responseBody: truncate(responseText),
          error: null,
          note: evaluation.note,
          chaos: chaosRecord,
        },
      };
    } catch (error) {
      if (this.shutdown.signal.aborted) throw new DispatcherClosedError();
      return {
        retryable: true,
        delivery: {
          ...base,
          statusCode: null,
          ok: false,
          durationMs: Math.round(performance.now() - startedHr),
          responseBody: "",
          error: describeFetchError(error, request.url, this.config.webhookTimeoutMs),
          note: null,
          chaos: chaosRecord,
        },
      };
    }
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_RESPONSE_BODY_CHARS) return text;
  return `${text.slice(0, MAX_RESPONSE_BODY_CHARS)}\n… [truncated ${text.length - MAX_RESPONSE_BODY_CHARS} chars]`;
}

function describeFetchError(error: unknown, url: string, timeoutMs: number): string {
  const target = url.split("?")[0] ?? url;
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return `Timed out after ${timeoutMs}ms waiting for ${target}`;
  }
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ECONNREFUSED") {
      return `Connection refused: nothing is listening on ${target}`;
    }
    return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
  }
  return String(error);
}
