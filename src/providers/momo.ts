import type { FastifyInstance, FastifyReply } from "fastify";
import { type MomoConfig, type SandboxConfig, parseHttpUrl } from "../config.js";
import { generateId } from "../ids.js";
import type { SignatureMode, WebhookLog, WebhookSource } from "../types.js";
import type { WebhookDispatcher } from "../webhook/dispatcher.js";
import {
  appendQuery,
  asInteger,
  asString,
  formatVnd,
  hmacHex,
  numericId,
  renderHostedPage,
  signaturesMatch,
  tamperedKey,
} from "./shared.js";
import type {
  BaseProvider,
  DispatchInit,
  ProviderDescription,
  ResponseEvaluation,
  TriggerDefinition,
  WebhookRequestSpec,
} from "./types.js";

/**
 * MoMo result codes, from https://developers.momo.vn/v3/docs/payment/api/result-handling/resultcode
 * Messages are written for the sandbox; integrations should branch on `resultCode`, not on text.
 */
const RESULT_MESSAGES: Record<number, { vi: string; en: string }> = {
  0: { vi: "Thành công.", en: "Successful." },
  1000: {
    vi: "Giao dịch đã được khởi tạo, chờ người dùng xác nhận thanh toán.",
    en: "Transaction is initiated, waiting for user confirmation.",
  },
  1001: {
    vi: "Giao dịch thanh toán thất bại do tài khoản người dùng không đủ tiền.",
    en: "Transaction failed due to insufficient funds.",
  },
  1002: {
    vi: "Giao dịch bị từ chối bởi nhà phát hành phương thức thanh toán.",
    en: "Transaction rejected by the issuers of the payment methods.",
  },
  1004: {
    vi: "Giao dịch thất bại do số tiền vượt quá hạn mức thanh toán.",
    en: "Transaction failed because the amount exceeds daily /monthly payment limit.",
  },
  1005: {
    vi: "Giao dịch thất bại do url hoặc QR code đã hết hạn.",
    en: "Transaction failed because the url or QR code expired.",
  },
  1006: {
    vi: "Giao dịch thất bại do người dùng đã từ chối xác nhận thanh toán.",
    en: "Transaction failed because user has denied to confirm the payment.",
  },
  1007: {
    vi: "Giao dịch bị từ chối do tài khoản người dùng không hoạt động hoặc không tồn tại.",
    en: "Transaction rejected due to inactive or nonexistent user's account.",
  },
  11: { vi: "Truy cập bị từ chối.", en: "Access denied." },
  20: { vi: "Yêu cầu sai định dạng.", en: "Bad format request." },
  22: { vi: "Số tiền giao dịch không nằm trong khoảng cho phép.", en: "The transaction amount is out of range." },
  40: { vi: "RequestId bị trùng.", en: "Duplicated requestId." },
  41: { vi: "OrderId bị trùng.", en: "Duplicated orderId." },
  42: { vi: "OrderId không hợp lệ hoặc không được tìm thấy.", en: "Invalid orderId or orderId is not found." },
  99: { vi: "Lỗi không xác định.", en: "Unknown error." },
};

/** Final outcomes a sandbox order can be settled with. */
const SETTLEABLE_CODES = [0, 1001, 1002, 1004, 1005, 1006, 1007, 99];

const ORDER_ID_PATTERN = /^[0-9a-zA-Z]([-_.]*[0-9a-zA-Z]+)*$/;
const MIN_AMOUNT = 1_000;
const MAX_AMOUNT = 50_000_000;

type Lang = "vi" | "en";

export interface MomoOrder {
  partnerCode: string;
  orderId: string;
  requestId: string;
  amount: number;
  orderInfo: string;
  redirectUrl: string;
  ipnUrl: string;
  requestType: string;
  extraData: string;
  lang: Lang;
  resultCode: number;
  transId: number | null;
  payType: string | null;
  responseTime: number | null;
  createdAt: number;
}

