#!/usr/bin/env node
/**
 * Watches the official MoMo, ZaloPay and VNPay documentation pages that the
 * provider adapters are built from.
 *
 * Each page is downloaded, reduced to its main text and compared with the
 * snapshot committed under .github/gateway-docs/. Changed snapshots are written
 * to disk; the "Gateway docs watch" workflow then opens a pull request whose
 * diff shows exactly what changed in the documentation.
 *
 *   node scripts/watch-gateway-docs.mjs            update snapshots, print a summary
 *   node scripts/watch-gateway-docs.mjs --check    exit 1 if any page changed, write nothing
 *
 * Stripe is intentionally not watched: its changelog changes almost weekly, and
 * API changes reach this repo through Dependabot (stripe SDK) + test-client.ts.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SNAPSHOT_DIR = join(ROOT, ".github", "gateway-docs");
const USER_AGENT = "pay-sandbox-docs-watch/1.0 (+https://github.com/nhan7tuoi/pay-sandbox)";
const CHECK_ONLY = process.argv.includes("--check");

/**
 * `expect` is a string that must appear in the extracted text. If it is missing the
 * page layout probably changed (or the request was blocked), and the snapshot is
 * left untouched instead of being overwritten with garbage.
 */
const PAGES = [
  {
    id: "momo/onetime-payment",
    url: "https://developers.momo.vn/v3/docs/payment/api/wallet/onetime",
    expect: "accessKey=$accessKey",
    review: ["`src/providers/momo.ts`: create request fields and signature, IPN fields and signature", "`docs/momo.md`"],
  },
  {
    id: "momo/result-codes",
    url: "https://developers.momo.vn/v3/docs/payment/api/result-handling/resultcode",
    expect: "1006",
    review: ["`src/providers/momo.ts`: `RESULT_MESSAGES`, `SETTLEABLE_CODES`", "`docs/momo.md`: result code table"],
  },
  {
    id: "momo/notification",
    url: "https://developers.momo.vn/v3/docs/payment/api/result-handling/notification/",
    expect: "204",
    review: ["`src/providers/momo.ts`: `evaluateResponse` (HTTP 204 rule)"],
  },
  {
    id: "momo/query",
    url: "https://developers.momo.vn/v3/docs/payment/api/payment-api/query/",
    expect: "requestId",
    review: ["`src/providers/momo.ts`: `queryOrder` fields and signature"],
  },
  {
    id: "zalopay/order-create",
    url: "https://docs.zalopay.vn/docs/specs/order-create/",
    expect: "app_trans_id",
    review: ["`src/providers/zalopay.ts`: `createOrder`, `zaloPayCreateMacInput`", "`docs/zalopay.md`"],
  },
  {
    id: "zalopay/callback",
    url: "https://docs.zalopay.vn/docs/specs/callback-api/",
    expect: "zp_trans_id",
    review: ["`src/providers/zalopay.ts`: `buildCallbackPayload`, `evaluateResponse`"],
  },
  {
    id: "zalopay/order-query",
    url: "https://docs.zalopay.vn/docs/specs/order-query/",
    expect: "app_trans_id",
    review: ["`src/providers/zalopay.ts`: `queryOrder`"],
  },
  {
    id: "zalopay/status-codes",
    url: "https://docs.zalopay.vn/docs/developer-tools/knowledge-base/status-codes/",
    expect: "-402",
    review: ["`src/providers/zalopay.ts`: `SUB_CODES`", "`docs/zalopay.md`: status code table"],
  },
  {
    id: "vnpay/pay",
    url: "https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html",
    expect: "vnp_SecureHash",
    review: [
      "`src/providers/vnpay.ts`: required params, `vnpaySignData`, IPN params, `RESPONSE_CODES`, `RSP_CODES`",
      "`docs/vnpay.md`",
    ],
  },
];

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, code) => {
    const lower = code.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return ENTITIES[lower] ?? match;
  });
}

/** First `<tag …>…</tag>` block, or null. Good enough for Docusaurus' single <article>/<main>. */
function firstBlock(html, tag) {
  const start = html.search(new RegExp(`<${tag}[\\s>]`, "i"));
  if (start === -1) return null;
  const end = html.toLowerCase().lastIndexOf(`</${tag}>`);
  return end > start ? html.slice(start, end) : null;
}

