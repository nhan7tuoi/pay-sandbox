/**
 * End-to-end check of the MoMo, ZaloPay and VNPay adapters from a merchant's
 * point of view. Every signature is produced and verified with code written
 * here from the gateways' public documentation; nothing is imported from the
 * sandbox, so a signing bug in pay-sandbox makes these checks fail.
 *
 *   Terminal 1:  npm run dev:server
 *   Terminal 2:  npm run test:gateways
 */
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import qs from "qs";

const SANDBOX = `http://localhost:${process.env.PAY_SANDBOX_PORT ?? 4242}`;
const RECEIVER_PORT = Number(process.env.WEBHOOK_PORT ?? 3000);
const RECEIVER = `http://localhost:${RECEIVER_PORT}`;
const WAIT_TIMEOUT_MS = 10_000;

const hmac = (algorithm: "sha256" | "sha512", key: string, data: string) =>
  createHmac(algorithm, key).update(data, "utf8").digest("hex");

/* ------------------------------ credentials ------------------------------ */

interface Setting {
  key: string;
  value: string;
}
interface ProviderInfo {
  name: string;
  settings: Setting[];
}

const creds = { momo: {} as Record<string, string>, zalopay: {} as Record<string, string>, vnpay: {} as Record<string, string> };

async function loadCredentials(): Promise<void> {
  const config = (await (await fetch(`${SANDBOX}/__sandbox/config`)).json()) as { providers: ProviderInfo[] };
  for (const provider of config.providers) {
    if (provider.name === "momo" || provider.name === "zalopay" || provider.name === "vnpay") {
      creds[provider.name] = Object.fromEntries(provider.settings.map((setting) => [setting.key, setting.value]));
    }
  }
}

/* ------------------- merchant-side signature helpers --------------------- */

function momoSign(fields: Array<[string, unknown]>): string {
  return hmac("sha256", creds.momo.secretKey ?? "", fields.map(([key, value]) => `${key}=${String(value)}`).join("&"));
}

function momoIpnValid(body: Record<string, unknown>): boolean {
  const expected = momoSign([
    ["accessKey", creds.momo.accessKey],
    ["amount", body.amount],
    ["extraData", body.extraData],
    ["message", body.message],
    ["orderId", body.orderId],
    ["orderInfo", body.orderInfo],
    ["orderType", body.orderType],
    ["partnerCode", body.partnerCode],
    ["payType", body.payType],
    ["requestId", body.requestId],
    ["responseTime", body.responseTime],
    ["resultCode", body.resultCode],
    ["transId", body.transId],
  ]);
  return expected === body.signature;
}

/** VNPay's official Node.js sample: encode keys and values, `%20` → `+`, sort, stringify without re-encoding. */
function vnpSortObject(input: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  const keys = Object.keys(input).map((key) => encodeURIComponent(key)).sort();
  for (const key of keys) {
    sorted[key] = encodeURIComponent(input[key] ?? "").replace(/%20/g, "+");
  }
  return sorted;
}

function vnpHash(params: Record<string, string>): string {
  const signData = qs.stringify(vnpSortObject(params), { encode: false });
  return hmac("sha512", creds.vnpay.hashSecret ?? "", signData);
}

function vnpVerify(query: Record<string, string>): boolean {
  const { vnp_SecureHash: secureHash, vnp_SecureHashType: _type, ...rest } = query;
  return vnpHash(rest) === secureHash;
}

