#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULT_CONFIG, type SandboxConfig, parseRetrySchedule } from "./config.js";
import { buildServer } from "./server.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const color = {
  dim: (text: string) => `\x1b[2m${text}\x1b[22m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  green: (text: string) => `\x1b[32m${text}\x1b[39m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[39m`,
  red: (text: string) => `\x1b[31m${text}\x1b[39m`,
  cyan: (text: string) => `\x1b[36m${text}\x1b[39m`,
  magenta: (text: string) => `\x1b[35m${text}\x1b[39m`,
};

const HELP = `
${color.bold("pay-sandbox")} ${color.dim(`v${pkg.version}`)} — local sandbox for Stripe, MoMo, ZaloPay & VNPay

${color.bold("Usage")}
  npx pay-sandbox [options]

${color.bold("Options")}
  -p, --port <number>          Port for the API and dashboard   ${color.dim(`(default ${DEFAULT_CONFIG.port})`)}
      --host <address>         Interface to bind                ${color.dim(`(default ${DEFAULT_CONFIG.host})`)}
  -w, --webhook-url <url>      Where Stripe webhooks are sent   ${color.dim(`(default ${DEFAULT_CONFIG.webhookUrl})`)}
  -s, --webhook-secret <sec>   Stripe signing secret            ${color.dim(`(default ${DEFAULT_CONFIG.webhookSecret})`)}
      --api-version <ver>      api_version stamped on events    ${color.dim(`(default ${DEFAULT_CONFIG.apiVersion})`)}
      --webhook-timeout <ms>   Per-attempt delivery timeout     ${color.dim(`(default ${DEFAULT_CONFIG.webhookTimeoutMs})`)}
      --retry-schedule <s,..>  Retry delays in seconds          ${color.dim(`(default ${DEFAULT_CONFIG.retry.scheduleMs.map((ms) => ms / 1000).join(",")})`)}
      --no-retry               Disable automatic webhook retries
  -q, --quiet                  Do not log API requests and webhook deliveries
  -v, --version                Print the version
  -h, --help                   Show this help

${color.bold("Environment")}
  PAY_SANDBOX_PORT, PAY_SANDBOX_HOST, PAY_SANDBOX_WEBHOOK_URL, PAY_SANDBOX_WEBHOOK_SECRET,
  PAY_SANDBOX_RETRY_SCHEDULE
`;

function parseCli(): { config: Partial<SandboxConfig>; quiet: boolean } {
  const { values } = parseArgs({
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      "webhook-url": { type: "string", short: "w" },
      "webhook-secret": { type: "string", short: "s" },
      "api-version": { type: "string" },
      "webhook-timeout": { type: "string" },
      "retry-schedule": { type: "string" },
      "no-retry": { type: "boolean", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (values.version) {
    process.stdout.write(`${pkg.version}\n`);
    process.exit(0);
  }

  const env = process.env;
  const portRaw = values.port ?? env.PAY_SANDBOX_PORT;
  const port = portRaw === undefined ? DEFAULT_CONFIG.port : Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${portRaw}`);
  }

  const webhookUrl = values["webhook-url"] ?? env.PAY_SANDBOX_WEBHOOK_URL ?? DEFAULT_CONFIG.webhookUrl;
  new URL(webhookUrl);

  const timeoutRaw = values["webhook-timeout"];
  const webhookTimeoutMs = timeoutRaw === undefined ? DEFAULT_CONFIG.webhookTimeoutMs : Number.parseInt(timeoutRaw, 10);
  if (!Number.isInteger(webhookTimeoutMs) || webhookTimeoutMs < 100) {
    throw new Error(`Invalid webhook timeout: ${timeoutRaw}`);
  }

  const scheduleRaw = values["retry-schedule"] ?? env.PAY_SANDBOX_RETRY_SCHEDULE;
  const scheduleMs =
    scheduleRaw === undefined
      ? DEFAULT_CONFIG.retry.scheduleMs
      : parseRetrySchedule(scheduleRaw.split(",").map((part) => Number(part.trim()) * 1000));

  return {
    quiet: values.quiet,
    config: {
      port,
      host: values.host ?? env.PAY_SANDBOX_HOST ?? DEFAULT_CONFIG.host,
      webhookUrl,
      webhookSecret: values["webhook-secret"] ?? env.PAY_SANDBOX_WEBHOOK_SECRET ?? DEFAULT_CONFIG.webhookSecret,
      apiVersion: values["api-version"] ?? DEFAULT_CONFIG.apiVersion,
      webhookTimeoutMs,
      retry: { enabled: !values["no-retry"], scheduleMs },
    },
  };
}

function statusColor(status: number | null): (text: string) => string {
  if (status === null || status >= 500) return color.red;
  if (status >= 400) return color.yellow;
  return color.green;
}

async function main(): Promise<void> {
  const { config, quiet } = parseCli();

  const sandbox = await buildServer({
    config,
    onApiRequest: quiet
      ? undefined
      : ({ method, url, statusCode, durationMs }) => {
          const paint = statusColor(statusCode);
          console.log(`${color.dim("api")}      ${paint(String(statusCode))} ${method.padEnd(4)} ${url} ${color.dim(`${durationMs}ms`)}`);
        },
  });

  if (!quiet) {
    const reported = new Set<string>();
    sandbox.bus.on("log", (log) => {
      const delivery = log.deliveries.at(-1);
      if (!delivery || reported.has(delivery.id)) return;
      reported.add(delivery.id);
      if (reported.size > 5_000) reported.clear();

      const label = delivery.statusCode === null ? "ERR" : String(delivery.statusCode);
      const paint = delivery.ok ? color.green : delivery.statusCode !== null && delivery.statusCode < 400 ? color.yellow : statusColor(delivery.statusCode);
      const suffix = delivery.error ? color.red(` ${delivery.error}`) : color.dim(` ${delivery.durationMs}ms`);
      const tag =
        delivery.trigger === "replay"
          ? color.dim(" (replay)")
          : delivery.trigger === "retry"
            ? color.dim(` (retry ${(delivery.attempt ?? 1) - 1}/${log.max_retries})`)
            : "";
      const exhausted = log.max_retries > 0 && log.attempt_count > log.max_retries;
      const next =
        log.status === "retrying" && log.next_retry_at !== null
          ? color.yellow(` → retry in ${Math.round((log.next_retry_at - Date.now()) / 1000)}s`)
          : log.status === "failed" && delivery.trigger !== "replay"
            ? color.red(exhausted ? " → max retries exceeded" : " → not retried")
            : "";
      const note = delivery.note ? color.dim(` · ${delivery.note}`) : "";
      console.log(`${color.magenta("webhook")}  ${paint(label)} ${log.type}${tag}${suffix}${next}${note}`);
    });
  }

  const address = await sandbox.app.listen({ port: sandbox.config.port, host: sandbox.config.host });
  const base = address.replace("127.0.0.1", "localhost");
  const { momo, zalopay, vnpay } = sandbox.config.providers;

  console.log(`
  ${color.bold("pay-sandbox")} ${color.dim(`v${pkg.version}`)}  ${color.green("ready")}

  ${color.dim("Dashboard")}    ${color.cyan(`${base}/dashboard`)}

  ${color.bold("Stripe")}       ${color.cyan(`${base}/v1`)}  ${color.dim(`webhooks → ${sandbox.config.webhookUrl}`)}
  ${color.bold("MoMo")}         ${color.cyan(`${base}/momo/v2/gateway/api/create`)}  ${color.dim(`partnerCode ${momo.partnerCode}`)}
  ${color.bold("ZaloPay")}      ${color.cyan(`${base}/zalopay/v2/create`)}  ${color.dim(`app_id ${zalopay.appId}`)}
  ${color.bold("VNPay")}        ${color.cyan(`${base}/vnpay/paymentv2/vpcpay.html`)}  ${color.dim(`IPN → ${vnpay.ipnUrl}`)}

  ${color.dim("Credentials and secrets for every gateway are on the dashboard.")}
`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(color.dim(`\n${signal} received, shutting down…`));
    await sandbox.app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(color.red(`pay-sandbox failed to start: ${error instanceof Error ? error.message : String(error)}`));
  process.exit(1);
});
