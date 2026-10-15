import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Generates a Stripe-style identifier such as `pi_3QxR8f2eZvKYlo2C1a2b3c4d`. */
export function generateId(prefix: string, length = 24): string {
  const bytes = randomBytes(length);
  let body = "";
  for (const byte of bytes) {
    body += ALPHABET[byte % ALPHABET.length];
  }
  return `${prefix}_${body}`;
}

/** Current Unix timestamp in seconds, which is how Stripe represents `created`. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
