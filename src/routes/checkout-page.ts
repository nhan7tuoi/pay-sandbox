import type { FastifyInstance } from "fastify";
import { StripeError } from "../errors.js";
import { type ServiceContext, completeCheckoutSession } from "../services/payments.js";
import type { CheckoutSession } from "../types.js";

type IdParams = { Params: { id: string } };

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);
}

function withSessionId(url: string, sessionId: string): string {
  return url.replaceAll("{CHECKOUT_SESSION_ID}", sessionId);
}

function renderPage(session: CheckoutSession, notice: string | null): string {
  const isOpen = session.status === "open";
  const total = formatAmount(session.amount_total, session.currency);
  const id = escapeHtml(session.id);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>pay-sandbox · Checkout</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    background: #09090b; color: #fafafa; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  .card { width: 100%; max-width: 400px; border: 1px solid #27272a; border-radius: 16px; background: #18181b; padding: 28px; }
  .badge { display: inline-block; font-size: 11px; letter-spacing: .04em; text-transform: uppercase;
    color: #fbbf24; border: 1px solid #78350f; background: #451a03; border-radius: 999px; padding: 2px 10px; }
  h1 { font-size: 32px; margin: 16px 0 4px; font-weight: 600; letter-spacing: -0.02em; }
  .muted { color: #a1a1aa; }
  code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: #a1a1aa; word-break: break-all; }
  form { margin: 0; }
  .actions { display: grid; gap: 8px; margin-top: 24px; }
  button { width: 100%; border: 0; border-radius: 10px; padding: 11px 16px; font: inherit; font-weight: 500; cursor: pointer; }
  .pay { background: #fafafa; color: #09090b; }
  .pay:hover { background: #e4e4e7; }
  .cancel { background: transparent; color: #a1a1aa; border: 1px solid #27272a; }
  .cancel:hover { color: #fafafa; border-color: #3f3f46; }
  .notice { margin-top: 16px; padding: 10px 12px; border-radius: 10px; background: #27272a; color: #e4e4e7; }
</style>
</head>
<body>
  <main class="card">
    <span class="badge">Sandbox · test mode</span>
    <h1>${escapeHtml(total)}</h1>
    <p class="muted">${session.customer_email ? `Paying as ${escapeHtml(session.customer_email)}` : "Simulated Stripe Checkout"}</p>
    <code>${id}</code>
    ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
    ${
      isOpen
        ? `<div class="actions">
      <form method="post" action="/checkout/${id}/pay"><button class="pay" type="submit">Pay ${escapeHtml(total)}</button></form>
      <form method="post" action="/checkout/${id}/cancel"><button class="cancel" type="submit">Cancel and return</button></form>
    </div>`
        : `<p class="notice">This session is <strong>${escapeHtml(session.status)}</strong>.</p>`
    }
  </main>
</body>
</html>`;
}

/** A minimal stand-in for Stripe's hosted Checkout page, reachable via `session.url`. */
export async function checkoutPageRoutes(app: FastifyInstance, ctx: ServiceContext): Promise<void> {
  app.get<IdParams>("/checkout/:id", async (request, reply) => {
    const session = ctx.store.checkoutSessions.get(request.params.id);
    if (!session) return reply.status(404).type("text/plain").send("Checkout Session not found.");
    return reply.type("text/html").send(renderPage(session, null));
  });

  app.post<IdParams>("/checkout/:id/pay", async (request, reply) => {
    try {
      const session = completeCheckoutSession(ctx, request.params.id, { source: "checkout", requestId: request.id });
      if (session.success_url) {
        return reply.redirect(withSessionId(session.success_url, session.id), 303);
      }
      return reply.type("text/html").send(renderPage(session, "Payment succeeded. No success_url was configured."));
    } catch (error) {
      if (error instanceof StripeError) {
        return reply.status(error.statusCode).type("text/plain").send(error.message);
      }
      throw error;
    }
  });

  app.post<IdParams>("/checkout/:id/cancel", async (request, reply) => {
    const session = ctx.store.checkoutSessions.get(request.params.id);
    if (!session) return reply.status(404).type("text/plain").send("Checkout Session not found.");
    if (session.cancel_url) {
      return reply.redirect(withSessionId(session.cancel_url, session.id), 303);
    }
    return reply.type("text/html").send(renderPage(session, "Checkout canceled. No cancel_url was configured."));
  });
}
