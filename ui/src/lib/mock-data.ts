import type {
  DeliveryChaos,
  DeliveryTrigger,
  ProviderName,
  SandboxConfig,
  WebhookDelivery,
  WebhookLog,
  WebhookSource,
  WebhookStatus,
} from "./types";

/**
 * Sample webhook activity shown when the dashboard cannot reach a running
 * pay-sandbox server (for example when running `vite` on its own).
 */
const API_BASE = "http://localhost:4242";

export const DEMO_CONFIG: SandboxConfig = {
  webhookUrl: "http://localhost:3000/api/webhook",
  webhookSecret: "whsec_test_sandbox_secret",
  webhookTimeoutMs: 5_000,
  apiVersion: "2025-09-30.clover",
  apiBase: API_BASE,
  retry: { enabled: true, scheduleMs: [3_000, 10_000, 30_000] },
  chaos: {
    api: { enabled: false, minDelayMs: 1_000, maxDelayMs: 5_000, errorRate: 0 },
    webhooks: { latencyEnabled: false, minDelayMs: 1_000, maxDelayMs: 5_000, dropEnabled: false, dropRate: 0.15 },
  },
  providers: [
    {
      name: "stripe",
      displayName: "Stripe",
      settings: [
        { key: "webhookUrl", label: "Webhook URL", value: "http://localhost:3000/api/webhook", kind: "url", editable: true },
        { key: "webhookSecret", label: "Signing secret", value: "whsec_test_sandbox_secret", kind: "secret", editable: true },
      ],
      endpoints: [{ label: "API base", method: "POST", url: `${API_BASE}/v1` }],
    },
    {
      name: "momo",
      displayName: "MoMo",
      settings: [
        { key: "partnerCode", label: "partnerCode", value: "MOMOSBX00001", kind: "text", editable: true },
        { key: "accessKey", label: "accessKey", value: "paysandboxmomoaccess", kind: "secret", editable: true },
        { key: "secretKey", label: "secretKey", value: "paysandboxmomosecretkey000000001", kind: "secret", editable: true },
      ],
      endpoints: [{ label: "Create", method: "POST", url: `${API_BASE}/momo/v2/gateway/api/create` }],
    },
    {
      name: "zalopay",
      displayName: "ZaloPay",
      settings: [
        { key: "appId", label: "app_id", value: "2554", kind: "text", editable: true },
        { key: "key1", label: "key1", value: "paysandboxzalopaykey1000000000001", kind: "secret", editable: true },
        { key: "key2", label: "key2", value: "paysandboxzalopaykey2000000000002", kind: "secret", editable: true },
      ],
      endpoints: [{ label: "Create", method: "POST", url: `${API_BASE}/zalopay/v2/create` }],
    },
    {
      name: "vnpay",
      displayName: "VNPay",
      settings: [
        { key: "tmnCode", label: "vnp_TmnCode", value: "PAYSBX01", kind: "text", editable: true },
        { key: "hashSecret", label: "vnp_HashSecret", value: "PAYSANDBOXVNPAYHASHSECRET0000001", kind: "secret", editable: true },
        { key: "ipnUrl", label: "IPN URL", value: "http://localhost:3000/api/vnpay/ipn", kind: "url", editable: true },
      ],
      endpoints: [{ label: "vnp_Url", method: "GET", url: `${API_BASE}/vnpay/paymentv2/vpcpay.html` }],
    },
  ],
  triggers: [
    { id: "stripe:payment_intent.succeeded", provider: "stripe", label: "payment_intent.succeeded", description: "PaymentIntent + Charge, $20.00" },
    { id: "stripe:checkout.session.completed", provider: "stripe", label: "checkout.session.completed", description: "Paid Checkout Session, $49.00" },
    { id: "momo:success", provider: "momo", label: "MoMo: Thanh toán thành công (code 0)", description: "IPN resultCode 0 · 150.000 ₫" },
    { id: "momo:expired", provider: "momo", label: "MoMo: Hết hạn giao dịch (code 1005)", description: "IPN resultCode 1005" },
    { id: "zalopay:callback", provider: "zalopay", label: "ZaloPay: Bắn Callback", description: "Callback thanh toán thành công · 120.000 ₫" },
    { id: "vnpay:success", provider: "vnpay", label: "VNPay: Bắn IPN thành công (00)", description: "IPN vnp_ResponseCode 00 · 250.000 ₫" },
  ],
};

const SAMPLE_SIGNATURE = "5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd";

