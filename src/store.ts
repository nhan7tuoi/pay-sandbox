import { IdempotencyStore } from "./idempotency.js";
import type {
  Charge,
  CheckoutSession,
  Customer,
  Dispute,
  PaymentIntent,
  Refund,
  StripeEvent,
  StripeList,
  WebhookLog,
} from "./types.js";

const MAX_WEBHOOK_LOGS = 500;

export interface ListOptions<T> {
  limit?: number;
  startingAfter?: string;
  filter?: (item: T) => boolean;
}

/**
 * An insertion-ordered collection that returns Stripe-shaped list pages
 * (newest first, cursor based on `starting_after`).
 */
export class Collection<T extends { id: string }> {
  private readonly items = new Map<string, T>();

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  set(item: T): T {
    this.items.set(item.id, item);
    return item;
  }

  get size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  list(url: string, options: ListOptions<T> = {}): StripeList<T> {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
    let newestFirst = [...this.items.values()].reverse();

    if (options.filter) {
      newestFirst = newestFirst.filter(options.filter);
    }
    if (options.startingAfter) {
      const cursorIndex = newestFirst.findIndex((item) => item.id === options.startingAfter);
      newestFirst = cursorIndex === -1 ? [] : newestFirst.slice(cursorIndex + 1);
    }

    return {
      object: "list",
      data: newestFirst.slice(0, limit),
      has_more: newestFirst.length > limit,
      url,
    };
  }
}

export class MemoryStore {
  readonly customers = new Collection<Customer>();
  readonly paymentIntents = new Collection<PaymentIntent>();
  readonly charges = new Collection<Charge>();
  readonly refunds = new Collection<Refund>();
  readonly disputes = new Collection<Dispute>();
  readonly checkoutSessions = new Collection<CheckoutSession>();
  readonly events = new Collection<StripeEvent>();
  readonly idempotency = new IdempotencyStore();

  private readonly webhookLogs = new Map<string, WebhookLog>();

  /** Saves a log and returns the oldest log if it had to be evicted to stay under the cap. */
  saveWebhookLog(log: WebhookLog): WebhookLog | undefined {
    this.webhookLogs.set(log.id, log);
    if (this.webhookLogs.size <= MAX_WEBHOOK_LOGS) return undefined;
    const oldest = this.webhookLogs.values().next().value;
    if (oldest) this.webhookLogs.delete(oldest.id);
    return oldest;
  }

  getWebhookLog(id: string): WebhookLog | undefined {
    return this.webhookLogs.get(id);
  }

  listWebhookLogs(): WebhookLog[] {
    return [...this.webhookLogs.values()].reverse();
  }

  clearWebhookLogs(): void {
    this.webhookLogs.clear();
  }

  stats(): Record<string, number> {
    return {
      customers: this.customers.size,
      payment_intents: this.paymentIntents.size,
      charges: this.charges.size,
      refunds: this.refunds.size,
      disputes: this.disputes.size,
      checkout_sessions: this.checkoutSessions.size,
      events: this.events.size,
      webhook_logs: this.webhookLogs.size,
      idempotency_keys: this.idempotency.size,
    };
  }

  reset(): void {
    this.customers.clear();
    this.paymentIntents.clear();
    this.charges.clear();
    this.refunds.clear();
    this.disputes.clear();
    this.checkoutSessions.clear();
    this.events.clear();
    this.idempotency.clear();
    this.webhookLogs.clear();
  }
}
