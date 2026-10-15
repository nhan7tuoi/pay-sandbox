import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StripeError, invalidParam, resourceMissing } from "../errors.js";
import { asParams, readListOptions } from "../params.js";
import { isKnownOutcome } from "../services/cards.js";
import {
  type RequestMeta,
  type ServiceContext,
  cancelPaymentIntent,
  confirmPaymentIntent,
  createCheckoutSession,
  createCustomer,
  createPaymentIntent,
  createRefund,
  expireCheckoutSession,
  updateCustomer,
  updatePaymentIntent,
} from "../services/payments.js";
import type { Collection } from "../store.js";
import { markNotCacheable, registerIdempotency } from "./idempotency-hooks.js";

type IdParams = { Params: { id: string } };
type ResourceParams = { Params: { resource: string; id?: string } };

/** Query keys that may be used to filter list endpoints, e.g. `?customer=cus_123`. */
const LIST_FILTER_KEYS = ["customer", "payment_intent", "charge", "type", "status"] as const;

export function requestBaseUrl(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}`;
}

function requestMeta(request: FastifyRequest): RequestMeta {
  const params = asParams(request.body);
  const query = asParams(request.query);
  const header = request.headers["x-sandbox-outcome"];

  const forced =
    (typeof params.sandbox_outcome === "string" && params.sandbox_outcome) ||
    (typeof query.outcome === "string" && query.outcome) ||
    (typeof header === "string" && header) ||
    null;

  if (forced !== null && !isKnownOutcome(forced)) {
    throw invalidParam(
      "sandbox_outcome",
      `Unknown sandbox outcome '${forced}'. Use success, fail, insufficient_funds, expired_card, incorrect_cvc or processing_error.`,
    );
  }

  const idempotencyKey = request.headers["idempotency-key"];
  return {
    requestId: request.id,
    idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : null,
    source: "api",
    forcedOutcome: forced,
  };
}

export async function stripeRoutes(app: FastifyInstance, ctx: ServiceContext): Promise<void> {
  const { store, config } = ctx;

  const collections: Record<string, { name: string; collection: Collection<{ id: string }> }> = {
    customers: { name: "customer", collection: store.customers },
    payment_intents: { name: "payment_intent", collection: store.paymentIntents },
    charges: { name: "charge", collection: store.charges },
    refunds: { name: "refund", collection: store.refunds },
    disputes: { name: "dispute", collection: store.disputes },
    events: { name: "event", collection: store.events },
  };

  app.addHook("onRequest", async (request, reply) => {
    reply.header("request-id", request.id);
    reply.header("stripe-version", config.apiVersion);

    if (!readApiKey(request.headers.authorization)) {
      throw new StripeError(401, {
        type: "invalid_request_error",
        message:
          "You did not provide an API key. pay-sandbox accepts any key, e.g. 'Authorization: Bearer sk_test_sandbox'.",
      });
    }

    if (config.chaos.api.enabled) {
      const { minDelayMs, maxDelayMs, errorRate } = config.chaos.api;
      const delay = minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
      if (delay > 0) await sleep(Math.round(delay));
      if (Math.random() < errorRate) {
        throw new StripeError(500, {
          type: "api_error",
          message: "Chaos Mode: simulated internal server error from pay-sandbox. Retry the request.",
        });
      }
    }
  });

  registerIdempotency(app, store.idempotency, (request) => readApiKey(request.headers.authorization));

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof StripeError) {
      if (error.body.code?.startsWith("parameter_")) markNotCacheable(request);
      return reply.status(error.statusCode).send(error.toJSON());
    }
    const status = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (status >= 400 && status < 500) {
      return reply.status(status).send({ error: { type: "invalid_request_error", message } });
    }
    request.log.error(error);
    return reply.status(500).send({ error: { type: "api_error", message } });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        type: "invalid_request_error",
        message: `Unrecognized request URL (${request.method}: ${request.url}). pay-sandbox does not mock this endpoint yet.`,
      },
    });
  });

  const reply200 = (reply: FastifyReply, body: unknown) => reply.status(200).send(body);

  /* ------------------------------- Customers ------------------------------- */

  app.post("/customers", async (request, reply) =>
    reply200(reply, createCustomer(ctx, asParams(request.body), requestMeta(request))),
  );

  app.post<IdParams>("/customers/:id", async (request, reply) =>
    reply200(reply, updateCustomer(ctx, request.params.id, asParams(request.body), requestMeta(request))),
  );

  /* ---------------------------- PaymentIntents ----------------------------- */

  app.post("/payment_intents", async (request, reply) =>
    reply200(reply, createPaymentIntent(ctx, asParams(request.body), requestMeta(request))),
  );

  app.post<IdParams>("/payment_intents/:id", async (request, reply) =>
    reply200(reply, updatePaymentIntent(ctx, request.params.id, asParams(request.body), requestMeta(request))),
  );

  app.post<IdParams>("/payment_intents/:id/confirm", async (request, reply) =>
    reply200(reply, confirmPaymentIntent(ctx, request.params.id, asParams(request.body), requestMeta(request))),
  );

  app.post<IdParams>("/payment_intents/:id/cancel", async (request, reply) =>
    reply200(reply, cancelPaymentIntent(ctx, request.params.id, asParams(request.body), requestMeta(request))),
  );

  /* -------------------------------- Refunds -------------------------------- */

  app.post("/refunds", async (request, reply) =>
    reply200(reply, createRefund(ctx, asParams(request.body), requestMeta(request))),
  );

  /* --------------------------- Checkout Sessions --------------------------- */

  app.post("/checkout/sessions", async (request, reply) =>
    reply200(reply, createCheckoutSession(ctx, asParams(request.body), requestBaseUrl(request))),
  );

  app.get("/checkout/sessions", async (request, reply) => {
    const query = asParams(request.query);
    return reply200(
      reply,
      store.checkoutSessions.list("/v1/checkout/sessions", {
        ...readListOptions(query),
        filter: buildFilter(query),
      }),
    );
  });

  app.get<IdParams>("/checkout/sessions/:id", async (request, reply) => {
    const session = store.checkoutSessions.get(request.params.id);
    if (!session) throw resourceMissing("checkout.session", request.params.id);
    return reply200(reply, session);
  });

  app.post<IdParams>("/checkout/sessions/:id/expire", async (request, reply) =>
    reply200(reply, expireCheckoutSession(ctx, request.params.id, requestMeta(request))),
  );

  /* ------------------------ Generic retrieve & list ------------------------ */

  app.get<ResourceParams>("/:resource", async (request, reply) => {
    const entry = collections[request.params.resource];
    if (!entry) return reply.callNotFound();
    const query = asParams(request.query);
    return reply200(
      reply,
      entry.collection.list(`/v1/${request.params.resource}`, {
        ...readListOptions(query),
        filter: buildFilter(query),
      }),
    );
  });

  app.get<ResourceParams>("/:resource/:id", async (request, reply) => {
    const entry = collections[request.params.resource];
    if (!entry) return reply.callNotFound();
    const id = request.params.id ?? "";
    const item = entry.collection.get(id);
    if (!item) throw resourceMissing(entry.name, id);
    return reply200(reply, item);
  });
}

/** Accepts `Bearer sk_...` (SDKs) and `Basic base64(sk_...:)` (`curl -u sk_test_...:`), like Stripe. */
function readApiKey(authorization: string | undefined): string {
  if (!authorization) return "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  if (authorization.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
    return decoded.split(":")[0]?.trim() ?? "";
  }
  return "";
}

function buildFilter(query: Record<string, unknown>): ((item: object) => boolean) | undefined {
  const active = LIST_FILTER_KEYS.filter((key) => typeof query[key] === "string" && query[key] !== "");
  if (active.length === 0) return undefined;
  return (item) => active.every((key) => (item as Record<string, unknown>)[key] === query[key]);
}
