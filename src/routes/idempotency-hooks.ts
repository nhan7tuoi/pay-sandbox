import type { FastifyInstance, FastifyRequest } from "fastify";
import { StripeError } from "../errors.js";
import { type IdempotencyStore, fingerprintRequest, scopeKey } from "../idempotency.js";

const MAX_KEY_LENGTH = 255;

interface IdempotencyState {
  scopedKey: string;
  fingerprint: string;
  cacheable: boolean;
  settled: boolean;
}

const states = new WeakMap<FastifyRequest, IdempotencyState>();

/**
 * Validation errors are not saved, matching Stripe: a request that never
 * started executing can be retried with the same key once it is fixed.
 */
export function markNotCacheable(request: FastifyRequest): void {
  const state = states.get(request);
  if (state) state.cacheable = false;
}

/**
 * Adds Stripe's `Idempotency-Key` semantics to every POST in the plugin scope.
 * `getApiKey` scopes keys per API key the same way Stripe scopes them per account.
 */
export function registerIdempotency(
  app: FastifyInstance,
  store: IdempotencyStore,
  getApiKey: (request: FastifyRequest) => string,
): void {
  app.addHook("preHandler", async (request, reply) => {
    if (request.method !== "POST") return;
    const header = request.headers["idempotency-key"];
    if (typeof header !== "string" || header.length === 0) return;

    if (header.length > MAX_KEY_LENGTH) {
      throw new StripeError(400, {
        type: "invalid_request_error",
        code: "parameter_invalid",
        message: `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters long.`,
      });
    }

    const scopedKey = scopeKey(getApiKey(request), header);
    const fingerprint = fingerprintRequest(request.method, request.url, request.body);
    const result = store.begin(scopedKey, fingerprint);
    reply.header("idempotency-key", header);

    switch (result.kind) {
      case "replay":
        return reply
          .header("idempotent-replayed", "true")
          .status(result.response.statusCode)
          .type(result.response.contentType)
          .send(result.response.body);

      case "mismatch":
        throw new StripeError(400, {
          type: "idempotency_error",
          message:
            `Keys for idempotent requests can only be used with the same parameters they were first used with. ` +
            `Try using a key other than '${header}' if you meant to execute a different request.`,
        });

      case "in_progress":
        throw new StripeError(409, {
          type: "idempotency_error",
          code: "idempotency_key_in_use",
          message:
            `There is currently another in-progress request using this Idempotency-Key '${header}'. ` +
            `Please try again later.`,
        });

      case "acquired":
        states.set(request, { scopedKey, fingerprint, cacheable: true, settled: false });
        return;
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const state = states.get(request);
    if (!state || state.settled) return payload;
    state.settled = true;

    if (state.cacheable && typeof payload === "string") {
      const contentType = reply.getHeader("content-type");
      store.complete(state.scopedKey, {
        fingerprint: state.fingerprint,
        method: request.method,
        path: request.url,
        statusCode: reply.statusCode,
        contentType: typeof contentType === "string" ? contentType : "application/json; charset=utf-8",
        body: payload,
      });
    } else {
      store.release(state.scopedKey);
    }
    return payload;
  });

  const releaseUnsettled = async (request: FastifyRequest) => {
    const state = states.get(request);
    if (state && !state.settled) {
      state.settled = true;
      store.release(state.scopedKey);
    }
  };
  app.addHook("onResponse", releaseUnsettled);
  app.addHook("onRequestAbort", releaseUnsettled);
}
