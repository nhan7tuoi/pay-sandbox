/**
 * End-to-end check that pay-sandbox is a drop-in target for the official
 * `stripe` SDK and that its webhooks pass `stripe.webhooks.constructEvent`.
 *
 *   Terminal 1:  npm run dev:server
 *   Terminal 2:  npm run test:client
 *
 * This script plays the role of "your app": it starts a webhook receiver on
 * http://localhost:3000/api/webhook (the sandbox default) and drives the
 * sandbox through the Stripe SDK.
 *
 * The receiver deliberately answers 500 to the first delivery of every
 * `refund.created` event to prove that the sandbox retries automatically.
 */
import { createServer, type IncomingMessage } from "node:http";
import Stripe from "stripe";

const SANDBOX_PORT = Number(process.env.PAY_SANDBOX_PORT ?? 4242);
const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT ?? 3000);
const WEBHOOK_SECRET = process.env.PAY_SANDBOX_WEBHOOK_SECRET ?? "whsec_test_sandbox_secret";
const WAIT_TIMEOUT_MS = 10_000;

const stripe = new Stripe("sk_test_sandbox", {
  host: "localhost",
  port: SANDBOX_PORT,
  protocol: "http",
  maxNetworkRetries: 2,
});

type Waiter = { type: string; matches: (event: Stripe.Event) => boolean; resolve: (event: Stripe.Event) => void };

const received: Stripe.Event[] = [];
const waiters: Waiter[] = [];
let signatureFailures = 0;
const deliveriesByEventId = new Map<string, number>();
const FAIL_FIRST_DELIVERY_OF = new Set(["refund.created"]);
let lastRawBody: { body: string; signature: string } | null = null;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const receiver = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/api/webhook") {
    response.writeHead(404).end();
    return;
  }

  const rawBody = await readBody(request);
  const signature = request.headers["stripe-signature"];

  try {
    if (typeof signature !== "string") throw new Error("Missing Stripe-Signature header");
    const event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
    lastRawBody = { body: rawBody, signature };

    const deliveryCount = (deliveriesByEventId.get(event.id) ?? 0) + 1;
    deliveriesByEventId.set(event.id, deliveryCount);
    if (FAIL_FIRST_DELIVERY_OF.has(event.type) && deliveryCount === 1) {
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "simulated outage" }));
      return;
    }

    received.push(event);

    for (const waiter of [...waiters]) {
      if (waiter.type === event.type && waiter.matches(event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }

    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ received: true }));
  } catch (error) {
    signatureFailures += 1;
    const message = error instanceof Error ? error.message : String(error);
    response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
  }
});

function waitForEvent(type: string, objectId: string): Promise<Stripe.Event> {
  const matches = (event: Stripe.Event) => (event.data.object as { id?: string }).id === objectId;
  const already = received.find((event) => event.type === type && matches(event));
  if (already) return Promise.resolve(already);

  return new Promise((resolve, reject) => {
    const waiter: Waiter = { type, matches, resolve };
    waiters.push(waiter);
    setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index !== -1) {
        waiters.splice(index, 1);
        reject(new Error(`Timed out after ${WAIT_TIMEOUT_MS}ms waiting for ${type} on ${objectId}`));
      }
    }, WAIT_TIMEOUT_MS);
  });
}

