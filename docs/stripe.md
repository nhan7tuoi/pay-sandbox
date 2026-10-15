# Stripe

pay-sandbox speaks Stripe's `/v1` API (form-encoded requests, Stripe-shaped JSON and errors) and sends `Event` webhooks signed with `Stripe-Signature`, so the official SDKs work unchanged.

- [Connect your app](#connect-your-app)
- [Receive webhooks](#receive-webhooks)
- [Test cards and forced outcomes](#test-cards-and-forced-outcomes)
- [Checkout Sessions](#checkout-sessions)
- [Refunds](#refunds)
- [Idempotency](#idempotency)
- [Supported API](#supported-api)
- [Events](#events)
- [Errors](#errors)
- [Differences from Stripe](#differences-from-stripe)

## Connect your app

Point the SDK at the sandbox. Any secret key works.

```js
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_sandbox", {
  host: "localhost",
  port: 4242,
  protocol: "http",
});
```

Raw HTTP works too. Both `Bearer` and Basic auth (`curl -u sk_test_x:`) are accepted:

```bash
curl http://localhost:4242/v1/payment_intents \
  -u sk_test_sandbox: \
  -d amount=2000 -d currency=usd -d payment_method=pm_card_visa -d confirm=true
```

## Receive webhooks

Webhooks are sent to `--webhook-url` (default `http://localhost:3000/api/webhook`) and signed with `--webhook-secret` (default `whsec_test_sandbox_secret`). Both can also be changed on the dashboard (**Stripe** tab).

Verify them exactly as you would in production. With Express, keep the raw body:

```js
import express from "express";

const app = express();
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_sandbox_secret";

app.post("/api/webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], endpointSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object;
    console.log(`💰 ${intent.id} paid for order ${intent.metadata.order_id}`);
  }
  res.json({ received: true });
});
```

The signature is `t=<timestamp>,v1=HMAC_SHA256(secret, "<timestamp>.<raw body>")`. The secret is used as-is, including the `whsec_` prefix. Every retry and replay is signed again with a fresh timestamp, so the SDK's 5-minute tolerance never rejects a retry.

Any `2xx` response acknowledges the event. Anything else, a timeout (5 s) or a refused connection is retried on the sandbox schedule (3s, 10s, 30s by default).

## Test cards and forced outcomes

The sandbox understands Stripe's test PaymentMethods:

| PaymentMethod | Result |
|---|---|
| `pm_card_visa` (4242), `pm_card_visa_debit`, `pm_card_mastercard`, `pm_card_amex` | succeeds |
| `pm_card_chargeDeclined` | `card_declined` / `generic_decline` |
| `pm_card_chargeDeclinedInsufficientFunds` | `card_declined` / `insufficient_funds` |
| `pm_card_chargeDeclinedExpiredCard` | `expired_card` |
| `pm_card_chargeDeclinedIncorrectCvc` | `incorrect_cvc` |
| `pm_card_chargeDeclinedProcessingError` | `processing_error` |

Any other `pm_…` ID succeeds as a Visa ending in 4242.

A declined confirmation behaves like Stripe:

- the API answers **402** with a `card_error`, which the SDK throws as `StripeCardError`;
- the PaymentIntent goes back to `requires_payment_method`, with `last_payment_error` set;
- `charge.failed` and `payment_intent.payment_failed` are sent.

You can also force the outcome of any confirmation, whatever the card. Use one of these three, in order of precedence:

```js
// 1. A body parameter (the SDK passes unknown params through)
await stripe.paymentIntents.confirm(id, { payment_method: "pm_card_visa", sandbox_outcome: "insufficient_funds" });
```

```bash
# 2. A query parameter
curl "http://localhost:4242/v1/payment_intents/pi_123/confirm?outcome=fail" -u sk_test_x: -d payment_method=pm_card_visa

# 3. A header
curl http://localhost:4242/v1/payment_intents/pi_123/confirm -u sk_test_x: -H "X-Sandbox-Outcome: success" -d payment_method=pm_card_visa
```

Accepted values: `success`, `fail` (generic decline), `insufficient_funds`, `expired_card`, `incorrect_cvc`, `processing_error`. Anything else is rejected with a 400.

## Checkout Sessions

```js
const session = await stripe.checkout.sessions.create({
  mode: "payment",
  success_url: "http://localhost:3000/success?session_id={CHECKOUT_SESSION_ID}",
  cancel_url: "http://localhost:3000/cancel",
  metadata: { order_id: "order_42" },
  line_items: [
    { quantity: 1, price_data: { currency: "usd", unit_amount: 4900, product_data: { name: "Pro plan" } } },
  ],
});
// Redirect the customer to session.url
```

`session.url` opens a simulated Checkout page with **Pay** and **Cancel** buttons.

- **Pay** creates and settles a PaymentIntent (carrying the session's `metadata`), marks the session `complete` / `paid`, sends `checkout.session.completed` and redirects to `success_url`. `{CHECKOUT_SESSION_ID}` is substituted.
- **Cancel** redirects to `cancel_url` and leaves the session open, as Stripe does.
- `POST /v1/checkout/sessions/:id/expire` expires an open session and sends `checkout.session.expired`.

Line items must use `price_data`. Stored Prices (`price: "price_…"`) are not simulated yet and are rejected with a clear error.

## Refunds

```js
await stripe.refunds.create({ payment_intent: "pi_123", amount: 500 }); // omit amount for a full refund
```

You can pass `payment_intent` or `charge`, plus an optional `amount`, `reason` (`duplicate`, `fraudulent`, `requested_by_customer`) and `metadata`.

- The **Charge** gets `amount_refunded` and `refunded: true` once fully refunded.
- The **PaymentIntent stays `succeeded`**, exactly like Stripe.
- `refund.created` and `charge.refunded` are sent. The latter includes `previous_attributes.amount_refunded`.
- Refunding more than the remaining amount fails with `amount_too_large`. A disputed charge fails with `charge_disputed`, and a fully refunded one with `charge_already_refunded`.

## Idempotency

Every `POST /v1/*` honours the `Idempotency-Key` header, scoped per API key, for 24 hours:

- The same key with the same parameters returns the **saved response** and the header `Idempotent-Replayed: true`. Nothing is created and no webhook is sent again.
- The same key with different parameters returns **400 `idempotency_error`** (`StripeIdempotencyError` in the SDK).
- A second request while the first is still running returns **409**.
- Validation errors (`parameter_missing`, `parameter_invalid`) are not saved, so a fixed request can reuse the key.

```js
const options = { idempotencyKey: "order-42-intent" };
const first = await stripe.paymentIntents.create({ amount: 2000, currency: "usd" }, options);
const again = await stripe.paymentIntents.create({ amount: 2000, currency: "usd" }, options);
first.id === again.id; // true
```

The Node SDK adds idempotency keys to its own network retries automatically, so Chaos Mode's forced 500s exercise this path too.

## Supported API

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/customers` | `email`, `name`, `phone`, `description`, `metadata`, `balance` |
| `POST` | `/v1/customers/:id` | update |
| `POST` | `/v1/payment_intents` | `amount`, `currency`, `customer`, `payment_method`, `confirm`, `description`, `receipt_email`, `metadata` |
| `POST` | `/v1/payment_intents/:id` | update while not succeeded or canceled |
| `POST` | `/v1/payment_intents/:id/confirm` | see [forced outcomes](#test-cards-and-forced-outcomes) |
| `POST` | `/v1/payment_intents/:id/cancel` | `cancellation_reason` |
| `POST` | `/v1/refunds` | see [Refunds](#refunds) |
| `POST` | `/v1/checkout/sessions` | see [Checkout Sessions](#checkout-sessions) |
| `GET` | `/v1/checkout/sessions`, `/v1/checkout/sessions/:id` | list, retrieve |
| `POST` | `/v1/checkout/sessions/:id/expire` | |
| `GET` | `/v1/{customers,payment_intents,charges,refunds,disputes,events}` | list: `limit`, `starting_after`, filters `customer`, `payment_intent`, `charge`, `type`, `status` |
| `GET` | `/v1/{customers,payment_intents,charges,refunds,disputes,events}/:id` | retrieve |

Responses carry `request-id` and `stripe-version` headers. Unknown endpoints answer 404 with Stripe's "Unrecognized request URL" error.

## Events

| Event | Sent when |
|---|---|
| `customer.created`, `customer.updated` | customer created or updated |
| `payment_intent.created` | PaymentIntent created |
| `payment_intent.updated` | PaymentIntent updated |
| `charge.succeeded`, `payment_intent.succeeded` | confirmation succeeds |
| `charge.failed`, `payment_intent.payment_failed` | confirmation is declined |
| `payment_intent.canceled` | PaymentIntent canceled |
| `refund.created`, `charge.refunded` | refund created |
| `checkout.session.completed` | customer pays on the Checkout page |
| `checkout.session.expired` | session expired |
| `charge.dispute.created` | **Quick Trigger** only |

Events have the real envelope: `id`, `object: "event"`, `api_version`, `created`, `data.object` (a snapshot at the time of the event), `data.previous_attributes` for updates, `livemode: false`, `pending_webhooks` and `request.{id, idempotency_key}`.

## Errors

Errors use Stripe's format and status codes, so the SDK raises the right exception class:

```json
{ "error": { "type": "invalid_request_error", "code": "resource_missing", "param": "id", "message": "No such payment_intent: 'pi_nope'" } }
```

| Status | Typical cause |
|---|---|
| 400 | missing or invalid parameter, wrong state (`payment_intent_unexpected_state`), idempotency mismatch |
| 401 | no API key |
| 402 | card declined |
| 404 | unknown object or endpoint |
| 409 | idempotency key in use |
| 500 | Chaos Mode `api_error` |

## Differences from Stripe

- Only the endpoints listed above. No Prices, Products, Subscriptions, SetupIntents, 3-D Secure (`requires_action`) or manual capture.
- No Stripe.js / Elements. Use test PaymentMethod IDs server-side, or Checkout Sessions.
- One webhook endpoint (`--webhook-url`) receives every event type.
- The retry schedule is the sandbox's (3s, 10s, 30s by default), not Stripe's (up to 3 days).