interface SampleAttempt {
  statusCode: number | null;
  ok: boolean;
  durationMs: number;
  body: string;
  error?: string;
  note?: string;
  trigger?: DeliveryTrigger;
  chaos?: DeliveryChaos;
}

interface SampleSpec {
  provider: ProviderName;
  type: string;
  eventId: string;
  objectId: string;
  summary: string | null;
  source: WebhookSource;
  secondsAgo: number;
  payload: Record<string, unknown>;
  request: { method: "GET" | "POST"; url: string; headers: Record<string, string> };
  attempts: SampleAttempt[];
  retryPending?: { secondsUntilNext: number };
}

const now = Date.now();
const stripeTimestamp = Math.floor((now - 70_000) / 1000);
const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

const vnpayParams: Record<string, string> = {
  vnp_Amount: "25000000",
  vnp_BankCode: "NCB",
  vnp_BankTranNo: "VNP14853920",
  vnp_CardType: "ATM",
  vnp_OrderInfo: "Thanh toan don hang 1042",
  vnp_PayDate: "20261015101530",
  vnp_ResponseCode: "00",
  vnp_TmnCode: "PAYSBX01",
  vnp_TransactionNo: "14853920",
  vnp_TransactionStatus: "00",
  vnp_TxnRef: "1760498130123",
  vnp_SecureHash: `${SAMPLE_SIGNATURE}${SAMPLE_SIGNATURE}`,
};

const SAMPLES: SampleSpec[] = [
  {
    provider: "momo",
    type: "momo.ipn",
    eventId: "SBX1760498120001",
    objectId: "SBX1760498120001",
    summary: "resultCode 0 · Thành công.",
    source: "checkout",
    secondsAgo: 6,
    payload: {
      partnerCode: "MOMOSBX00001",
      orderId: "SBX1760498120001",
      requestId: "SBX1760498120001",
      amount: 150000,
      orderInfo: "Thanh toan don hang 1041",
      orderType: "momo_wallet",
      transId: 4093847261,
      resultCode: 0,
      message: "Thành công.",
      payType: "qr",
      responseTime: now - 6_000,
      extraData: "",
      signature: SAMPLE_SIGNATURE,
    },
    request: { method: "POST", url: "http://localhost:3000/api/momo/ipn", headers: jsonHeaders },
    attempts: [{ statusCode: 204, ok: true, durationMs: 14, body: "" }],
  },
  {
    provider: "vnpay",
    type: "vnpay.ipn",
    eventId: "1760498130123",
    objectId: "1760498130123",
    summary: "vnp_ResponseCode 00 · Giao dịch thành công",
    source: "checkout",
    secondsAgo: 20,
    payload: vnpayParams,
    request: {
      method: "GET",
      url: `http://localhost:3000/api/vnpay/ipn?${new URLSearchParams(vnpayParams).toString()}`,
      headers: { "user-agent": "VNPAY-IPN/2.1.0 (pay-sandbox)" },
    },
    attempts: [
      {
        statusCode: 200,
        ok: false,
        durationMs: 9,
        body: '{"RspCode":"97","Message":"Invalid Checksum"}',
        note: "RspCode 97: Invalid checksum. VNPay keeps retrying until 00 or 02.",
      },
    ],
    retryPending: { secondsUntilNext: 8 },
  },
  {
    provider: "zalopay",
    type: "zalopay.callback",
    eventId: "261015_48213377",
    objectId: "261015_48213377",
    summary: "Paid 120.000 ₫ · zp_trans_id 261015938471625",
    source: "trigger",
    secondsAgo: 45,
    payload: {
      data: JSON.stringify({
        app_id: 2554,
        app_trans_id: "261015_48213377",
        app_time: now - 46_000,
        app_user: "pay_sandbox_user",
        amount: 120000,
        embed_data: "{}",
        item: "[]",
        zp_trans_id: 261015938471625,
        server_time: now - 45_000,
        channel: 38,
        merchant_user_id: "sbx_pay_sandbox_user",
        user_fee_amount: 0,
        discount_amount: 0,
      }),
      mac: SAMPLE_SIGNATURE,
      type: 1,
    },
    request: { method: "POST", url: "http://localhost:3000/api/zalopay/callback", headers: jsonHeaders },
    attempts: [{ statusCode: 200, ok: true, durationMs: 21, body: '{"return_code":1,"return_message":"success"}' }],
  },
  {
    provider: "stripe",
    type: "payment_intent.succeeded",
    eventId: "evt_1QDemo01aBcDeFgHiJkLmNo",
    objectId: "pi_3QDemoA1b2C3d4E5f6G7h8I9",
    summary: null,
    source: "api",
    secondsAgo: 70,
    payload: {
      id: "evt_1QDemo01aBcDeFgHiJkLmNo",
      object: "event",
      api_version: "2025-09-30.clover",
      created: stripeTimestamp,
      data: {
        object: {
          id: "pi_3QDemoA1b2C3d4E5f6G7h8I9",
          object: "payment_intent",
          amount: 2000,
          amount_received: 2000,
          currency: "usd",
          status: "succeeded",
          metadata: { order_id: "order_42" },
        },
      },
      livemode: false,
      pending_webhooks: 0,
      request: { id: "req_Demo1xYz", idempotency_key: null },
      type: "payment_intent.succeeded",
    },
    request: {
      method: "POST",
      url: "http://localhost:3000/api/webhook",
      headers: {
        ...jsonHeaders,
        "user-agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks)",
        "stripe-signature": `t=${stripeTimestamp},v1=${SAMPLE_SIGNATURE}`,
      },
    },
    attempts: [{ statusCode: 200, ok: true, durationMs: 18, body: '{"received":true}' }],
  },
  {
    provider: "momo",
    type: "momo.ipn",
    eventId: "SBX1760498010007",
    objectId: "SBX1760498010007",
    summary: "resultCode 1005 · Giao dịch thất bại do url hoặc QR code đã hết hạn.",
    source: "trigger",
    secondsAgo: 140,
    payload: {
      partnerCode: "MOMOSBX00001",
      orderId: "SBX1760498010007",
      requestId: "SBX1760498010007",
      amount: 150000,
      orderInfo: "Thanh toan don hang pay-sandbox",
      orderType: "momo_wallet",
      transId: 4093846110,
      resultCode: 1005,
      message: "Giao dịch thất bại do url hoặc QR code đã hết hạn.",
      payType: "qr",
      responseTime: now - 140_000,
      extraData: "",
      signature: SAMPLE_SIGNATURE,
    },
    request: { method: "POST", url: "http://localhost:3000/api/momo/ipn", headers: jsonHeaders },
    attempts: [
      {
        statusCode: null,
        ok: false,
        durationMs: 0,
        body: "",
        error: "Chaos Mode: webhook dropped before reaching your endpoint",
        chaos: { delayMs: 0, dropped: true },
      },
      {
        statusCode: 200,
        ok: true,
        durationMs: 12,
        body: '{"ok":true}',
        note: "MoMo expects HTTP 204 No Content; your endpoint answered 200.",
        trigger: "retry",
      },
    ],
  },
];

