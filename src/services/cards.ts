import type { CardDetails } from "../types.js";

export interface DeclineSpec {
  code: string;
  declineCode: string;
  message: string;
}

export type ChargeOutcome =
  | { kind: "success"; card: CardDetails }
  | { kind: "decline"; card: CardDetails; decline: DeclineSpec };

const DECLINES = {
  generic_decline: {
    code: "card_declined",
    declineCode: "generic_decline",
    message: "Your card was declined.",
  },
  insufficient_funds: {
    code: "card_declined",
    declineCode: "insufficient_funds",
    message: "Your card has insufficient funds.",
  },
  expired_card: {
    code: "expired_card",
    declineCode: "expired_card",
    message: "Your card has expired.",
  },
  incorrect_cvc: {
    code: "incorrect_cvc",
    declineCode: "incorrect_cvc",
    message: "Your card's security code is incorrect.",
  },
  processing_error: {
    code: "processing_error",
    declineCode: "processing_error",
    message: "An error occurred while processing your card. Try again in a little bit.",
  },
} satisfies Record<string, DeclineSpec>;

export type DeclineReason = keyof typeof DECLINES;

function card(brand: string, last4: string, funding: "credit" | "debit" = "credit"): CardDetails {
  return {
    brand,
    last4,
    exp_month: 12,
    exp_year: new Date().getFullYear() + 3,
    funding,
    country: "US",
  };
}

/**
 * Mirrors Stripe's documented test PaymentMethods so code written against
 * test mode behaves identically against the sandbox.
 * https://docs.stripe.com/testing#cards
 */
const TEST_PAYMENT_METHODS: Record<string, ChargeOutcome> = {
  pm_card_visa: { kind: "success", card: card("visa", "4242") },
  pm_card_visa_debit: { kind: "success", card: card("visa", "5556", "debit") },
  pm_card_mastercard: { kind: "success", card: card("mastercard", "4444") },
  pm_card_amex: { kind: "success", card: card("amex", "8431") },
  pm_card_chargeDeclined: { kind: "decline", card: card("visa", "0002"), decline: DECLINES.generic_decline },
  pm_card_chargeDeclinedInsufficientFunds: {
    kind: "decline",
    card: card("visa", "9995"),
    decline: DECLINES.insufficient_funds,
  },
  pm_card_chargeDeclinedExpiredCard: {
    kind: "decline",
    card: card("visa", "0069"),
    decline: DECLINES.expired_card,
  },
  pm_card_chargeDeclinedIncorrectCvc: {
    kind: "decline",
    card: card("visa", "0127"),
    decline: DECLINES.incorrect_cvc,
  },
  pm_card_chargeDeclinedProcessingError: {
    kind: "decline",
    card: card("visa", "0119"),
    decline: DECLINES.processing_error,
  },
};

const SUCCESS_ALIASES = new Set(["success", "succeed", "succeeded", "pass"]);
const DECLINE_ALIASES = new Set(["fail", "failed", "failure", "decline", "declined", "card_declined"]);

/**
 * Resolves what happens when a PaymentIntent is confirmed.
 *
 * `forced` comes from the sandbox-only overrides (`sandbox_outcome` body param,
 * `?outcome=` query string or `X-Sandbox-Outcome` header) and wins over the
 * payment method. Accepted values: `success`, `fail`, or any decline reason
 * such as `insufficient_funds`.
 */
export function resolveOutcome(paymentMethod: string, forced: string | null): ChargeOutcome {
  const base = TEST_PAYMENT_METHODS[paymentMethod] ?? { kind: "success", card: card("visa", "4242") };
  if (!forced) return base;

  const normalized = forced.trim().toLowerCase();
  if (SUCCESS_ALIASES.has(normalized)) {
    return { kind: "success", card: base.card };
  }
  if (DECLINE_ALIASES.has(normalized)) {
    return { kind: "decline", card: base.card, decline: DECLINES.generic_decline };
  }
  if (normalized in DECLINES) {
    return { kind: "decline", card: base.card, decline: DECLINES[normalized as DeclineReason] };
  }
  return base;
}

export function isKnownOutcome(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return SUCCESS_ALIASES.has(normalized) || DECLINE_ALIASES.has(normalized) || normalized in DECLINES;
}
