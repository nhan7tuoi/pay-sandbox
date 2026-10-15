import type { FastifyInstance } from "fastify";
import { type SandboxConfig, type VnpayConfig, parseHttpUrl } from "../config.js";
import { generateId } from "../ids.js";
import type { SignatureMode, WebhookLog, WebhookSource } from "../types.js";
import type { WebhookDispatcher } from "../webhook/dispatcher.js";
import {
  asInteger,
  asString,
  formatVnd,
  hmacHex,
  isRecord,
  numericId,
  parseVnTimestamp,
  renderHostedPage,
  signaturesMatch,
  tamperedKey,
  vnTimestamp,
} from "./shared.js";
import type {
  BaseProvider,
  DispatchInit,
  ProviderDescription,
  ResponseEvaluation,
  TriggerDefinition,
  WebhookRequestSpec,
} from "./types.js";

/** vnp_ResponseCode values, from https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html */
const RESPONSE_CODES: Record<string, string> = {
  "00": "Giao dịch thành công",
  "07": "Trừ tiền thành công, giao dịch bị nghi ngờ",
  "09": "Thẻ/Tài khoản chưa đăng ký dịch vụ InternetBanking",
  "10": "Xác thực thông tin thẻ/tài khoản không đúng quá 3 lần",
  "11": "Đã hết hạn chờ thanh toán",
  "12": "Thẻ/Tài khoản bị khóa",
  "13": "Nhập sai mật khẩu xác thực giao dịch (OTP)",
  "24": "Khách hàng hủy giao dịch",
  "51": "Tài khoản không đủ số dư",
  "65": "Tài khoản đã vượt quá hạn mức giao dịch trong ngày",
  "75": "Ngân hàng thanh toán đang bảo trì",
  "79": "Nhập sai mật khẩu thanh toán quá số lần quy định",
  "99": "Lỗi khác",
};

/** Merchant answers to the IPN. 00 and 02 end the flow; anything else makes VNPay retry. */
const RSP_CODES: Record<string, string> = {
  "00": "Confirm Success",
  "01": "Order not found",
  "02": "Order already confirmed",
  "04": "Invalid amount",
  "97": "Invalid checksum",
  "99": "Unknown error",
};

const REQUIRED_PAY_PARAMS = [
  "vnp_Version",
  "vnp_Command",
  "vnp_TmnCode",
  "vnp_Amount",
  "vnp_CreateDate",
  "vnp_CurrCode",
  "vnp_IpAddr",
  "vnp_Locale",
  "vnp_OrderInfo",
  "vnp_OrderType",
  "vnp_ReturnUrl",
  "vnp_ExpireDate",
  "vnp_TxnRef",
  "vnp_SecureHash",
];

const EXCLUDED_FROM_HASH = new Set(["vnp_SecureHash", "vnp_SecureHashType"]);

/** Encoding used by VNPay's Node.js sample: encodeURIComponent with spaces as `+`. */
function encodeNode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