/** Reduces a documentation page to stable, diff-friendly text. */
export function extractText(html) {
  let content = firstBlock(html, "article") ?? firstBlock(html, "main") ?? firstBlock(html, "body") ?? html;

  content = content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|button|form|iframe)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(td|th)[^>]*>/gi, " | ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|table|thead|tbody|tr|ul|ol|pre|blockquote|h[1-6]|dl|dt|dd|details|summary)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  const lines = decodeEntities(content)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line) => line.length > 0 && line !== "|" && line !== "-");

  const deduped = lines.filter((line, index) => line !== lines[index - 1]);
  return `${deduped.join("\n")}\n`;
}

async function fetchPage(page) {
  const response = await fetch(page.url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = extractText(await response.text());
  if (!text.includes(page.expect)) {
    throw new Error(`expected text "${page.expect}" not found; the page layout may have changed`);
  }
  return text;
}

function snapshotPath(page) {
  return join(SNAPSHOT_DIR, `${page.id}.txt`);
}

function render(page, text) {
  return `Source: ${page.url}\n\n${text}`;
}

function lineDelta(before, after) {
  const a = new Set(before.split("\n"));
  const b = new Set(after.split("\n"));
  const added = [...b].filter((line) => !a.has(line)).length;
  const removed = [...a].filter((line) => !b.has(line)).length;
  return { added, removed };
}

const results = [];
for (const page of PAGES) {
  const path = snapshotPath(page);
  try {
    const content = render(page, await fetchPage(page));
    const previous = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (previous === content) {
      results.push({ page, state: "unchanged" });
      continue;
    }
    if (!CHECK_ONLY) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    results.push({ page, state: previous === null ? "new" : "changed", delta: lineDelta(previous ?? "", content) });
  } catch (error) {
    results.push({ page, state: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

const changed = results.filter((result) => result.state === "changed" || result.state === "new");
const errors = results.filter((result) => result.state === "error");

for (const result of results) {
  const detail =
    result.state === "error"
      ? ` (${result.error})`
      : result.delta
        ? ` (+${result.delta.added} / -${result.delta.removed} lines)`
        : "";
  console.log(`${result.state.padEnd(9)} ${result.page.id}${detail}`);
}

const providers = [...new Set(changed.map((result) => result.page.id.split("/")[0]))];
const body = [
  "The official documentation that pay-sandbox's adapters are built from has changed.",
  "**Files changed** shows the text diff of each page. Review it, update the adapters if the behaviour changed, then merge to accept the new snapshots.",
  "",
  "## Changed pages",
  "",
  ...changed.map(
    (result) =>
      `- [ ] **${result.page.id}** (${result.state}, +${result.delta.added} / -${result.delta.removed} lines) · [source](${result.page.url})\n` +
      result.page.review.map((item) => `  - ${item}`).join("\n"),
  ),
  "",
  ...(errors.length > 0
    ? ["## Pages that could not be checked", "", ...errors.map((result) => `- **${result.page.id}**: ${result.error} · [source](${result.page.url})`), ""]
    : []),
  "If the protocol changed, also run `npm test` and update `test-gateways.ts` so the end-to-end checks follow the new rules.",
  "",
  "_Opened automatically by `.github/workflows/gateway-docs-watch.yml`._",
].join("\n");

if (process.env.GITHUB_OUTPUT) {
  const bodyPath = join(process.env.RUNNER_TEMP ?? ROOT, "gateway-docs-pr-body.md");
  writeFileSync(bodyPath, body);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `changed=${changed.length > 0}\nproviders=${providers.join(", ")}\nbody-path=${bodyPath}\nerrors=${errors.length}\n`,
  );
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Gateway docs watch\n\n| Page | State |\n|---|---|\n${results
      .map((result) => `| [${result.page.id}](${result.page.url}) | ${result.state}${result.error ? `: ${result.error}` : ""} |`)
      .join("\n")}\n`,
  );
}

if (errors.length === PAGES.length) {
  console.error("\nNo page could be checked.");
  process.exit(1);
}
if (CHECK_ONLY && changed.length > 0) process.exit(1);