export interface MomoIpnPayload extends Record<string, unknown> {
  partnerCode: string;
  orderId: string;
  requestId: string;
  amount: number;
  orderInfo: string;
  orderType: string;
  transId: number;
  resultCode: number;
  message: string;
  payType: string;
  responseTime: number;
  extraData: string;
  signature: string;
}

class MomoError extends Error {
  constructor(
    readonly resultCode: number,
    readonly detail: string,
  ) {
    super(detail);
  }
}

function message(code: number, lang: Lang): string {
  return RESULT_MESSAGES[code]?.[lang] ?? RESULT_MESSAGES[99]?.[lang] ?? "Unknown error.";
}

/** `key=value&…` over the given fields, in the given (alphabetical) order. */
function rawSignature(fields: Array<[string, unknown]>): string {
  return fields.map(([key, value]) => `${key}=${value ?? ""}`).join("&");
}

export function momoCreateRawSignature(accessKey: string, body: Record<string, unknown>): string {
  return rawSignature([
    ["accessKey", accessKey],
    ["amount", body.amount],
    ["extraData", body.extraData],
    ["ipnUrl", body.ipnUrl],
    ["orderId", body.orderId],
    ["orderInfo", body.orderInfo],
    ["partnerCode", body.partnerCode],
    ["redirectUrl", body.redirectUrl],
    ["requestId", body.requestId],
    ["requestType", body.requestType],
  ]);
}

export function momoIpnRawSignature(accessKey: string, payload: Record<string, unknown>): string {
  return rawSignature([
    ["accessKey", accessKey],
    ["amount", payload.amount],
    ["extraData", payload.extraData],
    ["message", payload.message],
    ["orderId", payload.orderId],
    ["orderInfo", payload.orderInfo],
    ["orderType", payload.orderType],
    ["partnerCode", payload.partnerCode],
    ["payType", payload.payType],
    ["requestId", payload.requestId],
    ["responseTime", payload.responseTime],
    ["resultCode", payload.resultCode],
    ["transId", payload.transId],
  ]);
}

export function momoQueryRawSignature(accessKey: string, body: Record<string, unknown>): string {
  return rawSignature([
    ["accessKey", accessKey],
    ["orderId", body.orderId],
    ["partnerCode", body.partnerCode],
    ["requestId", body.requestId],
  ]);
}

export interface MomoProviderContext {
  config: SandboxConfig;
  dispatcher: WebhookDispatcher;
}

/**
 * MoMo Payment Gateway (AIO v2) adapter.
 *
 * - `POST /momo/v2/gateway/api/create` validates the merchant's HMAC-SHA256
 *   signature and returns `payUrl`, `deeplink` and `qrCodeUrl`.
 * - `POST /momo/v2/gateway/api/query` returns the order's current state.
 * - `GET /momo/pay/:orderId` is the simulated wallet page; choosing an outcome
 *   sends the IPN (JSON POST to `ipnUrl`) and redirects to `redirectUrl`.
 * - The merchant must answer the IPN with HTTP 204 No Content.
 */
export class MomoProvider implements BaseProvider {
  readonly name = "momo" as const;
  readonly displayName = "MoMo";

  private readonly orders = new Map<string, MomoOrder>();
  private readonly requestIds = new Set<string>();

  constructor(private readonly ctx: MomoProviderContext) {}

  private get settings(): MomoConfig {
    return this.ctx.config.providers.momo;
  }

