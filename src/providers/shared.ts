import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export function hmacHex(algorithm: "sha256" | "sha512", key: string, data: string): string {
  return createHmac(algorithm, key).update(data, "utf8").digest("hex");
}

/** Constant-time comparison of two hex signatures (case-insensitive). */
export function signaturesMatch(expected: string, received: unknown): boolean {
  if (typeof received !== "string") return false;
  const a = Buffer.from(expected.toLowerCase(), "utf8");
  const b = Buffer.from(received.toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A key that is guaranteed to differ from the real one, for `invalid` signature mode. */
export function tamperedKey(key: string): string {
  return `${key}::tampered-by-pay-sandbox`;
}

/** Random numeric string, used for MoMo `transId`, ZaloPay `zp_trans_id`, VNPay `vnp_TransactionNo`. */
export function numericId(length: number): string {
  let value = String(randomInt(1, 10));
  while (value.length < length) value += String(randomInt(0, 10));
  return value;
}

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

function vietnamParts(date: Date) {
  const shifted = new Date(date.getTime() + VN_OFFSET_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    yyyy: String(shifted.getUTCFullYear()),
    yy: String(shifted.getUTCFullYear()).slice(-2),
    MM: pad(shifted.getUTCMonth() + 1),
    dd: pad(shifted.getUTCDate()),
    HH: pad(shifted.getUTCHours()),
    mm: pad(shifted.getUTCMinutes()),
    ss: pad(shifted.getUTCSeconds()),
  };
}

/** `yyyyMMddHHmmss` in GMT+7, the timestamp format used by VNPay. */
export function vnTimestamp(date: Date = new Date()): string {
  const p = vietnamParts(date);
  return `${p.yyyy}${p.MM}${p.dd}${p.HH}${p.mm}${p.ss}`;
}

/** `yyMMdd` in GMT+7, the prefix ZaloPay requires on `app_trans_id`. */
export function vnDatePrefix(date: Date = new Date()): string {
  const p = vietnamParts(date);
  return `${p.yy}${p.MM}${p.dd}`;
}

/** Parses a VNPay `yyyyMMddHHmmss` GMT+7 timestamp. */
export function parseVnTimestamp(value: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number) as [number, number, number, number, number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - VN_OFFSET_MS);
}

export function formatVnd(amount: number): string {
  return `${new Intl.NumberFormat("vi-VN").format(amount)} ₫`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function asInteger(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : Number.NaN;
  return Number.isInteger(numeric) ? numeric : null;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function appendQuery(url: string, params: Record<string, string>): string {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target.toString();
}

export interface HostedPageAction {
  label: string;
  /** Value posted as `status` to the page's action URL. */
  status: string;
  tone: "primary" | "danger" | "neutral";
  hint?: string;
}

export interface HostedPageOptions {
  brand: string;
  accent: string;
  title: string;
  amount: string;
  reference: string;
  description: string | null;
  actionUrl: string;
  actions: HostedPageAction[];
  notice?: { tone: "info" | "error"; text: string } | null;
}

/**
 * Renders the simulated payment page shared by MoMo, ZaloPay and VNPay. It is
 * plain HTML with one form per outcome so it works without JavaScript.
 */
export function renderHostedPage(options: HostedPageOptions): string {
  const notice = options.notice
    ? `<p class="notice ${options.notice.tone}">${escapeHtml(options.notice.text)}</p>`
    : "";
  const actions = options.actions
    .map(
      (action) => `<form method="post" action="${escapeHtml(options.actionUrl)}">
        <input type="hidden" name="status" value="${escapeHtml(action.status)}" />
        <button class="${action.tone}" type="submit">
          <span>${escapeHtml(action.label)}</span>
          ${action.hint ? `<small>${escapeHtml(action.hint)}</small>` : ""}
        </button>
      </form>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(options.brand)} · pay-sandbox</title>
<style>
  :root { color-scheme: dark; --accent: ${options.accent}; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    background: #09090b; color: #fafafa; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  .card { width: 100%; max-width: 420px; border: 1px solid #27272a; border-radius: 16px; background: #18181b; overflow: hidden; }
  .head { padding: 18px 24px; background: linear-gradient(135deg, var(--accent), color-mix(in oklab, var(--accent) 55%, #000));
    display: flex; align-items: center; justify-content: space-between; }
  .brand { font-weight: 700; letter-spacing: -0.01em; font-size: 16px; }
  .badge { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; background: rgba(0,0,0,.28);
    border-radius: 999px; padding: 2px 10px; }
  .body { padding: 24px; }
  .label { color: #a1a1aa; font-size: 12px; margin: 0; }
  h1 { font-size: 30px; margin: 4px 0 2px; font-weight: 650; letter-spacing: -0.02em; }
  .desc { color: #d4d4d8; margin: 8px 0 0; }
  code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: #a1a1aa; word-break: break-all; }
  .actions { display: grid; gap: 8px; margin-top: 22px; }
  form { margin: 0; }
  button { width: 100%; border: 1px solid transparent; border-radius: 10px; padding: 10px 14px; font: inherit;
    font-weight: 500; cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 12px; text-align: left; }
  button small { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; opacity: .7; }
  .primary { background: var(--accent); color: #fff; }
  .primary:hover { filter: brightness(1.1); }
  .danger { background: transparent; color: #fca5a5; border-color: #3f1d1d; }
  .danger:hover { background: #2a1212; }
  .neutral { background: transparent; color: #d4d4d8; border-color: #27272a; }
  .neutral:hover { border-color: #3f3f46; }
  .notice { margin: 16px 0 0; padding: 10px 12px; border-radius: 10px; font-size: 13px; }
  .notice.info { background: #27272a; color: #e4e4e7; }
  .notice.error { background: #2a1212; color: #fca5a5; border: 1px solid #3f1d1d; }
  .foot { padding: 12px 24px; border-top: 1px solid #27272a; color: #71717a; font-size: 12px; }
</style>
</head>
<body>
  <main class="card">
    <div class="head"><span class="brand">${escapeHtml(options.brand)}</span><span class="badge">Sandbox</span></div>
    <div class="body">
      <p class="label">${escapeHtml(options.title)}</p>
      <h1>${escapeHtml(options.amount)}</h1>
      <code>${escapeHtml(options.reference)}</code>
      ${options.description ? `<p class="desc">${escapeHtml(options.description)}</p>` : ""}
      ${notice}
      ${options.actions.length > 0 ? `<div class="actions">${actions}</div>` : ""}
    </div>
    <div class="foot">Simulated by pay-sandbox. No real money moves.</div>
  </main>
</body>
</html>`;
}
