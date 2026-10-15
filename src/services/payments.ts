import type { SandboxConfig } from "../config.js";
import type { WebhookDispatcher } from "../webhook/dispatcher.js";
import { StripeError, invalidParam, missingParam, resourceMissing } from "../errors.js";
import { generateId, nowSeconds } from "../ids.js";
import {
  type Params,
  optionalBoolean,
  optionalInteger,
  optionalObjectArray,
  optionalString,
  optionalStringArray,
  readCurrency,
  readMetadata,
  requiredInteger,
  requiredString,
  asParams,
} from "../params.js";
import type { MemoryStore } from "../store.js";
import type {
  Charge,
  CheckoutSession,
  Customer,
  Dispute,
  PaymentIntent,
  PaymentIntentStatus,
  Refund,
  RefundReason,
  WebhookSource,
} from "../types.js";
import { type ChargeOutcome, resolveOutcome } from "./cards.js";

export interface ServiceContext {
  store: MemoryStore;
  dispatcher: WebhookDispatcher;
  config: SandboxConfig;
}

export interface RequestMeta {
  requestId?: string | null;
  idempotencyKey?: string | null;
  source?: WebhookSource;
  /** Sandbox-only override for the confirmation outcome. */
  forcedOutcome?: string | null;
}

const CONFIRMABLE_STATUSES: PaymentIntentStatus[] = [
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
];

const CANCELABLE_STATUSES: PaymentIntentStatus[] = [
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "requires_capture",
  "processing",
];

function emitOptions(meta: RequestMeta) {
  return {
    source: meta.source ?? "api",
    requestId: meta.requestId ?? null,
    idempotencyKey: meta.idempotencyKey ?? null,
  } as const;
}

