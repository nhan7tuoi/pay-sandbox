# Dashboard

Open **http://localhost:4242/dashboard** while pay-sandbox is running. Everything updates live over Server-Sent Events.

![Dashboard](assets/dashboard.jpg)

- [Layout](#layout)
- [Inspecting a webhook](#inspecting-a-webhook)
- [Replay](#replay)
- [Edit & Fire](#edit--fire)
- [Quick Trigger](#quick-trigger)
- [Auto-retry](#auto-retry)
- [Chaos Mode](#chaos-mode)
- [Keyboard shortcuts](#keyboard-shortcuts)

## Layout

| Area | What it does |
|---|---|
| **Provider tabs** `All · Stripe · MoMo · ZaloPay · VNPay` | Filter everything by gateway. Each tab shows its webhook count. The choice is remembered in your browser. |
| **Toolbar** | Quick Trigger, Chaos Mode, Auto-retry, Clear. |
| **Settings bar** | On a provider tab: that gateway's credentials and URLs, editable in place. Secrets are masked; the eye icon reveals and edits them. On **All**: every gateway's entry endpoint. |
| **Webhook list** | Newest first. The badge is the HTTP status of the latest attempt, colored by whether the *gateway* would accept it (a VNPay `200` with `RspCode 97` is not green). Search by type, event ID, order ID or result; filter *Succeeded* / *Failed*. |
| **Detail pane** | Payload, Request, Response and Attempts for the selected webhook. |

When the dashboard can't reach a running sandbox (for example when you run Vite alone), it shows sample data and says so in a banner.

## Inspecting a webhook

| Tab | Shows |
|---|---|
| **Payload** | The JSON body, or the query parameters for VNPay's `GET` IPN. |
| **Request** | Method and URL; query parameters as a table; headers (including `Stripe-Signature`); the body. |
| **Response** | Your endpoint's status, time and body. When the gateway has an opinion about it, a note appears, for example *"MoMo expects HTTP 204 No Content"* or *"RspCode 97: Invalid checksum. VNPay keeps retrying until 00 or 02."* |
| **Attempts** | Every delivery: *First delivery*, *Automatic retry n/3*, *Manual replay*, with Chaos tags (`dropped`, `+2.4s`). |

## Replay

**Replay** (`R`) sends the selected webhook again, now.

- Stripe events are re-signed with a fresh timestamp. MoMo, ZaloPay and VNPay notifications are re-sent exactly as recorded, which is what their servers do.
- A successful replay cancels a pending automatic retry.
- Use it to check that your handler is idempotent. The second delivery must not double-credit an order.

## Edit & Fire

**Edit & Fire** (`E`) opens the payload in an editor (CodeMirror, loaded on first use). Change anything, then **Fire** (`⌘/Ctrl + Enter`).

- **Valid signature** re-signs the edited payload with the current keys, so you can send, say, a MoMo IPN with a different `amount` that still verifies.
- **Wrong signature** signs it with a deliberately wrong key, to prove your endpoint rejects forged notifications.

The result is recorded as a new webhook (marked *edited*, and *wrong signature* when applicable) with its own retries.

## Quick Trigger

Runs a complete scenario inside the sandbox and sends the resulting webhooks. The menu is grouped by gateway and follows the selected tab.

| Gateway | Triggers |
|---|---|
| Stripe | `customer.created`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `checkout.session.completed`, `charge.refunded`, `charge.dispute.created` |
| MoMo | Thanh toán thành công (code 0), Hết hạn giao dịch (code 1005), Người dùng từ chối (code 1006) |
| ZaloPay | Bắn Callback |
| VNPay | Bắn IPN thành công (00), Khách hủy giao dịch (24) |

Triggered orders are created by the sandbox, not by your app. Your app will not find them in its database, which is expected. A strict VNPay handler answers `RspCode 01` and gets retried. To test the full flow, create orders from your app.

MoMo, ZaloPay and VNPay triggers send to the **Trigger ipnUrl**, **Default callback_url** and **IPN URL** shown in each provider's settings bar.

## Auto-retry

The toolbar switch turns automatic retries on or off. The schedule is shown next to it (default `3s · 10s · 30s`, set with `--retry-schedule`).

A webhook is retried when the delivery fails by the gateway's rules:

| Gateway | Acknowledged when | Not retried when |
|---|---|---|
| Stripe | `2xx` | |
| MoMo | `2xx` (ideally `204`) | |
| ZaloPay | `200` with `return_code: 1` | `return_code` other than `0` and `1` (you rejected it) |
| VNPay | `200` with `RspCode` `00` or `02` | |

Timeouts (5s by default, `--webhook-timeout`) and refused connections are always retried.

Badges show the state: **Failed (Retrying 2/3…) · 8s**, **Failed (Max retries exceeded)**, **Failed (Auto-retry off)**. Turning auto-retry off cancels the retries that are waiting.

![Retries](assets/dashboard-retries.jpg)

## Chaos Mode

| Switch | Effect |
|---|---|
| **API latency & errors** | Adds a random delay (min/max) to every Stripe `/v1` response, and answers a share of them with `500 api_error`. Tests timeouts and SDK retries. |
| **Webhook Latency Spike** | Waits a random 1–5s before every webhook delivery, retries included. Tests slow or out-of-order notifications. |
| **Simulate Dropped Webhook** | Drops a share (default 15%) of **first** delivery attempts. They show up as `dropped` and are retried normally. Tests that you can recover from a missing notification. |

The button shows how many switches are on. All of them can also be set through `PATCH /__sandbox/config` (see the [control API](sandbox-api.md)).

## Keyboard shortcuts

| Key | Action |
|---|---|
| `J` / `↓` | next webhook |
| `K` / `↑` | previous webhook |
| `/` | focus search |
| `R` | replay |
| `E` | edit & fire |
| `⌘/Ctrl + Enter` | fire (while editing) |
| `Esc` | leave the editor |
