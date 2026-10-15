import type { FastifyInstance } from "fastify";
import type { SandboxBus } from "../bus.js";
import { type MutableConfigPatch, type SandboxConfig, applyConfigPatch } from "../config.js";
import { StripeError } from "../errors.js";
import { asParams } from "../params.js";
import { isProviderName, type ProviderRegistry } from "../providers/registry.js";
import type { MemoryStore } from "../store.js";
import type { WebhookDispatcher } from "../webhook/dispatcher.js";
import { requestBaseUrl } from "./stripe.js";

const HEARTBEAT_MS = 15_000;

export interface SandboxRoutesContext {
  store: MemoryStore;
  dispatcher: WebhookDispatcher;
  config: SandboxConfig;
  bus: SandboxBus;
  providers: ProviderRegistry;
}

export function publicBaseUrl(config: SandboxConfig): string {
  const host = ["0.0.0.0", "127.0.0.1", "::"].includes(config.host) ? "localhost" : config.host;
  return `http://${host}:${config.port}`;
}

function publicConfig(config: SandboxConfig, providers: ProviderRegistry) {
  const apiBase = publicBaseUrl(config);
  return {
    webhookUrl: config.webhookUrl,
    webhookSecret: config.webhookSecret,
    webhookTimeoutMs: config.webhookTimeoutMs,
    apiVersion: config.apiVersion,
    apiBase,
    retry: config.retry,
    chaos: config.chaos,
    providers: providers.all().map((provider) => provider.describe(apiBase)),
    triggers: providers.triggers().map(({ id, provider, label, description }) => ({ id, provider, label, description })),
  };
}

/**
 * Internal API consumed by the React dashboard. Everything lives under
 * `/__sandbox` so it never collides with any gateway's public surface.
 */
export async function sandboxRoutes(app: FastifyInstance, ctx: SandboxRoutesContext): Promise<void> {
  const { store, dispatcher, config, bus, providers } = ctx;
  const snapshotConfig = () => publicConfig(config, providers);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof StripeError) {
      return reply.status(error.statusCode).send({ error: error.body.message, details: error.body });
    }
    const message = error instanceof Error ? error.message : String(error);
    return reply.status(400).send({ error: message });
  });

  app.get("/health", async () => ({ ok: true, uptime: process.uptime() }));

  app.get("/config", async () => snapshotConfig());

  app.patch("/config", async (request) => {
    applyConfigPatch(config, asParams(request.body) as MutableConfigPatch);
    dispatcher.applyConfig();
    bus.emit("config", config);
    return snapshotConfig();
  });

  app.patch<{ Params: { name: string } }>("/providers/:name/settings", async (request, reply) => {
    const provider = providers.find(request.params.name);
    if (!provider) return reply.status(404).send({ error: `Unknown provider '${request.params.name}'` });
    provider.updateSettings(asParams(request.body));
    bus.emit("config", config);
    return snapshotConfig();
  });

  app.get<{ Params: { name: string } }>("/providers/:name/orders", async (request, reply) => {
    const provider = providers.find(request.params.name);
    if (!provider) return reply.status(404).send({ error: `Unknown provider '${request.params.name}'` });
    return { data: provider.listOrders() };
  });

  /** Settles an existing order and sends its webhook, e.g. from an end-to-end test. */
  app.post<{ Params: { name: string; orderId: string } }>(
    "/providers/:name/orders/:orderId/webhook",
    async (request, reply) => {
      const provider = providers.find(request.params.name);
      if (!provider) return reply.status(404).send({ error: `Unknown provider '${request.params.name}'` });
      const { status } = asParams(request.body);
      if (typeof status !== "string" && typeof status !== "number") {
        return reply.status(400).send({ error: 'Body must be { "status": "<gateway status code>" }' });
      }
      const logs = provider.dispatchWebhook(request.params.orderId, String(status), "api");
      return { data: logs };
    },
  );

  app.get("/stats", async () => store.stats());

  app.post("/reset", async () => {
    dispatcher.cancelAllRetries();
    store.reset();
    providers.resetAll();
    bus.emit("logs:cleared");
    return { ok: true };
  });

  app.get("/logs", async () => ({ data: store.listWebhookLogs() }));

  app.delete("/logs", async () => {
    dispatcher.cancelAllRetries();
    store.clearWebhookLogs();
    bus.emit("logs:cleared");
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/logs/:id/replay", async (request, reply) => {
    const log = await dispatcher.replay(request.params.id);
    if (!log) return reply.status(404).send({ error: `No webhook log with id ${request.params.id}` });
    return log;
  });

  app.post("/fire", async (request, reply) => {
    const body = asParams(request.body);
    const payload = asParams(body.payload);
    const provider = body.provider ?? "stripe";
    if (!isProviderName(provider)) {
      return reply.status(400).send({ error: `Unknown provider '${String(provider)}'` });
    }
    if (Object.keys(payload).length === 0) {
      return reply.status(400).send({ error: 'Body must be { "provider": "...", "payload": { ... } }' });
    }
    const mode = body.signature === "invalid" ? "invalid" : "valid";
    return dispatcher.fire(provider, payload, mode);
  });

  app.post("/trigger", async (request, reply) => {
    const body = asParams(request.body);
    const id = typeof body.id === "string" ? body.id : typeof body.type === "string" ? body.type : "";
    const trigger = providers.findTrigger(id) ?? providers.findTrigger(`stripe:${id}`);
    if (!trigger) {
      const available = providers.triggers().map((item) => item.id);
      return reply.status(400).send({ error: `Unknown trigger '${id}'. Available: ${available.join(", ")}` });
    }
    return trigger.run(requestBaseUrl(request));
  });

  app.get("/stream", (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send("snapshot", { logs: store.listWebhookLogs(), config: snapshotConfig() });

    const onLog = (log: unknown) => send("log", log);
    const onCleared = () => send("cleared", {});
    const onConfig = () => send("config", snapshotConfig());
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), HEARTBEAT_MS);

    bus.on("log", onLog);
    bus.on("logs:cleared", onCleared);
    bus.on("config", onConfig);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      bus.off("log", onLog);
      bus.off("logs:cleared", onCleared);
      bus.off("config", onConfig);
    });
  });
}
