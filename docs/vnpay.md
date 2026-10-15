# VNPay

pay-sandbox simulates the VNPay payment gateway (API 2.1.0). VNPay has no "create" API: your backend builds a signed redirect URL. The sandbox's payment page **verifies that URL's `vnp_SecureHash`** (HMAC-SHA512), lets you choose the outcome, sends a signed IPN to your IPN URL and redirects the customer to `vnp_ReturnUrl`.

![VNPay payment page](assets/vnpay-checkout.png)

- [Endpoints and credentials](#endpoints-and-credentials)
- [1. Build the payment URL](#1-build-the-payment-url)
- [2. Customer pays](#2-customer-pays)
- [3. Handle the IPN](#3-handle-the-ipn)
- [4. Return URL](#4-return-url)
- [Response codes](#response-codes)
- [Test scenarios](#test-scenarios)
- [Troubleshooting](#troubleshooting)
- [Differences from VNPay](#differences-from-vnpay)

## Endpoints and credentials

| | VNPay sandbox | pay-sandbox |
|---|---|---|
| Payment URL (`vnp_Url`) | `https://sandbox.vnpayment.vn/paymentv2/vpcpay.html` | `http://localhost:4242/vnpay/paymentv2/vpcpay.html` |
| IPN URL | registered in the merchant portal | set on the dashboard (default `http://localhost:3000/api/vnpay/ipn`) |
| URL builder | none (your backend) | `POST /vnpay/create` (sandbox helper) |

| Credential | Default |
|---|---|
| `vnp_TmnCode` | `PAYSBX01` |
| `vnp_HashSecret` | `PAYSANDBOXVNPAYHASHSECRET0000001` |

On the dashboard (**VNPay** tab) you can change the credentials, the IPN URL and the **IPN method**: `GET` (VNPay's default) or `POST` (form-encoded).

## 1. Build the payment URL

Signing rules:

1. take every `vnp_*` parameter except `vnp_SecureHash` and `vnp_SecureHashType`;
2. sort them by name;
3. URL-encode each value (spaces as `+`) and join as `key=value&…`;
4. `vnp_SecureHash = HMAC_SHA512(vnp_HashSecret, thatString)`, in hex.

This is the same helper as VNPay's official Node.js sample:

```js
import crypto from "node:crypto";
import qs from "qs";

const VNPAY = {
  url: "http://localhost:4242/vnpay/paymentv2/vpcpay.html", // https://sandbox.vnpayment.vn/paymentv2/vpcpay.html
  tmnCode: "PAYSBX01",
  hashSecret: "PAYSANDBOXVNPAYHASHSECRET0000001",
  returnUrl: "http://localhost:3000/payment/vnpay/return",
};
const hmacSha512 = (key, data) => crypto.createHmac("sha512", key).update(data).digest("hex");

// Same helper as VNPay's official Node.js sample.
function sortObject(obj) {
  const sorted = {};
  for (const key of Object.keys(obj).map(encodeURIComponent).sort()) {
    sorted[key] = encodeURIComponent(obj[key]).replace(/%20/g, "+");
  }
  return sorted;
}

// yyyyMMddHHmmss in GMT+7
const vnpDate = (date) => new Date(date.getTime() + 7 * 3_600_000).toISOString().replace(/[-T:]/g, "").slice(0, 14);

function createVnpayUrl({ txnRef, amount, orderInfo, ipAddr }) {
  const now = new Date();
  const params = sortObject({
    vnp_Version: "2.1.0",
    vnp_Command: "pay",
    vnp_TmnCode: VNPAY.tmnCode,
    vnp_Locale: "vn",
    vnp_CurrCode: "VND",
    vnp_TxnRef: txnRef,
    vnp_OrderInfo: orderInfo,
    vnp_OrderType: "other",
    vnp_Amount: amount * 100,
    vnp_ReturnUrl: VNPAY.returnUrl,
    vnp_IpAddr: ipAddr,
    vnp_CreateDate: vnpDate(now),
    vnp_ExpireDate: vnpDate(new Date(now.getTime() + 15 * 60_000)),
  });
  const signData = qs.stringify(params, { encode: false });
  params.vnp_SecureHash = hmacSha512(VNPAY.hashSecret, signData);
  return `${VNPAY.url}?${qs.stringify(params, { encode: false })}`;
}
```

Required parameters: `vnp_Version` (`2.1.0`), `vnp_Command` (`pay`), `vnp_TmnCode`, `vnp_Amount` (**VND × 100**), `vnp_CreateDate`, `vnp_CurrCode` (`VND`), `vnp_IpAddr`, `vnp_Locale`, `vnp_OrderInfo`, `vnp_OrderType`, `vnp_ReturnUrl`, `vnp_ExpireDate`, `vnp_TxnRef` and `vnp_SecureHash`. `vnp_BankCode` is optional.

Both common encodings are accepted: `encodeURIComponent` with `+` for spaces (Node.js sample) and PHP's `urlencode`.

### The sandbox URL helper

If you only want a URL to click, the sandbox can build one with its own credentials. This endpoint does not exist on VNPay.

```bash
curl -X POST http://localhost:4242/vnpay/create \
  -H 'content-type: application/json' \
  -d '{"amount": 250000, "orderInfo": "Thanh toan don hang 1042", "txnRef": "1042001"}'
```

```json
{
  "paymentUrl": "http://localhost:4242/vnpay/paymentv2/vpcpay.html?vnp_Amount=25000000&vnp_Command=pay&vnp_CreateDate=20261015104948&…&vnp_TxnRef=1042001&vnp_Version=2.1.0&vnp_SecureHash=5bddd491…",
  "params": { "vnp_Version": "2.1.0", "vnp_Amount": "25000000", "vnp_TxnRef": "1042001", "…": "…" },
  "note": "Sandbox helper: real VNPay has no create API; build this URL in your backend."
}
```

Optional fields: `txnRef`, `returnUrl`, `bankCode`, `locale`, `orderType`, `ipAddr`, `expireMinutes` (default 15).

### Validation

If the URL is invalid, the payment page shows an error (HTTP 400) instead of the payment options:

| Error | When |
|---|---|
| Thiếu tham số bắt buộc | a required parameter is missing |
| Mã website không tồn tại | unknown `vnp_TmnCode` |
| **Sai chữ ký** | `vnp_SecureHash` doesn't match. The page shows the exact string the sandbox hashed |
| `vnp_Version`, `vnp_Command`, `vnp_CurrCode` | not `2.1.0`, `pay`, `VND` |
| `vnp_Amount` | not a positive multiple of 100 |
| Giao dịch đã quá thời gian chờ thanh toán | `vnp_ExpireDate` is in the past |
| Giao dịch … đã được xử lý | the `vnp_TxnRef` was already paid or cancelled |

## 2. Customer pays

| Button | vnp_ResponseCode |
|---|---|
| Thanh toán thành công | `00` |
| Khách hàng hủy giao dịch | `24` |
| Tài khoản không đủ số dư | `51` |
| Hết hạn chờ thanh toán | `11` |

Each choice sends the IPN and redirects the browser to `vnp_ReturnUrl`.

## 3. Handle the IPN

VNPay calls your IPN URL server-to-server, with `GET` by default:

```text
GET /api/vnpay/ipn?vnp_Amount=25000000&vnp_BankCode=NCB&vnp_BankTranNo=VNP50861342&vnp_CardType=ATM
    &vnp_OrderInfo=Thanh+toan+don+hang+1042&vnp_PayDate=20261015104948&vnp_ResponseCode=00
    &vnp_TmnCode=PAYSBX01&vnp_TransactionNo=50861342&vnp_TransactionStatus=00&vnp_TxnRef=1042001
    &vnp_SecureHash=f41ff496…
```

| Parameter | Value |
|---|---|
| `vnp_Amount` | VND × 100, the amount you sent |
| `vnp_ResponseCode` | the outcome, see [Response codes](#response-codes) |
| `vnp_TransactionStatus` | `00` on success, `02` otherwise |
| `vnp_TransactionNo` | VNPay's transaction number (`0` when not paid) |
| `vnp_BankTranNo` | only on success |
| `vnp_BankCode`, `vnp_CardType`, `vnp_PayDate`, `vnp_OrderInfo`, `vnp_TmnCode`, `vnp_TxnRef` | as named |

Follow VNPay's checklist in order: verify the hash, find the order, check the amount, check that it isn't already confirmed, then update it.

```js
import express from "express";

const app = express();

app.get("/api/vnpay/ipn", (req, res) => {
  const { vnp_SecureHash, vnp_SecureHashType, ...params } = req.query;
  const signData = qs.stringify(sortObject(params), { encode: false });
  if (hmacSha512(VNPAY.hashSecret, signData) !== vnp_SecureHash) {
    return res.json({ RspCode: "97", Message: "Invalid Checksum" });
  }

  const order = orders.get(params.vnp_TxnRef);
  if (!order) return res.json({ RspCode: "01", Message: "Order not found" });
  if (order.amount * 100 !== Number(params.vnp_Amount)) return res.json({ RspCode: "04", Message: "Invalid amount" });
  if (order.status !== "pending") return res.json({ RspCode: "02", Message: "Order already confirmed" });

  order.status = params.vnp_ResponseCode === "00" && params.vnp_TransactionStatus === "00" ? "paid" : "failed";
  res.json({ RspCode: "00", Message: "Confirm Success" });
});
```

If you switch the dashboard to `POST`, the same parameters arrive as an `application/x-www-form-urlencoded` body. Read them from `req.body` (`express.urlencoded()`) instead of `req.query`.

How the sandbox reads your answer, mirroring VNPay's retry rules:

| Your `RspCode` | Meaning | Result |
|---|---|---|
| `00` | Confirm Success | acknowledged |
| `02` | Order already confirmed | acknowledged |
| `01` | Order not found | retried |
| `04` | Invalid amount | retried |
| `97` | Invalid checksum | retried |
| `99` | Unknown error | retried |
| non-200, no JSON `RspCode`, timeout | | retried |

Note that VNPay keeps calling until you answer `00` or `02`, even when the IPN is for a failed payment.

## 4. Return URL

The customer is redirected to `vnp_ReturnUrl` with the same signed parameters as the IPN. Verify `vnp_SecureHash` with the same code and **only display the result**. VNPay is explicit that order status must be updated from the IPN, not the return URL.

## Response codes

`vnp_ResponseCode`, from [VNPay's documentation](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html):

| Code | Meaning | On the payment page |
|---|---|---|
| `00` | Giao dịch thành công | ✅ |
| `07` | Trừ tiền thành công, giao dịch bị nghi ngờ | |
| `09` | Thẻ/Tài khoản chưa đăng ký InternetBanking | |
| `10` | Xác thực thông tin thẻ/tài khoản không đúng quá 3 lần | |
| `11` | Đã hết hạn chờ thanh toán | ✅ |
| `12` | Thẻ/Tài khoản bị khóa | |
| `13` | Nhập sai mật khẩu OTP | |
| `24` | Khách hàng hủy giao dịch | ✅ |
| `51` | Tài khoản không đủ số dư | ✅ |
| `65` | Vượt quá hạn mức giao dịch trong ngày | |
| `75` | Ngân hàng thanh toán đang bảo trì | |
| `79` | Nhập sai mật khẩu thanh toán quá số lần quy định | |
| `99` | Lỗi khác | |

Every code can be sent through the [control API](sandbox-api.md).

## Test scenarios

| Scenario | How |
|---|---|
| Successful payment | payment URL → *Thanh toán thành công* |
| Cancelled / insufficient funds / expired | the matching button |
| Any response code from a test | open the payment URL once (this registers the order), then `POST /__sandbox/providers/vnpay/orders/:vnp_TxnRef/webhook` with `{"status": "65"}` |
| Wrong hash in your URL | change any parameter of a signed URL → *Sai chữ ký* |
| Duplicate IPN | dashboard → **Replay** a delivered IPN → expect your `RspCode 02` |
| Forged IPN | dashboard → **Edit & Fire** → *Wrong signature* → expect `97` (and watch VNPay retry) |
| POST IPN | dashboard → VNPay tab → *IPN method* `POST` |
| No app at all | dashboard → **Quick Trigger** → *VNPay: Bắn IPN thành công (00)* / *Khách hủy giao dịch (24)* |

Quick Triggers create the order inside the sandbox, so your app answers `RspCode 01` (order not found) and the sandbox keeps retrying. That is correct VNPay behaviour. Create the order from your app to test the full flow.

## Troubleshooting

**"Sai chữ ký" on the payment page.** The page prints the string the sandbox hashed; compare it with yours. Usual causes:
- hashing before sorting;
- encoding values twice (`qs.stringify` without `encode: false`);
- including `vnp_SecureHash` in the hash;
- spaces encoded as `%20` instead of `+`.

**The IPN fails verification in your app.** Your framework has already decoded the query string. Re-encode with the same `sortObject` before hashing, as in the example. Don't hash the raw URL.

**`RspCode 04` for a correct amount.** `vnp_Amount` is VND × 100. Compare `order.amount * 100` with `Number(vnp_Amount)`.

**The IPN keeps coming.** Answer `02` when the order is already confirmed, not `00` again and not an error.

## Differences from VNPay

- `querydr` (transaction query) and refund APIs are not simulated yet.
- Bank selection, QR and card entry screens are replaced by outcome buttons. `vnp_BankCode` defaults to `NCB` and `vnp_CardType` is always `ATM`.
- The VNPay error codes shown on the real error page are not reproduced; the sandbox shows a readable reason instead.
- VNPay retries an IPN up to 10 times, 5 minutes apart. The sandbox uses its own schedule (3s, 10s, 30s).