  createOrder(body: Record<string, unknown>, baseUrl: string): Record<string, unknown> {
    const settings = this.settings;
    const lang: Lang = body.lang === "en" ? "en" : "vi";

    const required = ["partnerCode", "requestId", "amount", "orderId", "orderInfo", "ipnUrl", "requestType", "signature"];
    for (const field of required) {
      if (body[field] === undefined || body[field] === null || body[field] === "") {
        throw new MomoError(20, `Missing required field: ${field}`);
      }
    }
    for (const field of ["redirectUrl", "extraData"]) {
      if (body[field] === undefined || body[field] === null) {
        throw new MomoError(20, `Missing required field: ${field} (send an empty string when unused)`);
      }
    }

    const partnerCode = asString(body.partnerCode) ?? "";
    if (partnerCode !== settings.partnerCode) {
      throw new MomoError(11, `Unknown partnerCode '${partnerCode}'. The sandbox partnerCode is '${settings.partnerCode}'.`);
    }

    const raw = momoCreateRawSignature(settings.accessKey, body);
    const expected = hmacHex("sha256", settings.secretKey, raw);
    if (!signaturesMatch(expected, body.signature)) {
      throw new MomoError(11, `Invalid signature. pay-sandbox signed this raw string with secretKey: ${raw}`);
    }

    const amount = asInteger(body.amount);
    if (amount === null) throw new MomoError(20, "amount must be an integer number of VND");
    if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
      throw new MomoError(22, `amount must be between ${MIN_AMOUNT} and ${MAX_AMOUNT} VND`);
    }

    const orderId = asString(body.orderId) ?? "";
    if (orderId.length > 200 || !ORDER_ID_PATTERN.test(orderId)) {
      throw new MomoError(20, "orderId must match ^[0-9a-zA-Z]([-_.]*[0-9a-zA-Z]+)*$ (max 200 chars)");
    }
    if (this.orders.has(orderId)) throw new MomoError(41, `orderId '${orderId}' was already used`);

    const requestId = asString(body.requestId) ?? "";
    if (this.requestIds.has(requestId)) throw new MomoError(40, `requestId '${requestId}' was already used`);

    let ipnUrl: string;
    try {
      ipnUrl = parseHttpUrl(body.ipnUrl, "ipnUrl");
    } catch (error) {
      throw new MomoError(20, error instanceof Error ? error.message : "ipnUrl is invalid");
    }

    const order: MomoOrder = {
      partnerCode,
      orderId,
      requestId,
      amount,
      orderInfo: asString(body.orderInfo) ?? "",
      redirectUrl: asString(body.redirectUrl) ?? "",
      ipnUrl,
      requestType: asString(body.requestType) ?? "captureWallet",
      extraData: asString(body.extraData) ?? "",
      lang,
      resultCode: 1000,
      transId: null,
      payType: null,
      responseTime: null,
      createdAt: Date.now(),
    };
    this.orders.set(orderId, order);
    this.requestIds.add(requestId);

