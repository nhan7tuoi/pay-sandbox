# ZaloPay

pay-sandbox simulates ZaloPay's v2 order API. It checks your `mac` (HMAC-SHA256 with **key1**), returns an `order_url`, and on a successful payment sends a callback signed with **key2** and redirects the browser with a checksum.

![ZaloPay payment page](assets/zalopay-checkout.png)

- [Endpoints and credentials](#endpoints-and-credentials)
- [1. Create an order](#1-create-an-order)
- [2. Customer pays](#2-customer-pays)
- [3. Handle the callback](#3-handle-the-callback)
- [4. Redirect back to your site](#4-redirect-back-to-your-site)
- [5. Query an order](#5-query-an-order)
- [Status codes](#status-codes)
- [Test scenarios](#test-scenarios)
- [Troubleshooting](#troubleshooting)
- [Differences from ZaloPay](#differences-from-zalopay)

## Endpoints and credentials

| | ZaloPay sandbox | pay-sandbox |
|---|---|---|
| Base URL | `https://sb-openapi.zalopay.vn` | `http://localhost:4242/zalopay` |
| Create | `POST /v2/create` | `POST /zalopay/v2/create` |
| Query | `POST /v2/query` | `POST /zalopay/v2/query` |
| Payment page | ZaloPay gateway / app | `GET /zalopay/pay/:app_trans_id` |

| Credential | Default | Used for |
|---|---|---|
| `app_id` | `2554` | |
| `key1` | `paysandboxzalopaykey1000000000001` | signing create and query requests (you → ZaloPay) |
| `key2` | `paysandboxzalopaykey2000000000002` | verifying callbacks and redirects (ZaloPay → you) |

Change them on the dashboard (**ZaloPay** tab). Both JSON and `application/x-www-form-urlencoded` request bodies are accepted.

## 1. Create an order

```text
mac = HMAC_SHA256(key1, app_id|app_trans_id|app_user|amount|app_time|embed_data|item)
```

`app_trans_id` must start with **today's date in Vietnam time (GMT+7)** as `yyMMdd_`. `item` is a JSON **array string** and `embed_data` a JSON **object string**. Put your return URL in `embed_data.redirecturl`.

```js
import crypto from "node:crypto";

const ZALOPAY = {
  endpoint: "http://localhost:4242/zalopay", // https://sb-openapi.zalopay.vn in ZaloPay's sandbox
  appId: 2554,
  key1: "paysandboxzalopaykey1000000000001",
  key2: "paysandboxzalopaykey2000000000002",
};
const hmacSha256 = (key, data) => crypto.createHmac("sha256", key).update(data).digest("hex");

// app_trans_id must start with today's date in Vietnam time (GMT+7): yyMMdd_xxx
const yymmdd = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(2, 10).replaceAll("-", "");

async function createZaloPayOrder({ amount, description }) {
  const order = {
    app_id: ZALOPAY.appId,
    app_user: "user123",
    app_trans_id: `${yymmdd()}_${Date.now()}`,
    app_time: Date.now(),
    amount,
    item: JSON.stringify([]),
    embed_data: JSON.stringify({ redirecturl: "http://localhost:3000/payment/zalopay/return" }),
    description,
    bank_code: "",
    callback_url: "http://localhost:3000/api/zalopay/callback",
  };
  const macInput = [order.app_id, order.app_trans_id, order.app_user, order.amount, order.app_time, order.embed_data, order.item].join("|");
  order.mac = hmacSha256(ZALOPAY.key1, macInput);

  const response = await fetch(`${ZALOPAY.endpoint}/v2/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(order),
  });
  return { appTransId: order.app_trans_id, ...(await response.json()) }; // { return_code: 1, order_url, zp_trans_token, ... }
}
```

Response:

```json
{
  "return_code": 1,
  "return_message": "Giao dịch thành công",
  "sub_return_code": 1,
  "sub_return_message": "Giao dịch thành công",
  "zp_trans_token": "iDQZJNLRJoj8Vw7KS5JeLqRx",
  "order_url": "http://localhost:4242/zalopay/pay/261015_1042",
  "order_token": "iDQZJNLRJoj8Vw7KS5JeLqRx",
  "qr_code": "http://localhost:4242/zalopay/pay/261015_1042"
}
```

If `callback_url` is omitted, the callback goes to the **Default callback_url** set on the dashboard (`http://localhost:3000/api/zalopay/callback`).

### Validation

Errors are returned with HTTP 200, `return_code: 2` and a `sub_return_code` from [ZaloPay's status codes](https://docs.zalopay.vn/docs/developer-tools/knowledge-base/status-codes):

| sub_return_code | When |
|---|---|
| `-401` ILLEGAL_DATA_REQUEST | a required field is missing; `app_trans_id` has the wrong format or isn't today's date (GMT+7); `amount` isn't a positive integer; `item` / `embed_data` aren't valid JSON |
| `-402` ILLEGAL_APP/SIGNATURE_REQUEST | unknown `app_id`, or the `mac` doesn't match |
| `-68` DUPLICATE_APPS_TRANS_ID | `app_trans_id` already used |

```json
{
  "return_code": 2,
  "return_message": "Giao dịch thất bại",
  "sub_return_code": -68,
  "sub_return_message": "DUPLICATE_APPS_TRANS_ID: app_trans_id '261015_1042' was already used"
}
```

On a `-402` mac error, `sub_return_message` contains the exact string the sandbox signed with key1.

## 2. Customer pays

Redirect the customer to `order_url`:

| Button | What happens |
|---|---|
| Thanh toán thành công | callback is sent; browser redirected with `status=1` |
| Thanh toán thất bại | **no callback** (ZaloPay only calls back for successful payments); browser redirected with `status=2` |

Because failed payments produce no callback, your app must **query** pending orders to find out about them.

## 3. Handle the callback

ZaloPay POSTs JSON:

```json
{
  "data": "{\"app_id\":2554,\"app_trans_id\":\"261015_1042\",\"app_time\":1792036188157,\"app_user\":\"user123\",\"amount\":120000,\"embed_data\":\"{\\\"redirecturl\\\":\\\"http://localhost:3000/payment/zalopay/return\\\"}\",\"item\":\"[]\",\"zp_trans_id\":261015428865267,\"server_time\":1792036188159,\"channel\":38,\"merchant_user_id\":\"sbx_user123\",\"user_fee_amount\":0,\"discount_amount\":0}",
  "mac": "4fc27cbeff57b94036926606cbd4951e0d6f23e093ce32a48e1d4bd04d292cd8",
  "type": 1
}
```

`mac = HMAC_SHA256(key2, data)`, computed over the **`data` string exactly as received**. Verify it before you parse `data`:

```js
import express from "express";

const app = express();

app.post("/api/zalopay/callback", express.json(), (req, res) => {
  const { data, mac } = req.body;
  if (hmacSha256(ZALOPAY.key2, data) !== mac) {
    return res.json({ return_code: -1, return_message: "mac not equal" });
  }

  const payment = JSON.parse(data); // { app_trans_id, zp_trans_id, amount, server_time, ... }
  const order = orders.get(payment.app_trans_id);
  if (order) order.status = "paid";
  res.json({ return_code: 1, return_message: "success" });
});
```

How the sandbox reads your answer:

| Your response | Result |
|---|---|
| HTTP 200 `{"return_code": 1}` | acknowledged |
| HTTP 200 `{"return_code": 0}` | failed, **called back again** (temporary error) |
| HTTP 200 with any other `return_code` (`2`, `-1`, …) | failed, **not retried** (you rejected it) |
| non-200, non-JSON body, timeout, connection refused | failed, retried |

ZaloPay's spec lists `1` (success) and `2` (invalid). Its official sample also uses `0` for "call me back" and `-1` for a mac mismatch. The sandbox follows both.

## 4. Redirect back to your site

```text
http://localhost:3000/payment/zalopay/return?appid=2554&apptransid=261015_1042&pmcid=38&bankcode=&amount=120000&discountamount=0&status=1&checksum=…
```

```text
checksum = HMAC_SHA256(key2, appid|apptransid|pmcid|bankcode|amount|discountamount|status)
```

`status=1` means paid; anything else means not paid. Use this only for the result page and update the order from the callback or a query.

## 5. Query an order

```text
mac = HMAC_SHA256(key1, app_id|app_trans_id|key1)
```

```js
const mac = hmacSha256(ZALOPAY.key1, `${ZALOPAY.appId}|${appTransId}|${ZALOPAY.key1}`);
const response = await fetch(`${ZALOPAY.endpoint}/v2/query`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ app_id: ZALOPAY.appId, app_trans_id: appTransId, mac }),
});
```

```json
{
  "return_code": 1,
  "return_message": "Giao dịch thành công",
  "sub_return_code": 1,
  "sub_return_message": "Giao dịch thành công",
  "is_processing": false,
  "amount": 120000,
  "zp_trans_id": 261015428865267,
  "server_time": 1792036188159,
  "discount_amount": 0
}
```

| return_code | Meaning |
|---|---|
| `1` | paid |
| `2` | failed. With `sub_return_code: -101` (ORDER_NOT_EXIST), the order doesn't exist |
| `3` | not paid yet / processing |

## Status codes

| Code | Where | Meaning |
|---|---|---|
| `return_code 1` | create, query | success / paid |
| `return_code 2` | create, query | failed; see `sub_return_code` |
| `return_code 3` | query | processing (not paid yet) |
| `-401` | create | ILLEGAL_DATA_REQUEST |
| `-402` | create, query | ILLEGAL_APP/SIGNATURE_REQUEST |
| `-68` | create | DUPLICATE_APPS_TRANS_ID |
| `-101` | query | ORDER_NOT_EXIST |
| `channel 38` | callback | ZaloPay wallet (the only channel the sandbox reports) |

## Test scenarios

| Scenario | How |
|---|---|
| Successful payment | `order_url` → *Thanh toán thành công* |
| Failed payment (no callback) | `order_url` → *Thanh toán thất bại*, then query → `return_code 2` |
| Order never paid | create only, then query → `return_code 3` |
| Callback from a test | `POST /__sandbox/providers/zalopay/orders/:app_trans_id/webhook` with `{"status": "success"}` or `{"status": "failed"}` ([control API](sandbox-api.md)) |
| No app at all | dashboard → **Quick Trigger** → *ZaloPay: Bắn Callback* |
| Forged callback | dashboard → **Edit & Fire** → *Wrong signature* → expect `return_code: -1` |
| Duplicate callback | dashboard → **Replay** a delivered callback |
| Callback lost | **Chaos Mode** → *Simulate Dropped Webhook*, then reconcile with the query API |

## Troubleshooting

**`-402` on create.** Check the order of the seven fields and that you hash `amount` and `app_time` exactly as you send them. Also check that `embed_data` and `item` in the mac are the same strings you put in the body. The error message shows the string the sandbox signed.

**`-401` "must start with today's date".** Build the prefix from GMT+7, not from your server's local time or UTC. Around midnight the two can differ.

**Callback mac never matches.** Hash the raw `data` string. Re-serialising the parsed object (`JSON.stringify(JSON.parse(data))`) can reorder or reformat it.

## Differences from ZaloPay

- `order_url` and `qr_code` point to the sandbox page.
- Only the wallet channel (`38`) is simulated; `bank_code` is stored but not used.
- ZaloPay doesn't document `sub_return_code` for pending or failed queries, or the redirect `status` for failures. The sandbox mirrors `return_code` and uses `status=2`.
- Refunds, binding/tokenization and QR (static) flows are not simulated.
- The retry schedule is the sandbox's (3s, 10s, 30s), not ZaloPay's.