function assertCustomer(ctx: ServiceContext, customerId: string | null): void {
  if (customerId !== null && !ctx.store.customers.has(customerId)) {
    throw resourceMissing("customer", customerId, "customer");
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Customers                                 */
/* -------------------------------------------------------------------------- */

export function createCustomer(ctx: ServiceContext, params: Params, meta: RequestMeta = {}): Customer {
  const customer: Customer = {
    id: generateId("cus", 14),
    object: "customer",
    address: null,
    balance: optionalInteger(params, "balance") ?? 0,
    created: nowSeconds(),
    currency: null,
    description: optionalString(params, "description"),
    email: optionalString(params, "email"),
    livemode: false,
    metadata: readMetadata(params),
    name: optionalString(params, "name"),
    phone: optionalString(params, "phone"),
  };

  ctx.store.customers.set(customer);
  ctx.dispatcher.emit("customer.created", customer, emitOptions(meta));
  return customer;
}

export function updateCustomer(
  ctx: ServiceContext,
  id: string,
  params: Params,
  meta: RequestMeta = {},
): Customer {
  const customer = ctx.store.customers.get(id);
  if (!customer) throw resourceMissing("customer", id);

  const previous: Record<string, unknown> = {};
  const assign = <K extends "description" | "email" | "name" | "phone">(key: K) => {
    if (key in params) {
      const next = optionalString(params, key);
      if (next !== customer[key]) {
        previous[key] = customer[key];
        customer[key] = next;
      }
    }
  };
  assign("description");
  assign("email");
  assign("name");
  assign("phone");

  if ("metadata" in params) {
    previous.metadata = customer.metadata;
    customer.metadata = readMetadata(params, customer.metadata);
  }

  ctx.dispatcher.emit("customer.updated", customer, { ...emitOptions(meta), previousAttributes: previous });
  return customer;
}

/* -------------------------------------------------------------------------- */
/*                               PaymentIntents                               */
/* -------------------------------------------------------------------------- */

export function createPaymentIntent(
  ctx: ServiceContext,
  params: Params,
  meta: RequestMeta = {},
): PaymentIntent {
  const amount = requiredInteger(params, "amount");
  if (amount < 1) {
    throw invalidParam("amount", "This value must be greater than or equal to 1.");
  }
  const currency = readCurrency(params);
  const customer = optionalString(params, "customer");
  assertCustomer(ctx, customer);

  const paymentMethod = optionalString(params, "payment_method");
  const id = generateId("pi");

  const paymentIntent: PaymentIntent = {
    id,
    object: "payment_intent",
    amount,
    amount_capturable: 0,
    amount_received: 0,
    canceled_at: null,
    cancellation_reason: null,
    capture_method: "automatic",
    client_secret: `${id}_secret_${generateId("x", 24).slice(2)}`,
    confirmation_method: "automatic",
    created: nowSeconds(),
    currency,
    customer,
    description: optionalString(params, "description"),
    last_payment_error: null,
    latest_charge: null,
    livemode: false,
    metadata: readMetadata(params),
    next_action: null,
    payment_method: paymentMethod,
    payment_method_types: optionalStringArray(params, "payment_method_types") ?? ["card"],
    receipt_email: optionalString(params, "receipt_email"),
    status: paymentMethod ? "requires_confirmation" : "requires_payment_method",
  };

  ctx.store.paymentIntents.set(paymentIntent);
  ctx.dispatcher.emit("payment_intent.created", paymentIntent, emitOptions(meta));

  if (optionalBoolean(params, "confirm") === true) {
    return confirmPaymentIntent(ctx, id, {}, meta);
  }
  return paymentIntent;
}

export function updatePaymentIntent(
  ctx: ServiceContext,
  id: string,
  params: Params,
  meta: RequestMeta = {},
): PaymentIntent {
  const paymentIntent = ctx.store.paymentIntents.get(id);
  if (!paymentIntent) throw resourceMissing("payment_intent", id);
  if (paymentIntent.status === "succeeded" || paymentIntent.status === "canceled") {
    throw unexpectedState(paymentIntent, "updated", CONFIRMABLE_STATUSES);
  }

  const previous: Record<string, unknown> = {};
  const amount = optionalInteger(params, "amount");
  if (amount !== null && amount !== paymentIntent.amount) {
    if (amount < 1) throw invalidParam("amount", "This value must be greater than or equal to 1.");
    previous.amount = paymentIntent.amount;
    paymentIntent.amount = amount;
  }
  if ("currency" in params) {
    const currency = readCurrency(params);
    if (currency !== paymentIntent.currency) {
      previous.currency = paymentIntent.currency;
      paymentIntent.currency = currency;
    }
  }
  if ("customer" in params) {
    const customer = optionalString(params, "customer");
    assertCustomer(ctx, customer);
    previous.customer = paymentIntent.customer;
    paymentIntent.customer = customer;
  }
  if ("description" in params) {
    previous.description = paymentIntent.description;
    paymentIntent.description = optionalString(params, "description");
  }
  if ("receipt_email" in params) {
    previous.receipt_email = paymentIntent.receipt_email;
    paymentIntent.receipt_email = optionalString(params, "receipt_email");
  }
  if ("payment_method" in params) {
    previous.payment_method = paymentIntent.payment_method;
    paymentIntent.payment_method = optionalString(params, "payment_method");
    paymentIntent.status = paymentIntent.payment_method ? "requires_confirmation" : "requires_payment_method";
  }
  if ("metadata" in params) {
    previous.metadata = paymentIntent.metadata;
    paymentIntent.metadata = readMetadata(params, paymentIntent.metadata);
  }

  if (Object.keys(previous).length > 0) {
    ctx.dispatcher.emit("payment_intent.updated", paymentIntent, {
      ...emitOptions(meta),
      previousAttributes: previous,
    });
  }
  return paymentIntent;
}

/**
 * Confirms a PaymentIntent, creates the resulting Charge and fires the same
 * webhook sequence Stripe would:
 *   success → charge.succeeded, payment_intent.succeeded
 *   decline → charge.failed, payment_intent.payment_failed (+ HTTP 402)
 */
export function confirmPaymentIntent(
  ctx: ServiceContext,
  id: string,
  params: Params,
  meta: RequestMeta = {},
): PaymentIntent {
  const paymentIntent = ctx.store.paymentIntents.get(id);
  if (!paymentIntent) throw resourceMissing("payment_intent", id);

  if (!CONFIRMABLE_STATUSES.includes(paymentIntent.status)) {
    throw unexpectedState(paymentIntent, "confirmed", CONFIRMABLE_STATUSES);
  }

  const paymentMethod = optionalString(params, "payment_method") ?? paymentIntent.payment_method;
  if (!paymentMethod) {
    throw new StripeError(400, {
      type: "invalid_request_error",
      code: "payment_intent_unexpected_state",
      param: "payment_method",
      message:
        "You cannot confirm this PaymentIntent because it's missing a payment method. " +
        "Pass `payment_method` (for example `pm_card_visa`) when confirming.",
    });
  }

  const receiptEmail = optionalString(params, "receipt_email");
  if (receiptEmail !== null) paymentIntent.receipt_email = receiptEmail;
  paymentIntent.payment_method = paymentMethod;

  const outcome = resolveOutcome(paymentMethod, meta.forcedOutcome ?? null);
  const charge = createCharge(ctx, paymentIntent, paymentMethod, outcome);
  paymentIntent.latest_charge = charge.id;

  if (outcome.kind === "success") {
    paymentIntent.status = "succeeded";
    paymentIntent.amount_received = paymentIntent.amount;
    paymentIntent.last_payment_error = null;

    ctx.dispatcher.emit("charge.succeeded", charge, emitOptions(meta));
    ctx.dispatcher.emit("payment_intent.succeeded", paymentIntent, emitOptions(meta));
    return paymentIntent;
  }

  paymentIntent.status = "requires_payment_method";
  paymentIntent.payment_method = null;
  paymentIntent.last_payment_error = {
    type: "card_error",
    code: outcome.decline.code,
    decline_code: outcome.decline.declineCode,
    message: outcome.decline.message,
    doc_url: `https://stripe.com/docs/error-codes/${outcome.decline.code.replaceAll("_", "-")}`,
    charge: charge.id,
    payment_method: { id: paymentMethod, object: "payment_method", type: "card" },
  };

  ctx.dispatcher.emit("charge.failed", charge, emitOptions(meta));
  ctx.dispatcher.emit("payment_intent.payment_failed", paymentIntent, emitOptions(meta));

  throw new StripeError(402, {
    type: "card_error",
    code: outcome.decline.code,
    decline_code: outcome.decline.declineCode,
    message: outcome.decline.message,
    doc_url: paymentIntent.last_payment_error.doc_url,
    charge: charge.id,
    payment_intent: structuredClone(paymentIntent),
  });
}

export function cancelPaymentIntent(
  ctx: ServiceContext,
  id: string,
  params: Params,
  meta: RequestMeta = {},
): PaymentIntent {
  const paymentIntent = ctx.store.paymentIntents.get(id);
  if (!paymentIntent) throw resourceMissing("payment_intent", id);
  if (!CANCELABLE_STATUSES.includes(paymentIntent.status)) {
    throw unexpectedState(paymentIntent, "canceled", CANCELABLE_STATUSES);
  }

  paymentIntent.status = "canceled";
  paymentIntent.canceled_at = nowSeconds();
  paymentIntent.cancellation_reason = optionalString(params, "cancellation_reason") ?? "requested_by_customer";

  ctx.dispatcher.emit("payment_intent.canceled", paymentIntent, emitOptions(meta));
  return paymentIntent;
}

function unexpectedState(
  paymentIntent: PaymentIntent,
  action: string,
  allowed: PaymentIntentStatus[],
): StripeError {
  return new StripeError(400, {
    type: "invalid_request_error",
    code: "payment_intent_unexpected_state",
    message:
      `This PaymentIntent's status is ${paymentIntent.status}, but must be one of ` +
      `${allowed.join(", ")} to be ${action}.`,
    payment_intent: structuredClone(paymentIntent),
  });
}

function createCharge(
  ctx: ServiceContext,
  paymentIntent: PaymentIntent,
  paymentMethod: string,
  outcome: ChargeOutcome,
): Charge {
  const succeeded = outcome.kind === "success";
  const id = generateId("ch");
  const charge: Charge = {
    id,
    object: "charge",
    amount: paymentIntent.amount,
    amount_captured: succeeded ? paymentIntent.amount : 0,
    amount_refunded: 0,
    balance_transaction: succeeded ? generateId("txn") : null,
    captured: succeeded,
    created: nowSeconds(),
    currency: paymentIntent.currency,
    customer: paymentIntent.customer,
    description: paymentIntent.description,
    disputed: false,
    failure_code: succeeded ? null : outcome.decline.code,
    failure_message: succeeded ? null : outcome.decline.message,
    livemode: false,
    metadata: { ...paymentIntent.metadata },
    outcome: succeeded
      ? {
          network_status: "approved_by_network",
          reason: null,
          risk_level: "normal",
          seller_message: "Payment complete.",
          type: "authorized",
        }
      : {
          network_status: "declined_by_network",
          reason: outcome.decline.declineCode,
          risk_level: "normal",
          seller_message: "The bank did not return any further details with this decline.",
          type: "issuer_declined",
        },
    paid: succeeded,
    payment_intent: paymentIntent.id,
    payment_method: paymentMethod,
    payment_method_details: { type: "card", card: outcome.card },
    receipt_url: `http://${ctx.config.host}:${ctx.config.port}/receipts/${id}`,
    refunded: false,
    status: succeeded ? "succeeded" : "failed",
  };
  return ctx.store.charges.set(charge);
}

/* -------------------------------------------------------------------------- */
/*                                  Disputes                                  */
/* -------------------------------------------------------------------------- */

export function createDispute(
  ctx: ServiceContext,
  chargeId: string,
  reason = "fraudulent",
  meta: RequestMeta = {},
): Dispute {
  const charge = ctx.store.charges.get(chargeId);
  if (!charge) throw resourceMissing("charge", chargeId, "charge");
  if (charge.status !== "succeeded") {
    throw invalidParam("charge", `Charge ${chargeId} did not succeed and cannot be disputed.`);
  }

  const created = nowSeconds();
  const dispute: Dispute = {
    id: generateId("dp"),
    object: "dispute",
    amount: charge.amount,
    charge: charge.id,
    created,
    currency: charge.currency,
    evidence_details: {
      due_by: created + 7 * 24 * 60 * 60,
      has_evidence: false,
      past_due: false,
      submission_count: 0,
    },
    is_charge_refundable: false,
    livemode: false,
    metadata: {},
    payment_intent: charge.payment_intent,
    reason,
    status: "needs_response",
  };

  charge.disputed = true;
  ctx.store.disputes.set(dispute);
  ctx.dispatcher.emit("charge.dispute.created", dispute, emitOptions(meta));
  return dispute;
}

/* -------------------------------------------------------------------------- */
/*                                   Refunds                                  */
/* -------------------------------------------------------------------------- */

const REFUND_REASONS: RefundReason[] = ["duplicate", "fraudulent", "requested_by_customer"];

/**
 * Refunds all or part of a succeeded charge, addressed either by `charge` or
 * by `payment_intent` (its latest charge). Like Stripe, the PaymentIntent
 * stays `succeeded`; the refunded amount is tracked on the Charge
 * (`amount_refunded`, `refunded`). Fires `refund.created` and `charge.refunded`.
 */
export function createRefund(ctx: ServiceContext, params: Params, meta: RequestMeta = {}): Refund {
  const paymentIntentId = optionalString(params, "payment_intent");
  const chargeParam = optionalString(params, "charge");

  if (!paymentIntentId && !chargeParam) {
    throw new StripeError(400, {
      type: "invalid_request_error",
      code: "parameter_missing",
      message: "One of the following params should be provided for this request: payment_intent or charge.",
    });
  }

  let chargeId = chargeParam;
  if (paymentIntentId) {
    const paymentIntent = ctx.store.paymentIntents.get(paymentIntentId);
    if (!paymentIntent) throw resourceMissing("payment_intent", paymentIntentId, "payment_intent");
    if (paymentIntent.status !== "succeeded" || !paymentIntent.latest_charge) {
      throw new StripeError(400, {
        type: "invalid_request_error",
        code: "payment_intent_unexpected_state",
        param: "payment_intent",
        message: `This PaymentIntent (${paymentIntentId}) does not have a successful charge to refund.`,
      });
    }
    if (chargeParam && chargeParam !== paymentIntent.latest_charge) {
      throw invalidParam("charge", `Charge ${chargeParam} does not belong to PaymentIntent ${paymentIntentId}.`);
    }
    chargeId = paymentIntent.latest_charge;
  }

  const charge = ctx.store.charges.get(chargeId ?? "");
  if (!charge) throw resourceMissing("charge", chargeId ?? "", "charge");

  if (charge.status !== "succeeded" || !charge.captured) {
    throw new StripeError(400, {
      type: "invalid_request_error",
      code: "charge_not_refundable",
      message: `Charge ${charge.id} did not succeed and cannot be refunded.`,
    });
  }
  if (charge.disputed) {
    throw new StripeError(400, {
      type: "invalid_request_error",
      code: "charge_disputed",
      message: `Charge ${charge.id} has been charged back; cannot issue a refund.`,
    });
  }

  const refundable = charge.amount_captured - charge.amount_refunded;
  if (refundable <= 0) {
    throw new StripeError(400, {
      type: "invalid_request_error",
      code: "charge_already_refunded",
      message: `Charge ${charge.id} has already been refunded.`,
    });
  }

  const amount = optionalInteger(params, "amount") ?? refundable;
  if (amount < 1) {
    throw invalidParam("amount", "This value must be greater than or equal to 1.");
  }
  if (amount > refundable) {
    throw new StripeError(400, {
      type: "invalid_request_error",
      code: "amount_too_large",
      param: "amount",
      message: `Refund amount (${amount}) is greater than unrefunded amount on charge (${refundable}).`,
    });
  }

  const reason = optionalString(params, "reason");
  if (reason !== null && !REFUND_REASONS.includes(reason as RefundReason)) {
    throw invalidParam("reason", `Invalid reason: must be one of ${REFUND_REASONS.join(", ")}.`);
  }

  const refund: Refund = {
    id: generateId("re"),
    object: "refund",
    amount,
    balance_transaction: generateId("txn"),
    charge: charge.id,
    created: nowSeconds(),
    currency: charge.currency,
    metadata: readMetadata(params),
    payment_intent: charge.payment_intent,
    reason: reason as RefundReason | null,
    status: "succeeded",
  };

  const previousAttributes = { amount_refunded: charge.amount_refunded, refunded: charge.refunded };
  charge.amount_refunded += amount;
  charge.refunded = charge.amount_refunded >= charge.amount_captured;

  ctx.store.refunds.set(refund);
  ctx.dispatcher.emit("refund.created", refund, emitOptions(meta));
  ctx.dispatcher.emit("charge.refunded", charge, { ...emitOptions(meta), previousAttributes });
  return refund;
}

/* -------------------------------------------------------------------------- */
/*                              Checkout Sessions                             */
/* -------------------------------------------------------------------------- */

export function createCheckoutSession(
  ctx: ServiceContext,
  params: Params,
  baseUrl: string,
): CheckoutSession {
  const mode = requiredString(params, "mode");
  if (mode !== "payment" && mode !== "setup" && mode !== "subscription") {
    throw invalidParam("mode", `Invalid mode: must be one of payment, setup, or subscription.`);
  }

  const customer = optionalString(params, "customer");
  assertCustomer(ctx, customer);

  const lineItems = optionalObjectArray(params, "line_items") ?? [];
  if (mode !== "setup" && lineItems.length === 0) {
    throw missingParam("line_items");
  }

  let currency = optionalString(params, "currency")?.toLowerCase() ?? null;
  let subtotal = 0;

  lineItems.forEach((item, index) => {
    const quantity = optionalInteger(item, "quantity") ?? 1;
    const priceData = asParams(item.price_data);

    if (Object.keys(priceData).length === 0) {
      const priceId = optionalString(item, "price");
      throw invalidParam(
        `line_items[${index}][price]`,
        priceId
          ? `No such price: '${priceId}'. pay-sandbox does not persist Prices yet; use line_items[${index}][price_data] instead.`
          : `Each line item needs price_data (pay-sandbox does not persist Prices yet).`,
      );
    }

    const itemCurrency = readCurrency(priceData);
    if (currency !== null && currency !== itemCurrency) {
      throw invalidParam(`line_items[${index}][price_data][currency]`, "All line items must share one currency.");
    }
    currency = itemCurrency;
    subtotal += requiredInteger(priceData, "unit_amount") * quantity;
  });

  const id = generateId("cs_test", 58);
  const created = nowSeconds();
  const session: CheckoutSession = {
    id,
    object: "checkout.session",
    amount_subtotal: subtotal,
    amount_total: subtotal,
    cancel_url: optionalString(params, "cancel_url"),
    client_reference_id: optionalString(params, "client_reference_id"),
    created,
    currency: currency ?? "usd",
    customer,
    customer_email: optionalString(params, "customer_email"),
    expires_at: created + 24 * 60 * 60,
    livemode: false,
    metadata: readMetadata(params),
    mode,
    payment_intent: null,
    payment_method_types: optionalStringArray(params, "payment_method_types") ?? ["card"],
    payment_status: mode === "setup" ? "no_payment_required" : "unpaid",
    status: "open",
    success_url: optionalString(params, "success_url"),
    url: `${baseUrl}/checkout/${id}`,
  };

  return ctx.store.checkoutSessions.set(session);
}

/**
 * Simulates the customer paying on the hosted page. In payment mode this also
 * creates and settles a PaymentIntent so `checkout.session.completed` carries a
 * real `payment_intent` ID the receiving app can look up.
 */
export function completeCheckoutSession(
  ctx: ServiceContext,
  id: string,
  meta: RequestMeta = {},
): CheckoutSession {
  const session = ctx.store.checkoutSessions.get(id);
  if (!session) throw resourceMissing("checkout.session", id);
  if (session.status !== "open") {
    throw invalidParam("id", `This Checkout Session is ${session.status} and can no longer be completed.`);
  }

  if (session.mode === "payment") {
    const paymentIntent = createPaymentIntent(
      ctx,
      {
        amount: String(session.amount_total),
        currency: session.currency,
        ...(session.customer ? { customer: session.customer } : {}),
        ...(session.customer_email ? { receipt_email: session.customer_email } : {}),
        metadata: session.metadata,
      },
      meta,
    );
    confirmPaymentIntent(ctx, paymentIntent.id, { payment_method: "pm_card_visa" }, { ...meta, forcedOutcome: "success" });
    session.payment_intent = paymentIntent.id;
    session.payment_status = "paid";
  } else if (session.mode === "subscription") {
    session.payment_status = "paid";
  }

  session.status = "complete";
  session.url = null;
  ctx.dispatcher.emit("checkout.session.completed", session, emitOptions(meta));
  return session;
}

export function expireCheckoutSession(
  ctx: ServiceContext,
  id: string,
  meta: RequestMeta = {},
): CheckoutSession {
  const session = ctx.store.checkoutSessions.get(id);
  if (!session) throw resourceMissing("checkout.session", id);
  if (session.status !== "open") {
    throw invalidParam("id", `Only open Checkout Sessions can be expired; this one is ${session.status}.`);
  }

  session.status = "expired";
  session.url = null;
  ctx.dispatcher.emit("checkout.session.expired", session, emitOptions(meta));
  return session;
}
