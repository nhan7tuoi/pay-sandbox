import { StripeError } from "../errors.js";
import {
  type ServiceContext,
  completeCheckoutSession,
  confirmPaymentIntent,
  createCheckoutSession,
  createCustomer,
  createDispute,
  createPaymentIntent,
  createRefund,
} from "./payments.js";

export interface TriggerResult {
  trigger: string;
  objects: Record<string, string>;
}

type TriggerFn = (ctx: ServiceContext, baseUrl: string) => TriggerResult;

const meta = { source: "trigger" } as const;

function succeededPaymentIntent(ctx: ServiceContext) {
  const paymentIntent = createPaymentIntent(
    ctx,
    {
      amount: "2000",
      currency: "usd",
      description: "pay-sandbox quick trigger",
      payment_method: "pm_card_visa",
      metadata: { sandbox_trigger: "true" },
    },
    meta,
  );
  return confirmPaymentIntent(ctx, paymentIntent.id, {}, meta);
}

/**
 * Fixtures behind the dashboard's Quick Trigger menu. Each one drives the real
 * state machine, so the objects referenced in the webhook exist and can be
 * retrieved with `GET /v1/...` afterwards.
 */
export const TRIGGERS: Record<string, TriggerFn> = {
  "customer.created": (ctx) => {
    const customer = createCustomer(
      ctx,
      { email: "jenny.rosen@example.com", name: "Jenny Rosen", metadata: { sandbox_trigger: "true" } },
      meta,
    );
    return { trigger: "customer.created", objects: { customer: customer.id } };
  },

  "payment_intent.succeeded": (ctx) => {
    const paymentIntent = succeededPaymentIntent(ctx);
    return {
      trigger: "payment_intent.succeeded",
      objects: { payment_intent: paymentIntent.id, charge: paymentIntent.latest_charge ?? "" },
    };
  },

  "payment_intent.payment_failed": (ctx) => {
    const paymentIntent = createPaymentIntent(
      ctx,
      {
        amount: "2000",
        currency: "usd",
        description: "pay-sandbox quick trigger",
        payment_method: "pm_card_chargeDeclined",
        metadata: { sandbox_trigger: "true" },
      },
      meta,
    );
    try {
      confirmPaymentIntent(ctx, paymentIntent.id, {}, meta);
    } catch (error) {
      if (!(error instanceof StripeError) || error.statusCode !== 402) throw error;
    }
    return {
      trigger: "payment_intent.payment_failed",
      objects: { payment_intent: paymentIntent.id, charge: paymentIntent.latest_charge ?? "" },
    };
  },

  "checkout.session.completed": (ctx, baseUrl) => {
    const session = createCheckoutSession(
      ctx,
      {
        mode: "payment",
        success_url: "http://localhost:3000/success",
        cancel_url: "http://localhost:3000/cancel",
        customer_email: "jenny.rosen@example.com",
        metadata: { sandbox_trigger: "true" },
        line_items: [
          {
            quantity: "1",
            price_data: { currency: "usd", unit_amount: "4900", product_data: { name: "Pro plan" } },
          },
        ],
      },
      baseUrl,
    );
    const completed = completeCheckoutSession(ctx, session.id, meta);
    return {
      trigger: "checkout.session.completed",
      objects: { checkout_session: completed.id, payment_intent: completed.payment_intent ?? "" },
    };
  },

  "charge.refunded": (ctx) => {
    const paymentIntent = succeededPaymentIntent(ctx);
    const refund = createRefund(
      ctx,
      { payment_intent: paymentIntent.id, amount: "500", reason: "requested_by_customer" },
      meta,
    );
    return {
      trigger: "charge.refunded",
      objects: { payment_intent: paymentIntent.id, charge: refund.charge, refund: refund.id },
    };
  },

  "charge.dispute.created": (ctx) => {
    const paymentIntent = succeededPaymentIntent(ctx);
    const dispute = createDispute(ctx, paymentIntent.latest_charge ?? "", "fraudulent", meta);
    return {
      trigger: "charge.dispute.created",
      objects: { payment_intent: paymentIntent.id, charge: dispute.charge, dispute: dispute.id },
    };
  },
};

export const TRIGGER_NAMES = Object.keys(TRIGGERS);
