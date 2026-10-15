import type { FastifyInstance } from "fastify";
import { type SandboxConfig, type ZaloPayConfig, parseHttpUrl } from "../config.js";
import { generateId } from "../ids.js";
import type { SignatureMode, WebhookLog, WebhookSource } from "../types.js";
import type { WebhookDispatcher } from "../webhook/dispatcher.js";
import {
  appendQuery,
  asInteger,
  asString,
  formatVnd,
  hmacHex,
  isRecord,
  numericId,
  renderHostedPage,
  signaturesMatch,
  tamperedKey,
  vnDatePrefix,
} from "./shared.js";
import type {
  BaseProvider,
  DispatchInit,
  ProviderDescription,
  ResponseEvaluation,
  TriggerDefinition,
  WebhookRequestSpec,
} from "./types.js";

/** Payment channel reported for sandbox payments (ZaloPay wallet). */
const CHANNEL_ZALOPAY_WALLET = 38;

/** sub_return_code values from https://docs.zalopay.vn/docs/developer-tools/knowledge-base/status-codes */
const SUB_CODES = {
  illegalData: { code: -401, message: "ILLEGAL_DATA_REQUEST" },
  illegalSignature: { code: -402, message: "ILLEGAL_APP/SIGNATURE_REQUEST" },
  duplicateTransId: { code: -68, message: "DUPLICATE_APPS_TRANS_ID" },
  orderNotExist: { code: -101, message: "ORDER_NOT_EXIST" },
} as const;

type OrderStatus = "pending" | "paid" | "failed";

export interface ZaloPayOrder {
  app_id: number;
  app_trans_id: string;
  app_user: string;
  app_time: number;
  amount: number;
  item: string;
  embed_data: string;
  description: string;
  bank_code: string;
  callback_url: string;
  redirect_url: string | null;
  zp_trans_token: string;
  order_token: string;
  status: OrderStatus;
  zp_trans_id: number | null;
  server_time: number | null;
  createdAt: number;
}

export interface ZaloPayCallbackPayload extends Record<string, unknown> {
  data: string;
  mac: string;
  type: number;
}

class ZaloPayError extends Error {
  constructor(
    readonly sub: { code: number; message: string },
    readonly detail: string,
  ) {
    super(detail);
  }
}

/** HMAC input for `POST /v2/create`, signed with key1. */
export function zaloPayCreateMacInput(body: Record<string, unknown>): string {
  return [body.app_id, body.app_trans_id, body.app_user, body.amount, body.app_time, body.embed_data, body.item]
    .map((value) => asString(value) ?? "")
    .join("|");
}

/** HMAC input for the browser redirect checksum, signed with key2. */
export function zaloPayRedirectChecksumInput(params: Record<string, string>): string {
  return [params.appid, params.apptransid, params.pmcid, params.bankcode, params.amount, params.discountamount, params.status]
    .map((value) => value ?? "")
    .join("|");
}

export interface ZaloPayProviderContext {
  config: SandboxConfig;
  dispatcher: WebhookDispatcher;
}

/**
 * ZaloPay (API v2) adapter.
 *
 * - `POST /zalopay/v2/create` validates `mac = HMAC_SHA256(key1, app_id|app_trans_id|app_user|amount|app_time|embed_data|item)`
 *   and returns `order_url` and `zp_trans_token`.
 * - `POST /zalopay/v2/query` validates `mac = HMAC_SHA256(key1, app_id|app_trans_id|key1)`.
 * - Callbacks are `POST {"data": "<json>", "mac": HMAC_SHA256(key2, data), "type": 1}` and are only
 *   sent for successful payments, like the real gateway.
 * - The merchant answers `{"return_code": 1}` to acknowledge; `0` asks ZaloPay to call back again.
 */
export class ZaloPayProvider implements BaseProvider {
  readonly name = "zalopay" as const;
  readonly displayName = "ZaloPay";

  private readonly orders = new Map<string, ZaloPayOrder>();

  constructor(private readonly ctx: ZaloPayProviderContext) {}

  private get settings(): ZaloPayConfig {
    return this.ctx.config.providers.zalopay;
  }