    const payUrl = `${baseUrl}/momo/pay/${encodeURIComponent(orderId)}`;
    const responseTime = Date.now();
    const resultMessage = message(0, lang);
    return {
      partnerCode,
      orderId,
      requestId,
      amount,
      responseTime,
      message: resultMessage,
      resultCode: 0,
      payUrl,
      deeplink: `momo://app?action=payWithApp&isScanQR=false&serviceType=app&sid=${generateId("TU9NTw", 24)}&v=3.0`,
      qrCodeUrl: `${payUrl}?scan=qr`,
      deeplinkMiniApp: `${payUrl}?scan=miniapp`,
      signature: hmacHex(
        "sha256",
        settings.secretKey,
        rawSignature([
          ["accessKey", settings.accessKey],
          ["amount", amount],
          ["message", resultMessage],
          ["orderId", orderId],
          ["partnerCode", partnerCode],
          ["payUrl", payUrl],
          ["requestId", requestId],
          ["responseTime", responseTime],
          ["resultCode", 0],
        ]),
      ),
      userFee: 0,
    };
  }

  queryOrder(body: Record<string, unknown>): Record<string, unknown> {
    const settings = this.settings;
    const lang: Lang = body.lang === "en" ? "en" : "vi";
    for (const field of ["partnerCode", "requestId", "orderId", "signature"]) {
      if (body[field] === undefined || body[field] === "") throw new MomoError(20, `Missing required field: ${field}`);
    }
    if (body.partnerCode !== settings.partnerCode) throw new MomoError(11, "Unknown partnerCode");

    const raw = momoQueryRawSignature(settings.accessKey, body);
    if (!signaturesMatch(hmacHex("sha256", settings.secretKey, raw), body.signature)) {
      throw new MomoError(11, `Invalid signature. pay-sandbox signed this raw string with secretKey: ${raw}`);
    }

    const order = this.orders.get(asString(body.orderId) ?? "");
    if (!order) throw new MomoError(42, `orderId '${String(body.orderId)}' not found`);

    return {
      partnerCode: order.partnerCode,
      orderId: order.orderId,
      requestId: asString(body.requestId),
      extraData: order.extraData,
      amount: order.amount,
      transId: order.transId ?? 0,
      payType: order.payType ?? "",
      resultCode: order.resultCode,
      refundTrans: [],
      message: message(order.resultCode, lang),
      responseTime: Date.now(),
      paymentOption: "momo",
      promotionInfo: null,
    };
  }

  signWebhook(payload: Record<string, unknown>, secretKey: string): string {
    return hmacHex("sha256", secretKey, momoIpnRawSignature(this.settings.accessKey, payload));
  }

  /** `status` is a MoMo resultCode such as `0`, `1005` or `1006`. */
  dispatchWebhook(orderId: string, status: string, source: WebhookSource = "trigger"): WebhookLog[] {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`MoMo order '${orderId}' not found`);
    if (order.resultCode !== 1000) {
      throw new Error(`MoMo order '${orderId}' is already final with resultCode ${order.resultCode}`);
    }

    const resultCode = Number(status);
    if (!SETTLEABLE_CODES.includes(resultCode)) {
      throw new Error(`Unsupported MoMo resultCode '${status}'. Use one of ${SETTLEABLE_CODES.join(", ")}.`);
    }

    order.resultCode = resultCode;
    order.transId = Number(numericId(10));
    order.payType = "qr";
    order.responseTime = Date.now();

    const payload = this.buildIpnPayload(order, this.settings.secretKey);
    return [
      this.ctx.dispatcher.enqueue({
        provider: "momo",
        type: "momo.ipn",
        eventId: order.orderId,
        objectId: order.orderId,
        summary: `resultCode ${resultCode} · ${payload.message}`,
        payload,
        source,
      }),
    ];
  }

  private buildIpnPayload(order: MomoOrder, secretKey: string): MomoIpnPayload {
    const unsigned = {
      partnerCode: order.partnerCode,
      orderId: order.orderId,
      requestId: order.requestId,
      amount: order.amount,
      orderInfo: order.orderInfo,
      orderType: "momo_wallet",
      transId: order.transId ?? 0,
      resultCode: order.resultCode,
      message: message(order.resultCode, order.lang),
      payType: order.payType ?? "qr",
      responseTime: order.responseTime ?? Date.now(),
      extraData: order.extraData,
    };
    return { ...unsigned, signature: this.signWebhook(unsigned, secretKey) };
  }

  buildWebhookRequest(log: WebhookLog): WebhookRequestSpec {
    const order = log.objectId ? this.orders.get(log.objectId) : undefined;
    return {
      method: "POST",
      url: order?.ipnUrl ?? this.settings.defaultIpnUrl,
      headers: { "content-type": "application/json; charset=utf-8", "user-agent": "MoMo-IPN/2.0 (pay-sandbox)" },
      body: JSON.stringify(log.payload),
    };
  }

  evaluateResponse(statusCode: number): ResponseEvaluation {
    if (statusCode === 204) return { ok: true, retryable: false, note: null };
    if (statusCode >= 200 && statusCode < 300) {
      return { ok: true, retryable: false, note: `MoMo expects HTTP 204 No Content; your endpoint answered ${statusCode}.` };
    }
    return { ok: false, retryable: true, note: `MoMo expects HTTP 204 No Content within 15s; got ${statusCode}.` };
  }

  prepareManualPayload(payload: Record<string, unknown>, mode: SignatureMode): DispatchInit {
    const { signature: _ignored, ...fields } = payload;
    const key = mode === "valid" ? this.settings.secretKey : tamperedKey(this.settings.secretKey);
    const signed = { ...fields, signature: this.signWebhook(fields, key) };
    const orderId = asString(fields.orderId);
    return {
      provider: "momo",
      type: "momo.ipn",
      eventId: orderId ?? generateId("momo"),
      objectId: orderId,
      summary: `resultCode ${String(fields.resultCode ?? "?")} · edited${mode === "invalid" ? " · wrong signature" : ""}`,
      payload: signed,
      source: "manual",
      signatureMode: mode,
    };
  }

  async registerRoutes(app: FastifyInstance): Promise<void> {
    const sendError = (reply: FastifyReply, error: unknown, body: Record<string, unknown>) => {
      if (!(error instanceof MomoError)) throw error;
      const lang: Lang = body.lang === "en" ? "en" : "vi";
      return reply.status(400).send({
        partnerCode: asString(body.partnerCode),
        orderId: asString(body.orderId),
        requestId: asString(body.requestId),
        amount: asInteger(body.amount),
        responseTime: Date.now(),
        message: `${message(error.resultCode, lang)} (${error.detail})`,
        resultCode: error.resultCode,
      });
    };

    app.post("/momo/v2/gateway/api/create", async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        return reply.send(this.createOrder(body, `${request.protocol}://${request.host}`));
      } catch (error) {
        return sendError(reply, error, body);
      }
    });

    app.post("/momo/v2/gateway/api/query", async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        return reply.send(this.queryOrder(body));
      } catch (error) {
        return sendError(reply, error, body);
      }
    });

    app.get<{ Params: { orderId: string } }>("/momo/pay/:orderId", async (request, reply) => {
      const order = this.orders.get(request.params.orderId);
      if (!order) return reply.status(404).type("text/plain").send("MoMo order not found.");
      return reply.type("text/html").send(this.renderPage(order, null));
    });

    app.post<{ Params: { orderId: string } }>("/momo/pay/:orderId", async (request, reply) => {
      const order = this.orders.get(request.params.orderId);
      if (!order) return reply.status(404).type("text/plain").send("MoMo order not found.");
      const status = asString((request.body as Record<string, unknown> | undefined)?.status) ?? "0";

      try {
        this.dispatchWebhook(order.orderId, status, "checkout");
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return reply.status(409).type("text/html").send(this.renderPage(order, { tone: "error", text }));
      }

      if (!order.redirectUrl) {
        return reply.type("text/html").send(
          this.renderPage(order, { tone: "info", text: `IPN sent with resultCode ${order.resultCode}. No redirectUrl was set.` }),
        );
      }
      const ipn = this.buildIpnPayload(order, this.settings.secretKey);
      const query = Object.fromEntries(Object.entries(ipn).map(([key, value]) => [key, String(value)]));
      return reply.redirect(appendQuery(order.redirectUrl, query), 303);
    });
  }

  private renderPage(order: MomoOrder, notice: { tone: "info" | "error"; text: string } | null): string {
    const pending = order.resultCode === 1000;
    return renderHostedPage({
      brand: "MoMo",
      accent: "#a50064",
      title: "Thanh toán qua Ví MoMo",
      amount: formatVnd(order.amount),
      reference: order.orderId,
      description: order.orderInfo,
      actionUrl: `/momo/pay/${encodeURIComponent(order.orderId)}`,
      notice: notice ?? (pending ? null : { tone: "info", text: `Giao dịch đã kết thúc với resultCode ${order.resultCode}.` }),
      actions: pending
        ? [
            { label: "Thanh toán thành công", status: "0", tone: "primary", hint: "resultCode 0" },
            { label: "Hết hạn giao dịch", status: "1005", tone: "danger", hint: "resultCode 1005" },
            { label: "Người dùng từ chối", status: "1006", tone: "danger", hint: "resultCode 1006" },
            { label: "Không đủ số dư", status: "1001", tone: "neutral", hint: "resultCode 1001" },
          ]
        : [],
    });
  }

  describe(baseUrl: string): ProviderDescription {
    const settings = this.settings;
    return {
      name: this.name,
      displayName: this.displayName,
      settings: [
        { key: "partnerCode", label: "partnerCode", value: settings.partnerCode, kind: "text", editable: true },
        { key: "accessKey", label: "accessKey", value: settings.accessKey, kind: "secret", editable: true },
        { key: "secretKey", label: "secretKey", value: settings.secretKey, kind: "secret", editable: true },
        {
          key: "defaultIpnUrl",
          label: "Trigger ipnUrl",
          value: settings.defaultIpnUrl,
          kind: "url",
          editable: true,
          hint: "Used by Quick Triggers. Real create requests carry their own ipnUrl.",
        },
      ],
      endpoints: [
        { label: "Create", method: "POST", url: `${baseUrl}/momo/v2/gateway/api/create` },
        { label: "Query", method: "POST", url: `${baseUrl}/momo/v2/gateway/api/query` },
      ],
    };
  }

  updateSettings(patch: Record<string, unknown>): void {
    const settings = { ...this.settings };
    for (const key of ["partnerCode", "accessKey", "secretKey"] as const) {
      const value = patch[key];
      if (typeof value === "string") {
        if (value.length === 0) throw new Error(`${key} must not be empty`);
        settings[key] = value;
      }
    }
    if (patch.defaultIpnUrl !== undefined) settings.defaultIpnUrl = parseHttpUrl(patch.defaultIpnUrl, "defaultIpnUrl");
    if (patch.defaultRedirectUrl !== undefined) {
      settings.defaultRedirectUrl = parseHttpUrl(patch.defaultRedirectUrl, "defaultRedirectUrl");
    }
    this.ctx.config.providers.momo = settings;
  }

  listOrders(): MomoOrder[] {
    return [...this.orders.values()].reverse();
  }

  /** Builds and signs a create request the way a merchant backend would. */
  private createSignedOrder(baseUrl: string, amount: number, orderInfo: string): MomoOrder {
    const settings = this.settings;
    const orderId = `SBX${Date.now()}${numericId(4)}`;
    const body: Record<string, unknown> = {
      partnerCode: settings.partnerCode,
      requestId: orderId,
      amount,
      orderId,
      orderInfo,
      redirectUrl: settings.defaultRedirectUrl,
      ipnUrl: settings.defaultIpnUrl,
      requestType: "captureWallet",
      extraData: "",
      lang: "vi",
    };
    body.signature = hmacHex("sha256", settings.secretKey, momoCreateRawSignature(settings.accessKey, body));
    this.createOrder(body, baseUrl);
    const order = this.orders.get(orderId);
    if (!order) throw new Error("Failed to create MoMo trigger order");
    return order;
  }

  triggers(): TriggerDefinition[] {
    const make = (id: string, label: string, description: string, code: number): TriggerDefinition => ({
      id,
      provider: "momo",
      label,
      description,
      run: (baseUrl) => {
        const order = this.createSignedOrder(baseUrl, 150_000, "Thanh toan don hang pay-sandbox");
        this.dispatchWebhook(order.orderId, String(code), "trigger");
        return { trigger: id, objects: { orderId: order.orderId, requestId: order.requestId } };
      },
    });
    return [
      make("momo:success", "MoMo: Thanh toán thành công (code 0)", "IPN resultCode 0 · 150.000 ₫", 0),
      make("momo:expired", "MoMo: Hết hạn giao dịch (code 1005)", "IPN resultCode 1005 · URL/QR đã hết hạn", 1005),
      make("momo:user_denied", "MoMo: Người dùng từ chối (code 1006)", "IPN resultCode 1006 · từ chối xác nhận", 1006),
    ];
  }

  reset(): void {
    this.orders.clear();
    this.requestIds.clear();
  }
}