function vnTimestamp(offsetMinutes = 0): string {
  const date = new Date(Date.now() + offsetMinutes * 60_000 + 7 * 3_600_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/* ----------------------------- the receiver ------------------------------ */

type Received = { gateway: "momo" | "zalopay" | "vnpay"; id: string; body: Record<string, unknown>; valid: boolean };
const received: Received[] = [];
const waiters: Array<{ match: (item: Received) => boolean; resolve: (item: Received) => void }> = [];
/** Order IDs whose first notification the receiver deliberately rejects to exercise retries. */
const failFirst = new Set<string>();
const seen = new Map<string, number>();
/** IDs that are signed with a wrong key on purpose; their rejection is expected. */
const expectInvalid = new Set<string>();

function record(item: Received): void {
  received.push(item);
  for (const waiter of [...waiters]) {
    if (waiter.match(item)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(item);
    }
  }
}

function waitFor(gateway: Received["gateway"], id: string, predicate: (item: Received) => boolean = () => true): Promise<Received> {
  const match = (item: Received) => item.gateway === gateway && item.id === id && predicate(item);
  const existing = received.find(match);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = { match, resolve };
    waiters.push(waiter);
    setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index !== -1) {
        waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${gateway} notification for ${id}`));
      }
    }, WAIT_TIMEOUT_MS);
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const receiver = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", RECEIVER);
  const raw = await readBody(request);
  const json = (status: number, body: unknown) =>
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

  if (request.method === "POST" && url.pathname === "/api/momo/ipn") {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const valid = momoIpnValid(body);
    record({ gateway: "momo", id: String(body.orderId), body, valid });
    if (!valid) return json(400, { message: "invalid signature" });
    return response.writeHead(204).end();
  }

  if (request.method === "POST" && url.pathname === "/api/zalopay/callback") {
    const body = JSON.parse(raw) as { data: string; mac: string; type: number };
    const valid = hmac("sha256", creds.zalopay.key2 ?? "", body.data) === body.mac;
    const data = JSON.parse(body.data) as Record<string, unknown>;
    record({ gateway: "zalopay", id: String(data.app_trans_id), body: data, valid });
    if (!valid) return json(200, { return_code: -1, return_message: "mac not equal" });
    return json(200, { return_code: 1, return_message: "success" });
  }

  if (url.pathname === "/api/vnpay/ipn") {
    const query = Object.fromEntries(url.searchParams.entries());
    const valid = vnpVerify(query);
    const id = query.vnp_TxnRef ?? "";
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    record({ gateway: "vnpay", id, body: query, valid });
    if (!valid) return json(200, { RspCode: "97", Message: "Invalid Checksum" });
    if (failFirst.has(id) && count === 1) return json(200, { RspCode: "99", Message: "Unknown error" });
    return json(200, { RspCode: "00", Message: "Confirm Success" });
  }

  response.writeHead(404).end();
});

/* ------------------------------- harness --------------------------------- */

let failures = 0;
async function step(name: string, run: () => Promise<void>): Promise<void> {
  const startedAt = performance.now();
  try {
    await run();
    console.log(`  \x1b[32m✓\x1b[0m ${name} \x1b[2m${Math.round(performance.now() - startedAt)}ms\x1b[0m`);
  } catch (error) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n    \x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function postJson(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${SANDBOX}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Simulates the customer choosing an outcome on a hosted payment page. */
async function choose(pageUrl: string, status: string): Promise<URL> {
  const target = new URL(pageUrl);
  const response = await fetch(`${target.origin}${target.pathname}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `status=${encodeURIComponent(status)}`,
    redirect: "manual",
  });
  assert(response.status === 303, `expected 303 redirect from the payment page, got ${response.status}`);
  return new URL(response.headers.get("location") ?? "");
}

/* --------------------------------- MoMo ---------------------------------- */

async function momoCreate(orderId: string, amount: number, tamper = false) {
  const body: Record<string, unknown> = {
    partnerCode: creds.momo.partnerCode,
    requestId: orderId,
    amount,
    orderId,
    orderInfo: "Thanh toan don hang test",
    redirectUrl: `${RECEIVER}/payment/momo/return`,
    ipnUrl: `${RECEIVER}/api/momo/ipn`,
    requestType: "captureWallet",
    extraData: Buffer.from(JSON.stringify({ email: "a@example.com" })).toString("base64"),
    lang: "vi",
  };
  body.signature = momoSign([
    ["accessKey", creds.momo.accessKey],
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
  if (tamper) body.amount = amount + 1;
  return postJson("/momo/v2/gateway/api/create", body);
}

async function momoSuite(): Promise<void> {
  console.log("\nMoMo");
  const orderId = `MM${Date.now()}`;
  let payUrl = "";

  await step("create with a valid signature → resultCode 0 + payUrl", async () => {
    const { body } = await momoCreate(orderId, 150_000);
    assert(body.resultCode === 0, `resultCode ${String(body.resultCode)}: ${String(body.message)}`);
    payUrl = String(body.payUrl);
    assert(payUrl.includes(orderId), "payUrl should reference the orderId");
  });

  await step("create with a tampered amount → resultCode 11 (signature rejected)", async () => {
    const { status, body } = await momoCreate(`MM${Date.now()}x`, 150_000, true);
    assert(status === 400 && body.resultCode === 11, `expected 400/11, got ${status}/${String(body.resultCode)}`);
  });

  await step("customer pays → redirect carries a valid signature", async () => {
    const location = await choose(payUrl, "0");
    const params = Object.fromEntries(location.searchParams.entries());
    assert(params.resultCode === "0", `redirect resultCode ${params.resultCode}`);
    assert(momoIpnValid(params), "redirect signature does not verify");
  });

  await step("IPN arrives with resultCode 0 and a valid signature (answered 204)", async () => {
    const ipn = await waitFor("momo", orderId);
    assert(ipn.valid, "IPN signature does not verify");
    assert(ipn.body.resultCode === 0 && ipn.body.amount === 150_000, "unexpected IPN body");
  });

  await step("query returns the settled order", async () => {
    const requestId = `Q${Date.now()}`;
    const signature = momoSign([
      ["accessKey", creds.momo.accessKey],
      ["orderId", orderId],
      ["partnerCode", creds.momo.partnerCode],
      ["requestId", requestId],
    ]);
    const { body } = await postJson("/momo/v2/gateway/api/query", {
      partnerCode: creds.momo.partnerCode,
      requestId,
      orderId,
      lang: "vi",
      signature,
    });
    assert(body.resultCode === 0 && Number(body.transId) > 0, `query resultCode ${String(body.resultCode)}`);
  });

  const expiredId = `MM${Date.now()}e`;
  await step("expired order (1005) via the dashboard API → signed IPN", async () => {
    await momoCreate(expiredId, 99_000);
    const { status } = await postJson(`/__sandbox/providers/momo/orders/${expiredId}/webhook`, { status: "1005" });
    assert(status === 200, `dispatch returned ${status}`);
    const ipn = await waitFor("momo", expiredId);
    assert(ipn.valid && ipn.body.resultCode === 1005, `got resultCode ${String(ipn.body.resultCode)}`);
  });

  await step("Edit & Fire with a wrong signature is rejected by the merchant", async () => {
    const tamperedId = `MM${Date.now()}t`;
    expectInvalid.add(tamperedId);
    await postJson("/__sandbox/fire", {
      provider: "momo",
      signature: "invalid",
      payload: { partnerCode: creds.momo.partnerCode, orderId: tamperedId, requestId: tamperedId, amount: 1000, orderInfo: "x", orderType: "momo_wallet", transId: 1, resultCode: 0, message: "Thành công.", payType: "qr", responseTime: Date.now(), extraData: "" },
    });
    const ipn = await waitFor("momo", tamperedId);
    assert(!ipn.valid, "a deliberately mis-signed IPN verified as valid");
  });
}

/* -------------------------------- ZaloPay -------------------------------- */

function zaloCreateBody(appTransId: string, amount: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    app_id: Number(creds.zalopay.appId),
    app_user: "user123",
    app_trans_id: appTransId,
    app_time: Date.now(),
    amount,
    item: JSON.stringify([{ itemid: "knb", itemname: "kim nguyen bao", itemprice: amount, itemquantity: 1 }]),
    embed_data: JSON.stringify({ redirecturl: `${RECEIVER}/payment/zalopay/return` }),
    description: "Thanh toan don hang test",
    bank_code: "",
    callback_url: `${RECEIVER}/api/zalopay/callback`,
  };
  const macInput = [body.app_id, body.app_trans_id, body.app_user, body.amount, body.app_time, body.embed_data, body.item].join("|");
  body.mac = hmac("sha256", creds.zalopay.key1 ?? "", macInput);
  return body;
}

async function zaloQuery(appTransId: string) {
  const mac = hmac("sha256", creds.zalopay.key1 ?? "", `${creds.zalopay.appId}|${appTransId}|${creds.zalopay.key1}`);
  return (await postJson("/zalopay/v2/query", { app_id: creds.zalopay.appId, app_trans_id: appTransId, mac })).body;
}

async function zalopaySuite(): Promise<void> {
  console.log("\nZaloPay");
  const today = vnTimestamp().slice(2, 8);
  const appTransId = `${today}_${Date.now()}`;
  let orderUrl = "";

  await step("create with a valid mac → return_code 1 + order_url", async () => {
    const { body } = await postJson("/zalopay/v2/create", zaloCreateBody(appTransId, 120_000));
    assert(body.return_code === 1, `return_code ${String(body.return_code)} ${String(body.sub_return_message)}`);
    assert(typeof body.zp_trans_token === "string", "missing zp_trans_token");
    orderUrl = String(body.order_url);
  });

  await step("create with a wrong mac → return_code 2, sub_return_code -402", async () => {
    const body = zaloCreateBody(`${today}_${Date.now()}x`, 120_000);
    body.mac = "0".repeat(64);
    const response = await postJson("/zalopay/v2/create", body);
    assert(response.body.return_code === 2 && response.body.sub_return_code === -402, JSON.stringify(response.body));
  });

  await step("query before payment → return_code 3 (processing)", async () => {
    const body = await zaloQuery(appTransId);
    assert(body.return_code === 3, `return_code ${String(body.return_code)}`);
  });

  await step("customer pays → redirect checksum verifies with key2", async () => {
    const location = await choose(orderUrl, "success");
    const p = Object.fromEntries(location.searchParams.entries());
    const checksum = hmac(
      "sha256",
      creds.zalopay.key2 ?? "",
      [p.appid, p.apptransid, p.pmcid, p.bankcode, p.amount, p.discountamount, p.status].join("|"),
    );
    assert(p.status === "1" && checksum === p.checksum, "redirect checksum does not verify");
  });

  await step("callback arrives with a mac that verifies with key2", async () => {
    const callback = await waitFor("zalopay", appTransId);
    assert(callback.valid, "callback mac does not verify");
    assert(callback.body.amount === 120_000 && Number(callback.body.zp_trans_id) > 0, "unexpected callback data");
  });

  await step("query after payment → return_code 1", async () => {
    const body = await zaloQuery(appTransId);
    assert(body.return_code === 1 && body.amount === 120_000, `return_code ${String(body.return_code)}`);
  });

  await step("failed payment sends no callback; query → return_code 2", async () => {
    const failedId = `${today}_${Date.now()}f`;
    const { body } = await postJson("/zalopay/v2/create", zaloCreateBody(failedId, 50_000));
    await choose(String(body.order_url), "failed");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert(!received.some((item) => item.gateway === "zalopay" && item.id === failedId), "a failed payment produced a callback");
    const query = await zaloQuery(failedId);
    assert(query.return_code === 2, `return_code ${String(query.return_code)}`);
  });
}

/* --------------------------------- VNPay --------------------------------- */

function vnpPaymentUrl(txnRef: string, amount: number, orderInfo: string): string {
  const params: Record<string, string> = {
    vnp_Version: "2.1.0",
    vnp_Command: "pay",
    vnp_TmnCode: creds.vnpay.tmnCode ?? "",
    vnp_Locale: "vn",
    vnp_CurrCode: "VND",
    vnp_TxnRef: txnRef,
    vnp_OrderInfo: orderInfo,
    vnp_OrderType: "other",
    vnp_Amount: String(amount * 100),
    vnp_ReturnUrl: `${RECEIVER}/payment/vnpay/return`,
    vnp_IpAddr: "127.0.0.1",
    vnp_CreateDate: vnTimestamp(),
    vnp_ExpireDate: vnTimestamp(15),
  };
  const sorted = vnpSortObject(params);
  const signData = qs.stringify(sorted, { encode: false });
  sorted.vnp_SecureHash = hmac("sha512", creds.vnpay.hashSecret ?? "", signData);
  return `${SANDBOX}/vnpay/paymentv2/vpcpay.html?${qs.stringify(sorted, { encode: false })}`;
}

async function vnpaySuite(): Promise<void> {
  console.log("\nVNPay");
  const txnRef = `VN${Date.now()}`;

  await step("payment URL signed like VNPay's Node sample is accepted", async () => {
    const response = await fetch(vnpPaymentUrl(txnRef, 250_000, "Thanh toan don hang 123"));
    const html = await response.text();
    assert(response.status === 200 && html.includes("Thanh toán thành công"), `page returned ${response.status}`);
  });

  await step("payment URL with a modified amount → 'Sai chữ ký'", async () => {
    const url = vnpPaymentUrl(`VN${Date.now()}x`, 250_000, "Thanh toan").replace("vnp_Amount=25000000", "vnp_Amount=100");
    const response = await fetch(url);
    const html = await response.text();
    assert(response.status === 400 && html.includes("Sai chữ ký"), `page returned ${response.status}`);
  });

  await step("customer pays → return URL params verify", async () => {
    const location = await choose(`${SANDBOX}/vnpay/pay/${txnRef}`, "00");
    const params = Object.fromEntries(location.searchParams.entries());
    assert(params.vnp_ResponseCode === "00", `vnp_ResponseCode ${params.vnp_ResponseCode}`);
    assert(vnpVerify(params), "return URL vnp_SecureHash does not verify");
  });

  await step("IPN (GET) arrives with a valid vnp_SecureHash", async () => {
    const ipn = await waitFor("vnpay", txnRef);
    assert(ipn.valid, "IPN vnp_SecureHash does not verify");
    assert(ipn.body.vnp_Amount === "25000000" && ipn.body.vnp_TransactionStatus === "00", "unexpected IPN params");
  });

  await step("RspCode 99 makes VNPay retry the IPN (~3s)", async () => {
    const retryRef = `VN${Date.now()}r`;
    failFirst.add(retryRef);
    await fetch(vnpPaymentUrl(retryRef, 10_000, "Retry test"));
    await choose(`${SANDBOX}/vnpay/pay/${retryRef}`, "24");
    await waitFor("vnpay", retryRef, () => (seen.get(retryRef) ?? 0) >= 2);
    assert(seen.get(retryRef) === 2, `expected 2 IPN calls, got ${seen.get(retryRef)}`);
  });
}

/* ---------------------------------- main --------------------------------- */

async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(RECEIVER_PORT, resolve);
  });
  await loadCredentials();

  console.log(`pay-sandbox gateway tests\x1b[2m  sandbox ${SANDBOX}  receiver ${RECEIVER}\x1b[0m`);
  await momoSuite();
  await zalopaySuite();
  await vnpaySuite();

  const invalid = received.filter((item) => !item.valid && !expectInvalid.has(item.id));
  if (invalid.length > 0) {
    failures += 1;
    console.log(`\n\x1b[31m${invalid.length} notification(s) failed signature verification unexpectedly\x1b[0m`);
  }

  console.log(failures === 0 ? "\n\x1b[32mAll gateway checks passed.\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
  receiver.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(`\x1b[31mtest-gateways crashed: ${error instanceof Error ? error.message : String(error)}\x1b[0m`);
  console.error("Is pay-sandbox running? Start it with `npm run dev:server`.");
  process.exit(1);
});
