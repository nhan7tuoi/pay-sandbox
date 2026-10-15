export type StripeErrorType =
  | "api_error"
  | "card_error"
  | "idempotency_error"
  | "invalid_request_error";

export interface StripeErrorBody {
  type: StripeErrorType;
  message: string;
  code?: string;
  decline_code?: string;
  param?: string;
  doc_url?: string;
  payment_intent?: unknown;
  charge?: string;
}

/** An error that serializes to Stripe's `{ "error": { ... } }` wire format. */
export class StripeError extends Error {
  readonly statusCode: number;
  readonly body: StripeErrorBody;

  constructor(statusCode: number, body: StripeErrorBody) {
    super(body.message);
    this.name = "StripeError";
    this.statusCode = statusCode;
    this.body = body;
  }

  toJSON(): { error: StripeErrorBody } {
    return { error: this.body };
  }
}

export function missingParam(param: string): StripeError {
  return new StripeError(400, {
    type: "invalid_request_error",
    code: "parameter_missing",
    param,
    message: `Missing required param: ${param}.`,
    doc_url: "https://stripe.com/docs/error-codes/parameter-missing",
  });
}

export function invalidParam(param: string, message: string): StripeError {
  return new StripeError(400, {
    type: "invalid_request_error",
    code: "parameter_invalid",
    param,
    message,
  });
}

export function resourceMissing(resource: string, id: string, param = "id"): StripeError {
  return new StripeError(404, {
    type: "invalid_request_error",
    code: "resource_missing",
    param,
    message: `No such ${resource}: '${id}'`,
    doc_url: "https://stripe.com/docs/error-codes/resource-missing",
  });
}
