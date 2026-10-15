export type Metadata = Record<string, string>;

export interface Customer {
  id: string;
  object: "customer";
  address: null;
  balance: number;
  created: number;
  currency: string | null;
  description: string | null;
  email: string | null;
  livemode: false;
  metadata: Metadata;
  name: string | null;
  phone: string | null;
}

export type PaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "canceled"
  | "succeeded";

export interface PaymentError {
  type: "card_error";
  code: string;
  decline_code: string;
  message: string;
  doc_url: string;
  charge: string | null;
  payment_method: { id: string; object: "payment_method"; type: "card" } | null;
}

export interface PaymentIntent {
  id: string;
  object: "payment_intent";
  amount: number;
  amount_capturable: number;
  amount_received: number;
  canceled_at: number | null;
  cancellation_reason: string | null;
  capture_method: "automatic";
  client_secret: string;
  confirmation_method: "automatic";
  created: number;
  currency: string;
  customer: string | null;
  description: string | null;
  last_payment_error: PaymentError | null;
  latest_charge: string | null;
  livemode: false;
  metadata: Metadata;
  next_action: null;
  payment_method: string | null;
  payment_method_types: string[];
  receipt_email: string | null;
  status: PaymentIntentStatus;
}

export interface CardDetails {
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  funding: "credit" | "debit";
  country: string;
}

export interface Charge {
  id: string;
  object: "charge";
  amount: number;
  amount_captured: number;
  amount_refunded: number;
  balance_transaction: string | null;
  captured: boolean;
  created: number;
  currency: string;
  customer: string | null;
  description: string | null;
  disputed: boolean;
  failure_code: string | null;
  failure_message: string | null;
  livemode: false;
  metadata: Metadata;
  outcome: {
    network_status: "approved_by_network" | "declined_by_network";
    reason: string | null;
    risk_level: "normal";
    seller_message: string;
    type: "authorized" | "issuer_declined";
  };
  paid: boolean;
  payment_intent: string | null;
  payment_method: string;
  payment_method_details: { type: "card"; card: CardDetails };
  receipt_url: string;
  refunded: boolean;
  status: "succeeded" | "failed";
}

export interface Dispute {
  id: string;
  object: "dispute";
  amount: number;
  charge: string;
  created: number;
  currency: string;
  evidence_details: {
    due_by: number;
    has_evidence: boolean;
    past_due: boolean;
    submission_count: number;
  };
  is_charge_refundable: boolean;
  livemode: false;
  metadata: Metadata;
  payment_intent: string | null;
  reason: string;
  status: "warning_needs_response" | "needs_response" | "under_review" | "won" | "lost";
}

export interface CheckoutSession {
  id: string;
  object: "checkout.session";
  amount_subtotal: number;
  amount_total: number;
  cancel_url: string | null;
  client_reference_id: string | null;
  created: number;
  currency: string;
  customer: string | null;
  customer_email: string | null;
  expires_at: number;
  livemode: false;
  metadata: Metadata;
  mode: "payment" | "setup" | "subscription";
  payment_intent: string | null;
  payment_method_types: string[];
  payment_status: "paid" | "unpaid" | "no_payment_required";
  status: "open" | "complete" | "expired";
  success_url: string | null;
  url: string | null;
}

export interface Refund {
  id: string;
  object: "refund";
  amount: number;
  balance_transaction: string | null;
  charge: string;
  created: number;
  currency: string;
  metadata: Metadata;
  payment_intent: string | null;
  reason: RefundReason | null;
  status: "pending" | "succeeded" | "failed" | "canceled";
}

export type RefundReason = "duplicate" | "fraudulent" | "requested_by_customer";

export type StripeObject = Customer | PaymentIntent | Charge | Dispute | CheckoutSession | Refund;

export interface StripeEvent {
  id: string;
  object: "event";
  api_version: string;
  created: number;
  data: {
    object: Record<string, unknown>;
    previous_attributes?: Record<string, unknown>;
  };
  livemode: false;
  pending_webhooks: number;
  request: { id: string | null; idempotency_key: string | null };
  type: string;
}

export type ProviderName = "stripe" | "momo" | "zalopay" | "vnpay";

export type WebhookSource = "api" | "trigger" | "manual" | "checkout";

/**
 * - `automatic`: the first delivery attempt of an event
 * - `retry`: an automatic retry scheduled after a failed attempt
 * - `replay`: a manual re-send from the dashboard
 */
export type DeliveryTrigger = "automatic" | "retry" | "replay";

/** `invalid` deliberately signs with a wrong key so receivers can test signature rejection. */
export type SignatureMode = "valid" | "invalid";

export interface DeliveryChaos {
  /** Artificial latency injected before sending, in milliseconds. */
  delayMs: number;
  /** True when Chaos Mode dropped this attempt instead of sending it. */
  dropped: boolean;
}

export interface WebhookDelivery {
  id: string;
  trigger: DeliveryTrigger;
  /** 1-based automatic attempt number; null for manual replays. */
  attempt: number | null;
  attemptedAt: number;
  method: "GET" | "POST";
  /** Full URL including the query string for GET deliveries. */
  url: string;
  requestHeaders: Record<string, string>;
  /** Raw request body; empty for GET deliveries. */
  requestBody: string;
  statusCode: number | null;
  /** True when the provider considers the endpoint's answer an acknowledgement. */
  ok: boolean;
  /** Network time only, excluding any chaos delay. */
  durationMs: number;
  responseBody: string;
  error: string | null;
  /** Provider-specific reading of the response, e.g. `RspCode 97: invalid checksum`. */
  note: string | null;
  chaos: DeliveryChaos | null;
}

/**
 * - `pending`: an attempt is queued or in flight
 * - `succeeded`: the endpoint acknowledged the webhook
 * - `retrying`: the last attempt failed and a retry is scheduled at `next_retry_at`
 * - `failed`: the last attempt failed and no retry is scheduled
 */
export type WebhookStatus = "pending" | "succeeded" | "retrying" | "failed";

export interface WebhookLog {
  id: string;
  provider: ProviderName;
  /** Stripe event ID, or the provider's order reference for MoMo / ZaloPay / VNPay. */
  eventId: string;
  /** e.g. `payment_intent.succeeded`, `momo.ipn`, `zalopay.callback`, `vnpay.ipn`. */
  type: string;
  /** ID of the business object the webhook is about (PaymentIntent, orderId, app_trans_id, vnp_TxnRef). */
  objectId: string | null;
  /** One-line outcome such as `resultCode 0 · Thành công.` */
  summary: string | null;
  source: WebhookSource;
  signatureMode: SignatureMode;
  createdAt: number;
  /** Exactly what is sent: the JSON body, or the query parameters for GET deliveries. */
  payload: Record<string, unknown>;
  deliveries: WebhookDelivery[];
  status: WebhookStatus;
  /** Number of automatic attempts made so far (first delivery + retries). Replays are not counted. */
  attempt_count: number;
  /** Maximum number of automatic retries for this event, fixed when the event was created. */
  max_retries: number;
  /** Epoch milliseconds of the next scheduled retry, or null when none is scheduled. */
  next_retry_at: number | null;
}

export interface StripeList<T> {
  object: "list";
  data: T[];
  has_more: boolean;
  url: string;
}
