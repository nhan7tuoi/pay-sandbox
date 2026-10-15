import { createHmac, timingSafeEqual } from "node:crypto";

export interface SignedPayload {
  timestamp: number;
  signature: string;
  header: string;
}

/**
 * Computes the `Stripe-Signature` header exactly like Stripe does:
 *   signed_payload = `${timestamp}.${rawBody}`
 *   v1 = hex(HMAC_SHA256(secret, signed_payload))
 *
 * The secret is used verbatim (including the `whsec_` prefix), which is what
 * `stripe.webhooks.constructEvent` expects on the receiving side.
 */
export function signPayload(
  rawBody: string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): SignedPayload {
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");

  return {
    timestamp,
    signature,
    header: `t=${timestamp},v1=${signature}`,
  };
}

/**
 * Verifies a `Stripe-Signature` header. Used by the sandbox's own self-test
 * endpoint and handy for consumers who want to avoid the full Stripe SDK.
 */
export function verifySignature(
  rawBody: string,
  header: string,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  const parts = header.split(",").map((part) => part.trim().split("="));
  const timestampPart = parts.find(([key]) => key === "t");
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value ?? "");

  if (!timestampPart?.[1] || signatures.length === 0) return false;

  const timestamp = Number.parseInt(timestampPart[1], 10);
  if (!Number.isFinite(timestamp)) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > toleranceSeconds) return false;

  const expected = Buffer.from(signPayload(rawBody, secret, timestamp).signature, "hex");
  return signatures.some((candidate) => {
    const received = Buffer.from(candidate, "hex");
    return received.length === expected.length && timingSafeEqual(received, expected);
  });
}