  createOrder(body: Record<string, unknown>, baseUrl: string): Record<string, unknown> {
    const settings = this.settings;

    for (const field of ["app_id", "app_user", "app_trans_id", "app_time", "amount", "item", "embed_data", "description", "mac"]) {
      if (body[field] === undefined || body[field] === null || body[field] === "") {
        throw new ZaloPayError(SUB_CODES.illegalData, `Missing required field: ${field}`);
      }
    }

    const appId = asInteger(body.app_id);
    if (appId !== settings.appId) {
      throw new ZaloPayError(SUB_CODES.illegalSignature, `Unknown app_id '${String(body.app_id)}'. The sandbox app_id is ${settings.appId}.`);
    }

    const macInput = zaloPayCreateMacInput(body);
    if (!signaturesMatch(hmacHex("sha256", settings.key1, macInput), body.mac)) {
      throw new ZaloPayError(SUB_CODES.illegalSignature, `Invalid mac. pay-sandbox signed this string with key1: ${macInput}`);
    }

    const appTransId = asString(body.app_trans_id) ?? "";
    const today = vnDatePrefix();
    if (!/^\d{6}_[A-Za-z0-9_-]{1,34}$/.test(appTransId)) {
      throw new ZaloPayError(SUB_CODES.illegalData, "app_trans_id must look like yyMMdd_xxxx (max 40 chars)");
    }
    if (!appTransId.startsWith(`${today}_`)) {
      throw new ZaloPayError(SUB_CODES.illegalData, `app_trans_id must start with today's date in GMT+7 (${today}_)`);
    }
    if (this.orders.has(appTransId)) {
      throw new ZaloPayError(SUB_CODES.duplicateTransId, `app_trans_id '${appTransId}' was already used`);
    }

    const amount = asInteger(body.amount);
    if (amount === null || amount <= 0) throw new ZaloPayError(SUB_CODES.illegalData, "amount must be a positive integer (VND)");
    const appTime = asInteger(body.app_time);
    if (appTime === null) throw new ZaloPayError(SUB_CODES.illegalData, "app_time must be a Unix timestamp in milliseconds");

    const item = asString(body.item) ?? "[]";
    const embedData = asString(body.embed_data) ?? "{}";
    let embed: unknown;
    try {
      if (!Array.isArray(JSON.parse(item))) throw new Error("not an array");
      embed = JSON.parse(embedData);
      if (!isRecord(embed)) throw new Error("not an object");
    } catch {
      throw new ZaloPayError(SUB_CODES.illegalData, "item must be a JSON array string and embed_data a JSON object string");
    }

    let callbackUrl = settings.defaultCallbackUrl;
    if (body.callback_url !== undefined && body.callback_url !== "") {
      try {
        callbackUrl = parseHttpUrl(body.callback_url, "callback_url");
      } catch (error) {
        throw new ZaloPayError(SUB_CODES.illegalData, error instanceof Error ? error.message : "callback_url is invalid");
      }
    }

    const token = generateId("zpt", 24).slice(4);
    const order: ZaloPayOrder = {
      app_id: appId,
      app_trans_id: appTransId,
      app_user: asString(body.app_user) ?? "",
      app_time: appTime,
      amount,
      item,
      embed_data: embedData,
      description: asString(body.description) ?? "",
      bank_code: asString(body.bank_code) ?? "",
      callback_url: callbackUrl,
      redirect_url: typeof embed.redirecturl === "string" && embed.redirecturl ? embed.redirecturl : null,
      zp_trans_token: token,
      order_token: token,
      status: "pending",
      zp_trans_id: null,
      server_time: null,
      createdAt: Date.now(),
    };
    this.orders.set(appTransId, order);

    const orderUrl = `${baseUrl}/zalopay/pay/${encodeURIComponent(appTransId)}`;
    return {
      return_code: 1,
      return_message: "Giao dịch thành công",
      sub_return_code: 1,
      sub_return_message: "Giao dịch thành công",
      zp_trans_token: token,
      order_url: orderUrl,
      order_token: token,
      qr_code: orderUrl,
    };
  }

