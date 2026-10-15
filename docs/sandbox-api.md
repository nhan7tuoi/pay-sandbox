# Control API

Everything the dashboard does is available over HTTP under `/__sandbox`, so automated tests can set up scenarios, force outcomes and inspect what was delivered. All bodies are JSON. Errors come back as `{"error": "…"}` with status 400 or 404.

- [Settle an order and send its webhook](#settle-an-order-and-send-its-webhook)
- [Triggers](#triggers)
- [Webhook log](#webhook-log)
- [Configuration](#configuration)
- [Provider settings](#provider-settings)
- [Reset and health](#reset-and-health)
- [Live stream](#live-stream)
- [Running inside your tests](#running-inside-your-tests)

## Settle an order and send its webhook

```http
POST /__sandbox/providers/:provider/orders/:orderId/webhook
{ "status": "<gateway status>" }
```

This is the main tool for end-to-end tests. Your app creates the order through the gateway API as usual; the test then decides how it ends.

| `:provider` | `:orderId` | `status` |
|---|---|---|
| `stripe` | PaymentIntent ID | `succeeded`, or a decline: `fail`, `insufficient_funds`, `expired_card`, `incorrect_cvc`, `processing_error` |
| `momo` | `orderId` | `0`, `1001`, `1002`, `1004`, `1005`, `1006`, `1007`, `99` |
| `zalopay` | `app_trans_id` | `success` (sends the callback) or `failed` (no callback, like ZaloPay) |
| `vnpay` | `vnp_TxnRef` | any `vnp_ResponseCode`: `00`, `07`, `09`, `10`, `11`, `12`, `13`, `24`, `51`, `65`, `75`, `79`, `99` |

```bash
curl -X POST http://localhost:4242/__sandbox/providers/momo/orders/ORDER123/webhook \
  -H 'content-type: application/json' -d '{"status": "1005"}'
```

The response is `{"data": [<webhook log>, …]}` with the webhooks that were queued. It is empty for a failed ZaloPay payment.

The order must exist and still be pending. A VNPay order exists once its payment URL has been opened.

```http
GET /__sandbox/providers/:provider/orders
```

Lists the stored orders (Stripe: PaymentIntents), newest first.

## Triggers

```http
POST /__sandbox/trigger
{ "id": "momo:expired" }
```

Runs a [Quick Trigger](dashboard.md#quick-trigger) scenario. It returns the IDs it created:

```json
{ "trigger": "momo:expired", "objects": { "orderId": "SBX17920348688096930", "requestId": "SBX17920348688096930" } }
```

| ID | Scenario |
|---|---|
| `stripe:customer.created` | customer |
| `stripe:payment_intent.succeeded` | PaymentIntent + Charge, $20.00 |
| `stripe:payment_intent.payment_failed` | declined with `card_declined` |
| `stripe:checkout.session.completed` | paid Checkout Session, $49.00 |
| `stripe:charge.refunded` | $5.00 partial refund on a new charge |
| `stripe:charge.dispute.created` | fraudulent dispute on a new charge |
| `momo:success` | IPN `resultCode 0` |
| `momo:expired` | IPN `resultCode 1005` |
| `momo:user_denied` | IPN `resultCode 1006` |
| `zalopay:callback` | successful payment callback |
| `vnpay:success` | IPN `vnp_ResponseCode 00` |
| `vnpay:cancelled` | IPN `vnp_ResponseCode 24` |

For backwards compatibility, `{"type": "payment_intent.succeeded"}` is read as `stripe:payment_intent.succeeded`.

## Webhook log

```http
GET    /__sandbox/logs                 → { "data": [WebhookLog, …] }   newest first, last 500
DELETE /__sandbox/logs                 clears the log and cancels pending retries
POST   /__sandbox/logs/:id/replay      re-sends now → WebhookLog
POST   /__sandbox/fire                 sends an arbitrary payload → WebhookLog
```

`/fire` body:

```json
{
  "provider": "momo",
  "signature": "valid",
  "payload": { "partnerCode": "MOMOSBX00001", "orderId": "ORDER123", "resultCode": 0, "…": "…" }
}
```

`signature` is `valid` (re-signed with the current keys) or `invalid` (signed with a wrong key). For Stripe, missing envelope fields (`id`, `created`, `api_version`, …) are filled in.

A `WebhookLog`:

```json
{
  "id": "whl_9ORSV4iAwUGa6awP",
  "provider": "vnpay",
  "type": "vnpay.ipn",
  "eventId": "1042001",
  "objectId": "1042001",
  "summary": "vnp_ResponseCode 00 · Giao dịch thành công",
  "source": "api",
  "signatureMode": "valid",
  "createdAt": 1792036188160,
  "payload": { "vnp_Amount": "25000000", "…": "…" },
  "status": "retrying",
  "attempt_count": 2,
  "max_retries": 3,
  "next_retry_at": 1792036198160,
  "deliveries": [
    {
      "id": "whd_…",
      "trigger": "automatic",
      "attempt": 1,
      "attemptedAt": 1792036188161,
      "method": "GET",
      "url": "http://localhost:3000/api/vnpay/ipn?vnp_Amount=25000000&…",
      "requestHeaders": { "user-agent": "VNPAY-IPN/2.1.0 (pay-sandbox)" },
      "requestBody": "",
      "statusCode": 200,
      "ok": false,
      "durationMs": 4,
      "responseBody": "{\"RspCode\":\"99\",\"Message\":\"Unknown error\"}",
      "error": null,
      "note": "RspCode 99: Unknown error. VNPay keeps retrying until 00 or 02.",
      "chaos": null
    }
  ]
}
```

| Field | Values |
|---|---|
| `type` | Stripe event type, `momo.ipn`, `zalopay.callback` or `vnpay.ipn` |
| `source` | `api`, `trigger`, `checkout` (payment page), `manual` (Edit & Fire) |
| `status` | `pending`, `succeeded`, `retrying`, `failed` |
| `deliveries[].trigger` | `automatic`, `retry`, `replay` |
| `deliveries[].ok` | the gateway would consider this answer an acknowledgement |
| `deliveries[].chaos` | `{ delayMs, dropped }` when Chaos Mode affected the attempt |

## Configuration

```http
GET   /__sandbox/config
PATCH /__sandbox/config
```

Any subset of:

```json
{
  "webhookUrl": "http://localhost:3000/api/webhook",
  "webhookSecret": "whsec_test_sandbox_secret",
  "webhookTimeoutMs": 5000,
  "retry": { "enabled": true, "scheduleMs": [3000, 10000, 30000] },
  "chaos": {
    "api": { "enabled": false, "minDelayMs": 1000, "maxDelayMs": 5000, "errorRate": 0 },
    "webhooks": { "latencyEnabled": false, "minDelayMs": 1000, "maxDelayMs": 5000, "dropEnabled": false, "dropRate": 0.15 }
  }
}
```

`webhookUrl` and `webhookSecret` are Stripe's. `GET` also returns `apiVersion`, `apiBase`, every provider's settings and endpoints, and the trigger list. Disabling `retry.enabled` cancels pending retries.

Example: make a test deterministic.

```bash
curl -X PATCH http://localhost:4242/__sandbox/config -H 'content-type: application/json' \
  -d '{"retry": {"enabled": false}, "chaos": {"webhooks": {"dropEnabled": false, "latencyEnabled": false}}}'
```

## Provider settings

```http
PATCH /__sandbox/providers/:provider/settings
```

| Provider | Keys |
|---|---|
| `stripe` | `webhookUrl`, `webhookSecret` |
| `momo` | `partnerCode`, `accessKey`, `secretKey`, `defaultIpnUrl`, `defaultRedirectUrl` |
| `zalopay` | `appId`, `key1`, `key2`, `defaultCallbackUrl`, `defaultRedirectUrl` |
| `vnpay` | `tmnCode`, `hashSecret`, `ipnUrl`, `ipnMethod` (`GET` / `POST`), `defaultReturnUrl` |

```bash
# Use the same keys as your .env.test
curl -X PATCH http://localhost:4242/__sandbox/providers/vnpay/settings -H 'content-type: application/json' \
  -d '{"tmnCode": "MYTMN001", "hashSecret": "my-test-secret", "ipnUrl": "http://localhost:8080/vnpay/ipn"}'
```

Returns the full configuration, like `GET /__sandbox/config`.

## Reset and health

```http
POST /__sandbox/reset     wipes every object, order, idempotency key and webhook log; cancels retries
GET  /__sandbox/stats     counts of Stripe objects, webhook logs and idempotency keys
GET  /__sandbox/health    { "ok": true, "uptime": 12.3 }
```

Call `reset` in a `beforeEach` to isolate tests. Configuration is kept.

## Live stream

```http
GET /__sandbox/stream     text/event-stream
```

| Event | Data |
|---|---|
| `snapshot` | `{ logs, config }`, sent once on connect |
| `log` | a `WebhookLog`, every time one is created or changes |
| `cleared` | `{}` after the log is cleared or reset |
| `config` | the full configuration, after any change |

## Running inside your tests

`buildServer()` starts the sandbox in-process, which is useful in Vitest/Jest. Use port `0` for a free port.

```js
import { buildServer } from "pay-sandbox";

const sandbox = await buildServer({
  config: {
    port: 0,
    webhookUrl: "http://localhost:3000/api/webhook",
    retry: { enabled: false, scheduleMs: [] },
  },
});
const baseUrl = await sandbox.app.listen({ port: 0 });

// sandbox.store       in-memory Stripe objects and webhook logs
// sandbox.providers   provider adapters (sandbox.providers.get("momo").listOrders())
// sandbox.dispatcher  sandbox.dispatcher.drain() waits for in-flight deliveries

await sandbox.app.close();
```

`config` accepts the same options as the CLI, plus `providers` for MoMo / ZaloPay / VNPay credentials.