function sampleLog(spec: SampleSpec, index: number): WebhookLog {
  const createdAt = now - spec.secondsAgo * 1000;
  let automaticAttempts = 0;

  const deliveries: WebhookDelivery[] = spec.attempts.map((attempt, attemptIndex) => {
    const trigger = attempt.trigger ?? (attemptIndex === 0 ? "automatic" : "retry");
    if (trigger !== "replay") automaticAttempts += 1;
    return {
      id: `whd_demo_${index}_${attemptIndex}`,
      trigger,
      attempt: trigger === "replay" ? null : automaticAttempts,
      attemptedAt: createdAt + attemptIndex * 3_000,
      method: spec.request.method,
      url: spec.request.url,
      requestHeaders: spec.request.headers,
      requestBody: spec.request.method === "POST" ? JSON.stringify(spec.payload) : "",
      statusCode: attempt.statusCode,
      ok: attempt.ok,
      durationMs: attempt.durationMs,
      responseBody: attempt.body,
      error: attempt.error ?? null,
      note: attempt.note ?? null,
      chaos: attempt.chaos ?? null,
    };
  });

  const last = deliveries.at(-1);
  const status: WebhookStatus = last?.ok ? "succeeded" : spec.retryPending ? "retrying" : "failed";

  return {
    id: `whl_demo_${index}`,
    provider: spec.provider,
    eventId: spec.eventId,
    type: spec.type,
    objectId: spec.objectId,
    summary: spec.summary,
    source: spec.source,
    signatureMode: "valid",
    createdAt,
    payload: spec.payload,
    deliveries,
    status,
    attempt_count: automaticAttempts,
    max_retries: DEMO_CONFIG.retry.scheduleMs.length,
    next_retry_at: spec.retryPending ? now + spec.retryPending.secondsUntilNext * 1000 : null,
  };
}

export const DEMO_LOGS: WebhookLog[] = SAMPLES.map(sampleLog);