  queryOrder(body: Record<string, unknown>): Record<string, unknown> {
    const settings = this.settings;
    const appTransId = asString(body.app_trans_id) ?? "";
    const macInput = `${asString(body.app_id) ?? ""}|${appTransId}|${settings.key1}`;
    if (asInteger(body.app_id) !== settings.appId || !signaturesMatch(hmacHex("sha256", settings.key1, macInput), body.mac)) {
      throw new ZaloPayError(
        SUB_CODES.illegalSignature,
        `Invalid app_id or mac. pay-sandbox signed this string with key1: ${macInput.replace(settings.key1, "<key1>")}`,
      );
    }

    const order = this.orders.get(appTransId);
    if (!order) throw new ZaloPayError(SUB_CODES.orderNotExist, `app_trans_id '${appTransId}' does not exist`);

    const returnCode = order.status === "paid" ? 1 : order.status === "failed" ? 2 : 3;
    const messages = { 1: "Giao dịch thành công", 2: "Giao dịch thất bại", 3: "Giao dịch đang xử lý" } as const;
    return {
      return_code: returnCode,
      return_message: messages[returnCode],
      sub_return_code: returnCode,
      sub_return_message: messages[returnCode],
      is_processing: false,
      amount: order.status === "paid" ? order.amount : 0,
      zp_trans_id: order.zp_trans_id ?? 0,
      server_time: order.server_time ?? Date.now(),
      discount_amount: 0,
    };
  }

  signWebhook(payload: Record<string, unknown>, secretKey: string): string {
    return hmacHex("sha256", secretKey, asString(payload.data) ?? "");
  }

  /**
   * `status` is `success` (sends the callback) or `failed` (marks the order failed; ZaloPay sends no
   * callback for failed payments, so merchants must find out through the query API).
   */
  dispatchWebhook(appTransId: string, status: string, source: WebhookSource = "trigger"): WebhookLog[] {
    const order = this.orders.get(appTransId);
    if (!order) throw new Error(`ZaloPay order '${appTransId}' not found`);
    if (order.status !== "pending") throw new Error(`ZaloPay order '${appTransId}' is already ${order.status}`);

    const succeeded = status === "success" || status === "1";
    if (!succeeded && status !== "failed" && status !== "2") {
      throw new Error(`Unsupported ZaloPay status '${status}'. Use 'success' or 'failed'.`);
    }

    order.server_time = Date.now();
    if (!succeeded) {
      order.status = "failed";
      return [];
    }

    order.status = "paid";
    order.zp_trans_id = Number(`${vnDatePrefix()}${numericId(9)}`);
    const payload = this.buildCallbackPayload(order, this.settings.key2);
    return [
      this.ctx.dispatcher.enqueue({
        provider: "zalopay",
        type: "zalopay.callback",
        eventId: order.app_trans_id,
        objectId: order.app_trans_id,
        summary: `Paid ${formatVnd(order.amount)} · zp_trans_id ${order.zp_trans_id}`,
        payload,
        source,
      }),
    ];
  }

  private buildCallbackPayload(order: ZaloPayOrder, key2: string): ZaloPayCallbackPayload {
    const data = JSON.stringify({
      app_id: order.app_id,
      app_trans_id: order.app_trans_id,
      app_time: order.app_time,
      app_user: order.app_user,
      amount: order.amount,
      embed_data: order.embed_data,
      item: order.item,
      zp_trans_id: order.zp_trans_id,
      server_time: order.server_time,
      channel: CHANNEL_ZALOPAY_WALLET,
      merchant_user_id: `sbx_${order.app_user}`,
      user_fee_amount: 0,
      discount_amount: 0,
    });
    return { data, mac: hmacHex("sha256", key2, data), type: 1 };
  }

  private redirectParams(order: ZaloPayOrder): Record<string, string> {
    const params: Record<string, string> = {
      appid: String(order.app_id),
      apptransid: order.app_trans_id,
      pmcid: String(CHANNEL_ZALOPAY_WALLET),
      bankcode: order.bank_code,
      amount: String(order.amount),
      discountamount: "0",
      status: order.status === "paid" ? "1" : "2",
    };
    params.checksum = hmacHex("sha256", this.settings.key2, zaloPayRedirectChecksumInput(params));
    return params;
  }