/** Encoding used by VNPay's PHP sample (`urlencode`), which also escapes `!'()*~`. */
function encodePhp(value: string): string {
  return encodeNode(value).replace(/[!'()*~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The string VNPay signs: every parameter except vnp_SecureHash / vnp_SecureHashType,
 * sorted by name, `key=urlencoded(value)` joined with `&`.
 */
export function vnpaySignData(params: Record<string, string>, encode: (value: string) => string = encodeNode): string {
  return Object.keys(params)
    .filter((key) => !EXCLUDED_FROM_HASH.has(key))
    .sort()
    .map((key) => `${encode(key)}=${encode(params[key] ?? "")}`)
    .join("&");
}

export function vnpaySign(params: Record<string, string>, hashSecret: string): string {
  return hmacHex("sha512", hashSecret, vnpaySignData(params));
}

/** Query string for a signed parameter set, in the same encoding that was hashed. */
function toSignedQuery(params: Record<string, string>): string {
  const hash = params.vnp_SecureHash ?? "";
  const data = vnpaySignData(params);
  return hash ? `${data}&vnp_SecureHash=${hash}` : data;
}

function stringParams(source: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const first = Array.isArray(value) ? value[0] : value;
    const text = asString(first);
    if (text !== null) result[key] = text;
  }
  return result;
}

export interface VnpayOrder {
  txnRef: string;
  amount: number;
  orderInfo: string;
  orderType: string;
  bankCode: string;
  locale: string;
  returnUrl: string;
  ipAddr: string;
  createDate: string;
  expireDate: string;
  status: "pending" | "final";
  responseCode: string | null;
  transactionNo: string | null;
  payDate: string | null;
  createdAt: number;
}

class VnpayPageError extends Error {}

export interface VnpayProviderContext {
  config: SandboxConfig;
  dispatcher: WebhookDispatcher;
}

/**
 * VNPay (API 2.1.0) adapter.
 *
 * - VNPay has no "create" API: the merchant builds a signed redirect URL. The sandbox page at
 *   `GET /vnpay/paymentv2/vpcpay.html` verifies that URL's HMAC-SHA512 `vnp_SecureHash`.
 * - `POST /vnpay/create` is a sandbox-only helper that builds such a URL for you.
 * - IPNs are sent to the portal-configured IPN URL (GET by default) with signed `vnp_*` params;
 *   the merchant answers `{"RspCode": "00", "Message": "Confirm Success"}`.
 */
export class VnpayProvider implements BaseProvider {
  readonly name = "vnpay" as const;
  readonly displayName = "VNPay";

  private readonly orders = new Map<string, VnpayOrder>();

  constructor(private readonly ctx: VnpayProviderContext) {}

  private get settings(): VnpayConfig {
    return this.ctx.config.providers.vnpay;
  }

  /**
   * Validates the query parameters of a payment URL (as built by the merchant) and
   * stores the order. Throws a VnpayPageError describing what VNPay would reject.
   */
  createOrder(rawParams: Record<string, unknown>): Record<string, unknown> {
    const settings = this.settings;
    const params = stringParams(rawParams);

    const missing = REQUIRED_PAY_PARAMS.filter((key) => !params[key]);
    if (missing.length > 0) throw new VnpayPageError(`Thiếu tham số bắt buộc: ${missing.join(", ")}`);

    if (params.vnp_TmnCode !== settings.tmnCode) {
      throw new VnpayPageError(`Mã website (vnp_TmnCode '${params.vnp_TmnCode}') không tồn tại. Sandbox dùng '${settings.tmnCode}'.`);
    }

    const received = params.vnp_SecureHash ?? "";
    const validNode = signaturesMatch(hmacHex("sha512", settings.hashSecret, vnpaySignData(params, encodeNode)), received);
    const validPhp = signaturesMatch(hmacHex("sha512", settings.hashSecret, vnpaySignData(params, encodePhp)), received);
    if (!validNode && !validPhp) {
      throw new VnpayPageError(`Sai chữ ký (invalid vnp_SecureHash). pay-sandbox hashed this string with HMAC-SHA512: ${vnpaySignData(params)}`);
    }

    if (params.vnp_Version !== "2.1.0") throw new VnpayPageError("vnp_Version phải là 2.1.0");
    if (params.vnp_Command !== "pay") throw new VnpayPageError("vnp_Command phải là 'pay'");
    if (params.vnp_CurrCode !== "VND") throw new VnpayPageError("vnp_CurrCode chỉ hỗ trợ VND");

    const rawAmount = asInteger(params.vnp_Amount);
    if (rawAmount === null || rawAmount <= 0 || rawAmount % 100 !== 0) {
      throw new VnpayPageError("vnp_Amount phải là số tiền VND nhân 100 (ví dụ 100.000 ₫ → 10000000)");
    }

    const createDate = parseVnTimestamp(params.vnp_CreateDate ?? "");
    const expireDate = parseVnTimestamp(params.vnp_ExpireDate ?? "");
    if (!createDate || !expireDate) throw new VnpayPageError("vnp_CreateDate / vnp_ExpireDate phải có dạng yyyyMMddHHmmss (GMT+7)");
    if (expireDate.getTime() < Date.now()) throw new VnpayPageError("Giao dịch đã quá thời gian chờ thanh toán (vnp_ExpireDate)");

    let returnUrl: string;
    try {
      returnUrl = parseHttpUrl(params.vnp_ReturnUrl, "vnp_ReturnUrl");
    } catch {
      throw new VnpayPageError("vnp_ReturnUrl không hợp lệ");
    }

    const txnRef = params.vnp_TxnRef ?? "";
    const existing = this.orders.get(txnRef);
    if (existing && existing.status === "final") {
      throw new VnpayPageError(`Giao dịch vnp_TxnRef '${txnRef}' đã được xử lý (vnp_ResponseCode ${existing.responseCode})`);
    }

    const order: VnpayOrder = {
      txnRef,
      amount: rawAmount / 100,
      orderInfo: params.vnp_OrderInfo ?? "",
      orderType: params.vnp_OrderType ?? "other",
      bankCode: params.vnp_BankCode ?? "",
      locale: params.vnp_Locale ?? "vn",
      returnUrl,
      ipAddr: params.vnp_IpAddr ?? "",
      createDate: params.vnp_CreateDate ?? "",
      expireDate: params.vnp_ExpireDate ?? "",
      status: "pending",
      responseCode: null,
      transactionNo: null,
      payDate: null,
      createdAt: Date.now(),
    };
    this.orders.set(txnRef, order);
    return { vnp_TxnRef: txnRef, amount: order.amount, status: order.status };
  }

  /** Builds a signed payment URL the way a merchant backend would. */
  buildPaymentUrl(
    baseUrl: string,
    input: { amount: number; orderInfo: string; txnRef?: string; returnUrl?: string; bankCode?: string; locale?: string; orderType?: string; ipAddr?: string; expireMinutes?: number },
  ): { paymentUrl: string; params: Record<string, string> } {
    const settings = this.settings;
    const now = new Date();
    const params: Record<string, string> = {
      vnp_Version: "2.1.0",
      vnp_Command: "pay",
      vnp_TmnCode: settings.tmnCode,
      vnp_Amount: String(Math.round(input.amount * 100)),
      vnp_CreateDate: vnTimestamp(now),
      vnp_CurrCode: "VND",
      vnp_IpAddr: input.ipAddr ?? "127.0.0.1",
      vnp_Locale: input.locale ?? "vn",
      vnp_OrderInfo: input.orderInfo,
      vnp_OrderType: input.orderType ?? "other",
      vnp_ReturnUrl: input.returnUrl ?? settings.defaultReturnUrl,
      vnp_ExpireDate: vnTimestamp(new Date(now.getTime() + (input.expireMinutes ?? 15) * 60_000)),
      vnp_TxnRef: input.txnRef ?? `${Date.now()}${numericId(3)}`,
    };
    if (input.bankCode) params.vnp_BankCode = input.bankCode;
    params.vnp_SecureHash = vnpaySign(params, settings.hashSecret);
    return { paymentUrl: `${baseUrl}/vnpay/paymentv2/vpcpay.html?${toSignedQuery(params)}`, params };
  }

  signWebhook(payload: Record<string, unknown>, secretKey: string): string {
    return hmacHex("sha512", secretKey, vnpaySignData(stringParams(payload)));
  }

  /** `status` is a vnp_ResponseCode such as `00` (success), `24` (cancelled) or `51` (insufficient funds). */
  dispatchWebhook(txnRef: string, status: string, source: WebhookSource = "trigger"): WebhookLog[] {
    const order = this.orders.get(txnRef);
    if (!order) throw new Error(`VNPay order '${txnRef}' not found`);
    if (order.status === "final") throw new Error(`VNPay order '${txnRef}' was already settled with ${order.responseCode}`);
    if (!RESPONSE_CODES[status]) {
      throw new Error(`Unsupported vnp_ResponseCode '${status}'. Use one of ${Object.keys(RESPONSE_CODES).join(", ")}.`);
    }

    order.status = "final";
    order.responseCode = status;
    order.payDate = vnTimestamp();
    order.transactionNo = status === "00" ? numericId(8) : "0";

    const payload = this.buildIpnParams(order, this.settings.hashSecret);
    return [
      this.ctx.dispatcher.enqueue({
        provider: "vnpay",
        type: "vnpay.ipn",
        eventId: order.txnRef,
        objectId: order.txnRef,
        summary: `vnp_ResponseCode ${status} · ${RESPONSE_CODES[status]}`,
        payload,
        source,
      }),
    ];
  }

  private buildIpnParams(order: VnpayOrder, hashSecret: string): Record<string, string> {
    const succeeded = order.responseCode === "00";
    const params: Record<string, string> = {
      vnp_Amount: String(order.amount * 100),
      vnp_BankCode: order.bankCode || "NCB",
      vnp_CardType: "ATM",
      vnp_OrderInfo: order.orderInfo,
      vnp_PayDate: order.payDate ?? vnTimestamp(),
      vnp_ResponseCode: order.responseCode ?? "99",
      vnp_TmnCode: this.settings.tmnCode,
      vnp_TransactionNo: order.transactionNo ?? "0",
      vnp_TransactionStatus: succeeded ? "00" : "02",
      vnp_TxnRef: order.txnRef,
    };
    if (succeeded) params.vnp_BankTranNo = `VNP${order.transactionNo ?? numericId(8)}`;
    params.vnp_SecureHash = hmacHex("sha512", hashSecret, vnpaySignData(params));
    return params;
  }

  buildWebhookRequest(log: WebhookLog): WebhookRequestSpec {
    const settings = this.settings;
    const query = toSignedQuery(stringParams(log.payload));
    const headers = { "user-agent": "VNPAY-IPN/2.1.0 (pay-sandbox)" };
    if (settings.ipnMethod === "POST") {
      return {
        method: "POST",
        url: settings.ipnUrl,
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: query,
      };
    }
    const separator = settings.ipnUrl.includes("?") ? "&" : "?";
    return { method: "GET", url: `${settings.ipnUrl}${separator}${query}`, headers };
  }

  evaluateResponse(statusCode: number, body: string): ResponseEvaluation {
    let rspCode: string | null = null;
    try {
      const parsed: unknown = JSON.parse(body);
      rspCode = isRecord(parsed) ? asString(parsed.RspCode) : null;
    } catch {
      rspCode = null;
    }
    if (statusCode !== 200 || rspCode === null) {
      return {
        ok: false,
        retryable: true,
        note: `VNPay expects HTTP 200 with {"RspCode": "00", "Message": "Confirm Success"}; got ${statusCode}${rspCode === null ? " without RspCode" : ""}.`,
      };
    }
    const meaning = RSP_CODES[rspCode] ?? "unknown RspCode";
    if (rspCode === "00") return { ok: true, retryable: false, note: null };
    if (rspCode === "02") return { ok: true, retryable: false, note: `RspCode 02: ${meaning}.` };
    return { ok: false, retryable: true, note: `RspCode ${rspCode}: ${meaning}. VNPay keeps retrying until 00 or 02.` };
  }

  prepareManualPayload(payload: Record<string, unknown>, mode: SignatureMode): DispatchInit {
    const params = stringParams(payload);
    delete params.vnp_SecureHash;
    delete params.vnp_SecureHashType;
    const key = mode === "valid" ? this.settings.hashSecret : tamperedKey(this.settings.hashSecret);
    params.vnp_SecureHash = hmacHex("sha512", key, vnpaySignData(params));
    const txnRef = params.vnp_TxnRef ?? null;
    return {
      provider: "vnpay",
      type: "vnpay.ipn",
      eventId: txnRef ?? generateId("vnp"),
      objectId: txnRef,
      summary: `vnp_ResponseCode ${params.vnp_ResponseCode ?? "?"} · edited${mode === "invalid" ? " · wrong hash" : ""}`,
      payload: params,
      source: "manual",
      signatureMode: mode,
    };
  }

  async registerRoutes(app: FastifyInstance): Promise<void> {
    app.get("/vnpay/paymentv2/vpcpay.html", async (request, reply) => {
      const query = (isRecord(request.query) ? request.query : {}) as Record<string, unknown>;
      try {
        this.createOrder(query);
      } catch (error) {
        if (!(error instanceof VnpayPageError)) throw error;
        return reply.status(400).type("text/html").send(this.renderErrorPage(error.message, query));
      }
      const order = this.orders.get(asString(query.vnp_TxnRef) ?? "");
      if (!order) return reply.status(500).type("text/plain").send("Order was not stored.");
      return reply.type("text/html").send(this.renderPage(order, null));
    });

    app.post<{ Params: { txnRef: string } }>("/vnpay/pay/:txnRef", async (request, reply) => {
      const order = this.orders.get(request.params.txnRef);
      if (!order) return reply.status(404).type("text/plain").send("VNPay order not found.");
      const status = asString((request.body as Record<string, unknown> | undefined)?.status) ?? "00";

      try {
        this.dispatchWebhook(order.txnRef, status, "checkout");
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return reply.status(409).type("text/html").send(this.renderPage(order, { tone: "error", text }));
      }

      const params = this.buildIpnParams(order, this.settings.hashSecret);
      const separator = order.returnUrl.includes("?") ? "&" : "?";
      return reply.redirect(`${order.returnUrl}${separator}${toSignedQuery(params)}`, 303);
    });

    app.post("/vnpay/create", async (request, reply) => {
      const body = (isRecord(request.body) ? request.body : {}) as Record<string, unknown>;
      const amount = asInteger(body.amount);
      if (amount === null || amount <= 0) {
        return reply.status(400).send({ error: "amount (VND, integer) is required" });
      }
      const optional = (key: string) => asString(body[key]) ?? undefined;
      const expireMinutes = asInteger(body.expireMinutes) ?? undefined;
      const result = this.buildPaymentUrl(`${request.protocol}://${request.host}`, {
        amount,
        orderInfo: optional("orderInfo") ?? "Thanh toan don hang",
        ...(optional("txnRef") ? { txnRef: optional("txnRef") } : {}),
        ...(optional("returnUrl") ? { returnUrl: optional("returnUrl") } : {}),
        ...(optional("bankCode") ? { bankCode: optional("bankCode") } : {}),
        ...(optional("locale") ? { locale: optional("locale") } : {}),
        ...(optional("orderType") ? { orderType: optional("orderType") } : {}),
        ...(optional("ipAddr") ? { ipAddr: optional("ipAddr") } : {}),
        ...(expireMinutes ? { expireMinutes } : {}),
      });
      return reply.send({ ...result, note: "Sandbox helper: real VNPay has no create API; build this URL in your backend." });
    });
  }

  private renderPage(order: VnpayOrder, notice: { tone: "info" | "error"; text: string } | null): string {
    const pending = order.status === "pending";
    return renderHostedPage({
      brand: "VNPAY",
      accent: "#005baa",
      title: "Cổng thanh toán VNPAY",
      amount: formatVnd(order.amount),
      reference: order.txnRef,
      description: order.orderInfo,
      actionUrl: `/vnpay/pay/${encodeURIComponent(order.txnRef)}`,
      notice: notice ?? (pending ? null : { tone: "info", text: `Giao dịch đã xử lý với vnp_ResponseCode ${order.responseCode}.` }),
      actions: pending
        ? [
            { label: "Thanh toán thành công", status: "00", tone: "primary", hint: "vnp_ResponseCode 00" },
            { label: "Khách hàng hủy giao dịch", status: "24", tone: "danger", hint: "vnp_ResponseCode 24" },
            { label: "Tài khoản không đủ số dư", status: "51", tone: "danger", hint: "vnp_ResponseCode 51" },
            { label: "Hết hạn chờ thanh toán", status: "11", tone: "neutral", hint: "vnp_ResponseCode 11" },
          ]
        : [],
    });
  }

  private renderErrorPage(reason: string, query: Record<string, unknown>): string {
    const amount = asInteger(query.vnp_Amount);
    return renderHostedPage({
      brand: "VNPAY",
      accent: "#005baa",
      title: "Thông báo lỗi",
      amount: amount ? formatVnd(amount / 100) : "—",
      reference: asString(query.vnp_TxnRef) ?? "(no vnp_TxnRef)",
      description: null,
      actionUrl: "#",
      notice: { tone: "error", text: reason },
      actions: [],
    });
  }

  describe(baseUrl: string): ProviderDescription {
    const settings = this.settings;
    return {
      name: this.name,
      displayName: this.displayName,
      settings: [
        { key: "tmnCode", label: "vnp_TmnCode", value: settings.tmnCode, kind: "text", editable: true },
        { key: "hashSecret", label: "vnp_HashSecret", value: settings.hashSecret, kind: "secret", editable: true },
        {
          key: "ipnUrl",
          label: "IPN URL",
          value: settings.ipnUrl,
          kind: "url",
          editable: true,
          hint: "Configured once in the VNPay merchant portal, not per payment.",
        },
        { key: "ipnMethod", label: "IPN method", value: settings.ipnMethod, kind: "select", editable: true, options: ["GET", "POST"] },
      ],
      endpoints: [
        { label: "vnp_Url", method: "GET", url: `${baseUrl}/vnpay/paymentv2/vpcpay.html` },
        { label: "URL helper", method: "POST", url: `${baseUrl}/vnpay/create` },
      ],
    };
  }

  updateSettings(patch: Record<string, unknown>): void {
    const settings = { ...this.settings };
    for (const key of ["tmnCode", "hashSecret"] as const) {
      const value = patch[key];
      if (typeof value === "string") {
        if (value.length === 0) throw new Error(`${key} must not be empty`);
        settings[key] = value;
      }
    }
    if (patch.ipnUrl !== undefined) settings.ipnUrl = parseHttpUrl(patch.ipnUrl, "ipnUrl");
    if (patch.ipnMethod !== undefined) {
      if (patch.ipnMethod !== "GET" && patch.ipnMethod !== "POST") throw new Error("ipnMethod must be GET or POST");
      settings.ipnMethod = patch.ipnMethod;
    }
    if (patch.defaultReturnUrl !== undefined) settings.defaultReturnUrl = parseHttpUrl(patch.defaultReturnUrl, "defaultReturnUrl");
    this.ctx.config.providers.vnpay = settings;
  }

  listOrders(): VnpayOrder[] {
    return [...this.orders.values()].reverse();
  }

  triggers(): TriggerDefinition[] {
    const make = (id: string, label: string, description: string, code: string): TriggerDefinition => ({
      id,
      provider: "vnpay",
      label,
      description,
      run: (baseUrl) => {
        const { params } = this.buildPaymentUrl(baseUrl, { amount: 250_000, orderInfo: "Thanh toan don hang pay-sandbox" });
        this.createOrder(params);
        const txnRef = params.vnp_TxnRef ?? "";
        this.dispatchWebhook(txnRef, code, "trigger");
        return { trigger: id, objects: { vnp_TxnRef: txnRef } };
      },
    });
    return [
      make("vnpay:success", "VNPay: Bắn IPN thành công (00)", "IPN vnp_ResponseCode 00 · 250.000 ₫", "00"),
      make("vnpay:cancelled", "VNPay: Khách hủy giao dịch (24)", "IPN vnp_ResponseCode 24", "24"),
    ];
  }

  reset(): void {
    this.orders.clear();
  }
}