let failures = 0;
async function step(name: string, run: () => Promise<void>): Promise<void> {
  const startedAt = performance.now();
  try {
    await run();
    console.log(`  \x1b[32m✓\x1b[0m ${name} \x1b[2m${Math.round(performance.now() - startedAt)}ms\x1b[0m`);
  } catch (error) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    \x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(WEBHOOK_PORT, resolve);
  });

  console.log(`\npay-sandbox test client`);
  console.log(`\x1b[2m  sandbox  http://localhost:${SANDBOX_PORT}/v1\n  receiver http://localhost:${WEBHOOK_PORT}/api/webhook\x1b[0m\n`);

  let customer: Stripe.Customer | undefined;
  let succeededIntent: Stripe.PaymentIntent | undefined;

  await step("create a customer", async () => {
    customer = await stripe.customers.create({
      email: "jenny.rosen@example.com",
      name: "Jenny Rosen",
      metadata: { plan: "pro" },
    });
    assert(customer.id.startsWith("cus_"), `unexpected customer id ${customer.id}`);
    assert(customer.metadata.plan === "pro", "metadata was not persisted");
  });

  await step("create a PaymentIntent in requires_payment_method", async () => {
    succeededIntent = await stripe.paymentIntents.create({
      amount: 2000,
      currency: "usd",
      customer: customer?.id,
      metadata: { order_id: "order_42" },
    });
    assert(
      succeededIntent.status === "requires_payment_method",
      `expected requires_payment_method, got ${succeededIntent.status}`,
    );
    assert(succeededIntent.client_secret?.startsWith(`${succeededIntent.id}_secret_`), "client_secret format");
  });

  await step("confirm with pm_card_visa → succeeded", async () => {
    assert(succeededIntent, "previous step failed");
    const confirmed = await stripe.paymentIntents.confirm(succeededIntent.id, { payment_method: "pm_card_visa" });
    assert(confirmed.status === "succeeded", `expected succeeded, got ${confirmed.status}`);
    assert(confirmed.amount_received === 2000, "amount_received should equal amount");
  });

  await step("receive a verified payment_intent.succeeded webhook", async () => {
    assert(succeededIntent, "previous step failed");
    const event = await waitForEvent("payment_intent.succeeded", succeededIntent.id);
    const object = event.data.object as Stripe.PaymentIntent;
    assert(object.metadata.order_id === "order_42", "webhook payload lost metadata");
  });

  await step("retrieve returns the persisted state", async () => {
    assert(succeededIntent, "previous step failed");
    const retrieved = await stripe.paymentIntents.retrieve(succeededIntent.id);
    assert(retrieved.status === "succeeded", `retrieved status ${retrieved.status}`);
    assert(typeof retrieved.latest_charge === "string", "latest_charge should be set");
    const charge = await stripe.charges.retrieve(retrieved.latest_charge);
    assert(charge.paid && charge.payment_method_details?.card?.last4 === "4242", "charge details mismatch");
  });

  let declinedIntentId = "";
  await step("confirm with pm_card_chargeDeclined → StripeCardError card_declined", async () => {
    const intent = await stripe.paymentIntents.create({ amount: 1500, currency: "usd" });
    declinedIntentId = intent.id;
    try {
      await stripe.paymentIntents.confirm(intent.id, { payment_method: "pm_card_chargeDeclined" });
      throw new Error("confirm should have thrown");
    } catch (error) {
      assert(error instanceof Stripe.errors.StripeCardError, `expected StripeCardError, got ${String(error)}`);
      assert(error.code === "card_declined", `expected card_declined, got ${error.code}`);
    }
  });

  await step("receive a verified payment_intent.payment_failed webhook", async () => {
    const event = await waitForEvent("payment_intent.payment_failed", declinedIntentId);
    const object = event.data.object as Stripe.PaymentIntent;
    assert(object.last_payment_error?.code === "card_declined", "last_payment_error missing on webhook");
  });

  await step("force failure with sandbox_outcome=insufficient_funds", async () => {
    const intent = await stripe.paymentIntents.create({ amount: 900, currency: "eur" });
    try {
      await stripe.paymentIntents.confirm(intent.id, {
        payment_method: "pm_card_visa",
        sandbox_outcome: "insufficient_funds",
      } as Stripe.PaymentIntentConfirmParams);
      throw new Error("confirm should have thrown");
    } catch (error) {
      assert(error instanceof Stripe.errors.StripeCardError, `expected StripeCardError, got ${String(error)}`);
      assert(error.decline_code === "insufficient_funds", `got decline_code ${error.decline_code}`);
    }
  });

  const idempotencyKey = `order-77-${Date.now()}`;
  let idempotentIntentId = "";
  await step("same Idempotency-Key returns the cached response", async () => {
    const first = await stripe.paymentIntents.create({ amount: 7700, currency: "usd" }, { idempotencyKey });
    const second = await stripe.paymentIntents.create({ amount: 7700, currency: "usd" }, { idempotencyKey });
    idempotentIntentId = first.id;
    assert(first.id === second.id, `expected the same PaymentIntent, got ${first.id} and ${second.id}`);
    assert(second.lastResponse.headers["idempotent-replayed"] === "true", "missing Idempotent-Replayed header");
  });

  await step("idempotent replay does not fire a duplicate webhook", async () => {
    await waitForEvent("payment_intent.created", idempotentIntentId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const created = received.filter(
      (event) => event.type === "payment_intent.created" && (event.data.object as { id: string }).id === idempotentIntentId,
    );
    assert(created.length === 1, `expected 1 payment_intent.created webhook, got ${created.length}`);
  });

  await step("reusing a key with different params → StripeIdempotencyError", async () => {
    try {
      await stripe.paymentIntents.create({ amount: 9999, currency: "usd" }, { idempotencyKey });
      throw new Error("request should have been rejected");
    } catch (error) {
      assert(error instanceof Stripe.errors.StripeIdempotencyError, `expected StripeIdempotencyError, got ${String(error)}`);
    }
  });

  let refundId = "";
  let refundedChargeId = "";
  await step("partial refund updates the charge, PaymentIntent stays succeeded", async () => {
    assert(succeededIntent, "previous step failed");
    const refund = await stripe.refunds.create({ payment_intent: succeededIntent.id, amount: 500 });
    refundId = refund.id;
    refundedChargeId = refund.charge as string;
    assert(refund.status === "succeeded" && refund.amount === 500, "unexpected refund state");
    const charge = await stripe.charges.retrieve(refund.charge as string);
    assert(charge.amount_refunded === 500 && charge.refunded === false, "charge.amount_refunded not updated");
    const intent = await stripe.paymentIntents.retrieve(succeededIntent.id);
    assert(intent.status === "succeeded", `PaymentIntent status changed to ${intent.status}`);
  });

  await step("receive a verified charge.refunded webhook with previous_attributes", async () => {
    assert(refundedChargeId, "previous step failed");
    const event = await waitForEvent("charge.refunded", refundedChargeId);
    const previous = event.data.previous_attributes as { amount_refunded?: number } | undefined;
    assert(previous?.amount_refunded === 0, "previous_attributes.amount_refunded should be 0");
  });

  await step("refunding more than the remaining amount is rejected", async () => {
    assert(succeededIntent, "previous step failed");
    try {
      await stripe.refunds.create({ payment_intent: succeededIntent.id, amount: 1600 });
      throw new Error("refund should have been rejected");
    } catch (error) {
      assert(error instanceof Stripe.errors.StripeInvalidRequestError, `got ${String(error)}`);
      assert(error.code === "amount_too_large", `expected amount_too_large, got ${error.code}`);
    }
  });

  await step("a webhook answered with 500 is retried automatically (~3s)", async () => {
    const event = await waitForEvent("refund.created", refundId);
    const attempts = deliveriesByEventId.get(event.id) ?? 0;
    assert(attempts === 2, `expected 2 deliveries of ${event.id}, got ${attempts}`);
  });

  await step("a wrong secret is rejected by constructEvent", async () => {
    assert(lastRawBody, "no webhook received yet");
    const { body, signature } = lastRawBody;
    try {
      stripe.webhooks.constructEvent(body, signature, "whsec_wrong_secret");
      throw new Error("constructEvent accepted a wrong secret");
    } catch (error) {
      assert(
        error instanceof Stripe.errors.StripeSignatureVerificationError,
        `expected StripeSignatureVerificationError, got ${String(error)}`,
      );
    }
  });

  await step("every delivered webhook passed signature verification", async () => {
    assert(signatureFailures === 0, `${signatureFailures} webhook(s) failed verification`);
    assert(received.length > 0, "no webhooks were received");
  });

  console.log(`\n  ${received.length} webhooks verified: ${[...new Set(received.map((event) => event.type))].join(", ")}`);
  console.log(failures === 0 ? "\n\x1b[32mAll checks passed.\x1b[0m\n" : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);

  receiver.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  const cause = error instanceof Error ? error.message : String(error);
  console.error(`\x1b[31mtest-client crashed: ${cause}\x1b[0m`);
  console.error("Is pay-sandbox running? Start it with `npm run dev:server`.");
  process.exit(1);
});