  buildWebhookRequest(log: WebhookLog): WebhookRequestSpec {
    const order = log.objectId ? this.orders.get(log.objectId) : undefined;
    return {
      method: "POST",
      url: order?.callback_url ?? this.settings.defaultCallbackUrl,
      headers: { "content-type": "application/json; charset=utf-8", "user-agent": "ZaloPay-Callback/2.0 (pay-sandbox)" },
      body: JSON.stringify(log.payload),
    };
  }

  evaluateResponse(statusCode: number, body: string): ResponseEvaluation {
    if (statusCode !== 200) {
      return { ok: false, retryable: true, note: `ZaloPay expects HTTP 200 with {"return_code": 1}; got ${statusCode}.` };
    }
    let returnCode: unknown;
    try {
      const parsed: unknown = JSON.parse(body);
      returnCode = isRecord(parsed) ? parsed.return_code : undefined;
    } catch {
      return { ok: false, retryable: true, note: 'Response is not JSON. Answer {"return_code": 1, "return_message": "success"}.' };
    }
    const code = asInteger(returnCode);
    if (code === 1) return { ok: true, retryable: false, note: null };
    if (code === 0) return { ok: false, retryable: true, note: "return_code 0: ZaloPay will call back again." };
    if (code === null) return { ok: false, retryable: true, note: "Response JSON has no numeric return_code." };
    return { ok: false, retryable: false, note: `return_code ${code}: merchant rejected the callback (e.g. mac mismatch); no retry.` };
  }

  prepareManualPayload(payload: Record<string, unknown>, mode: SignatureMode): DispatchInit {
    const data = typeof payload.data === "string" ? payload.data : JSON.stringify(payload.data ?? {});
    const key = mode === "valid" ? this.settings.key2 : tamperedKey(this.settings.key2);
    let appTransId: string | null = null;
    try {
      const parsed: unknown = JSON.parse(data);
      if (isRecord(parsed)) appTransId = asString(parsed.app_trans_id);
    } catch {
      appTransId = null;
    }
    return {
      provider: "zalopay",
      type: "zalopay.callback",
      eventId: appTransId ?? generateId("zp"),
      objectId: appTransId,
      summary: `edited callback${mode === "invalid" ? " · wrong mac" : ""}`,
      payload: { data, mac: hmacHex("sha256", key, data), type: asInteger(payload.type) ?? 1 },
      source: "manual",
      signatureMode: mode,
    };
  }

  async registerRoutes(app: FastifyInstance): Promise<void> {
    const handle = (action: (body: Record<string, unknown>) => Record<string, unknown>) =>
      async (request: { body: unknown }) => {
        const body = (isRecord(request.body) ? request.body : {}) as Record<string, unknown>;
        try {
          return action(body);
        } catch (error) {
          if (!(error instanceof ZaloPayError)) throw error;
          return {
            return_code: 2,
            return_message: "Giao dịch thất bại",
            sub_return_code: error.sub.code,
            sub_return_message: `${error.sub.message}: ${error.detail}`,
          };
        }
      };

    app.post("/zalopay/v2/create", async (request) =>
      handle((body) => this.createOrder(body, `${request.protocol}://${request.host}`))(request),
    );
    app.post("/zalopay/v2/query", handle((body) => this.queryOrder(body)));

    app.get<{ Params: { appTransId: string } }>("/zalopay/pay/:appTransId", async (request, reply) => {
      const order = this.orders.get(request.params.appTransId);
      if (!order) return reply.status(404).type("text/plain").send("ZaloPay order not found.");
      return reply.type("text/html").send(this.renderPage(order, null));
    });

    app.post<{ Params: { appTransId: string } }>("/zalopay/pay/:appTransId", async (request, reply) => {
      const order = this.orders.get(request.params.appTransId);
      if (!order) return reply.status(404).type("text/plain").send("ZaloPay order not found.");
      const status = asString((request.body as Record<string, unknown> | undefined)?.status) ?? "success";

      try {
        this.dispatchWebhook(order.app_trans_id, status, "checkout");
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return reply.status(409).type("text/html").send(this.renderPage(order, { tone: "error", text }));
      }

      const redirectUrl = order.redirect_url ?? this.settings.defaultRedirectUrl;
      return reply.redirect(appendQuery(redirectUrl, this.redirectParams(order)), 303);
    });
  }

