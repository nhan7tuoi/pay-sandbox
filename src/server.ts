import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import qs from "qs";
import { SandboxBus } from "./bus.js";
import { type SandboxConfig, resolveConfig } from "./config.js";
import { generateId } from "./ids.js";
import { MomoProvider } from "./providers/momo.js";
import { ProviderRegistry } from "./providers/registry.js";
import { StripeProvider } from "./providers/stripe.js";
import { VnpayProvider } from "./providers/vnpay.js";
import { ZaloPayProvider } from "./providers/zalopay.js";
import { sandboxRoutes } from "./routes/sandbox.js";
import type { ServiceContext } from "./services/payments.js";
import { MemoryStore } from "./store.js";
import { WebhookDispatcher } from "./webhook/dispatcher.js";

/** Resolves `ui/dist` both from `src/` (tsx) and from the compiled `dist/` folder. */
const UI_DIST = fileURLToPath(new URL("../ui/dist/", import.meta.url));

/** Requests under these paths are reported through `onApiRequest`. */
const GATEWAY_PREFIXES = ["/v1/", "/momo/", "/zalopay/", "/vnpay/"];

const QS_OPTIONS: qs.IParseOptions = { depth: 10, arrayLimit: 1_000, parameterLimit: 10_000 };

export interface SandboxServer {
  app: FastifyInstance;
  store: MemoryStore;
  bus: SandboxBus;
  dispatcher: WebhookDispatcher;
  providers: ProviderRegistry;
  config: SandboxConfig;
}

export interface BuildOptions {
  config?: Partial<SandboxConfig>;
  /** Called after every gateway API request (Stripe /v1, MoMo, ZaloPay, VNPay) with method, url, status and duration. */
  onApiRequest?: (line: { method: string; url: string; statusCode: number; durationMs: number }) => void;
}

export async function buildServer(options: BuildOptions = {}): Promise<SandboxServer> {
  const config = resolveConfig(options.config);
  const store = new MemoryStore();
  const bus = new SandboxBus();
  const providers = new ProviderRegistry();
  const dispatcher = new WebhookDispatcher(config, store, bus, providers);
  const ctx: ServiceContext = { store, dispatcher, config };

  providers.register(new StripeProvider(ctx));
  providers.register(new MomoProvider({ config, dispatcher }));
  providers.register(new ZaloPayProvider({ config, dispatcher }));
  providers.register(new VnpayProvider({ config, dispatcher }));

  const app = Fastify({
    logger: false,
    forceCloseConnections: true,
    genReqId: () => generateId("req", 14),
    routerOptions: {
      querystringParser: (query: string) => qs.parse(query, QS_OPTIONS),
    },
  });

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        done(null, qs.parse(body as string, QS_OPTIONS));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  if (options.onApiRequest) {
    const report = options.onApiRequest;
    app.addHook("onResponse", async (request, reply) => {
      if (!GATEWAY_PREFIXES.some((prefix) => request.url.startsWith(prefix))) return;
      report({
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      });
    });
  }

  for (const provider of providers.all()) {
    await provider.registerRoutes(app);
  }
  await app.register((instance) => sandboxRoutes(instance, { ...ctx, bus, providers }), { prefix: "/__sandbox" });

  if (existsSync(UI_DIST)) {
    await app.register(fastifyStatic, { root: UI_DIST, prefix: "/dashboard/" });
  } else {
    app.get("/dashboard/*", (_request, reply) =>
      reply
        .type("text/html")
        .send(
          "<p style=\"font-family:system-ui\">Dashboard not built yet. Run <code>npm run build:ui</code> " +
            "or use <code>npm run dev</code> and open the Vite URL.</p>",
        ),
    );
  }

  app.get("/", (_request, reply) => reply.redirect("/dashboard/"));
  app.get("/dashboard", (_request, reply) => reply.redirect("/dashboard/"));

  app.addHook("onClose", async () => {
    await dispatcher.close();
    store.idempotency.dispose();
  });

  return { app, store, bus, dispatcher, providers, config };
}