  private renderPage(order: ZaloPayOrder, notice: { tone: "info" | "error"; text: string } | null): string {
    const pending = order.status === "pending";
    return renderHostedPage({
      brand: "ZaloPay",
      accent: "#0068ff",
      title: "Thanh toán đơn hàng",
      amount: formatVnd(order.amount),
      reference: order.app_trans_id,
      description: order.description,
      actionUrl: `/zalopay/pay/${encodeURIComponent(order.app_trans_id)}`,
      notice: notice ?? (pending ? null : { tone: "info", text: `Đơn hàng đã ở trạng thái ${order.status}.` }),
      actions: pending
        ? [
            { label: "Thanh toán thành công", status: "success", tone: "primary", hint: "callback + redirect status=1" },
            { label: "Thanh toán thất bại", status: "failed", tone: "danger", hint: "no callback" },
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
        { key: "appId", label: "app_id", value: String(settings.appId), kind: "text", editable: true },
        { key: "key1", label: "key1", value: settings.key1, kind: "secret", editable: true },
        { key: "key2", label: "key2", value: settings.key2, kind: "secret", editable: true },
        {
          key: "defaultCallbackUrl",
          label: "Default callback_url",
          value: settings.defaultCallbackUrl,
          kind: "url",
          editable: true,
          hint: "Used when a create request has no callback_url, and by Quick Triggers.",
        },
      ],
      endpoints: [
        { label: "Create", method: "POST", url: `${baseUrl}/zalopay/v2/create` },
        { label: "Query", method: "POST", url: `${baseUrl}/zalopay/v2/query` },
      ],
    };
  }

  updateSettings(patch: Record<string, unknown>): void {
    const settings = { ...this.settings };
    if (patch.appId !== undefined) {
      const appId = asInteger(patch.appId);
      if (appId === null || appId <= 0) throw new Error("appId must be a positive integer");
      settings.appId = appId;
    }
    for (const key of ["key1", "key2"] as const) {
      const value = patch[key];
      if (typeof value === "string") {
        if (value.length === 0) throw new Error(`${key} must not be empty`);
        settings[key] = value;
      }
    }
    if (patch.defaultCallbackUrl !== undefined) {
      settings.defaultCallbackUrl = parseHttpUrl(patch.defaultCallbackUrl, "defaultCallbackUrl");
    }
    if (patch.defaultRedirectUrl !== undefined) {
      settings.defaultRedirectUrl = parseHttpUrl(patch.defaultRedirectUrl, "defaultRedirectUrl");
    }
    this.ctx.config.providers.zalopay = settings;
  }

  listOrders(): ZaloPayOrder[] {
    return [...this.orders.values()].reverse();
  }

  triggers(): TriggerDefinition[] {
    return [
      {
        id: "zalopay:callback",
        provider: "zalopay",
        label: "ZaloPay: Bắn Callback",
        description: "Callback thanh toán thành công · 120.000 ₫",
        run: (baseUrl) => {
          const settings = this.settings;
          const body: Record<string, unknown> = {
            app_id: settings.appId,
            app_user: "pay_sandbox_user",
            app_trans_id: `${vnDatePrefix()}_${numericId(8)}`,
            app_time: Date.now(),
            amount: 120_000,
            item: JSON.stringify([{ itemid: "sku-1", itemname: "Sandbox item", itemprice: 120_000, itemquantity: 1 }]),
            embed_data: JSON.stringify({ redirecturl: settings.defaultRedirectUrl }),
            description: "pay-sandbox - Thanh toan don hang",
            bank_code: "",
          };
          body.mac = hmacHex("sha256", settings.key1, zaloPayCreateMacInput(body));
          this.createOrder(body, baseUrl);
          const appTransId = String(body.app_trans_id);
          this.dispatchWebhook(appTransId, "success", "trigger");
          return { trigger: "zalopay:callback", objects: { app_trans_id: appTransId } };
        },
      },
    ];
  }

  reset(): void {
    this.orders.clear();
  }
}
