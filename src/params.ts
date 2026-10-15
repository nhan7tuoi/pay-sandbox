import { invalidParam, missingParam } from "./errors.js";
import type { Metadata } from "./types.js";

/**
 * Stripe SDKs send `application/x-www-form-urlencoded` bodies, so every scalar
 * arrives as a string. These helpers coerce and validate them the way the real
 * API does, raising Stripe-shaped errors on bad input.
 */
export type Params = Record<string, unknown>;

export function asParams(value: unknown): Params {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Params)
    : {};
}

export function optionalString(params: Params, key: string): string | null {
  const value = params[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw invalidParam(key, `Invalid string: ${JSON.stringify(value)}`);
  }
  return value;
}

export function requiredString(params: Params, key: string): string {
  const value = optionalString(params, key);
  if (value === null) throw missingParam(key);
  return value;
}

export function optionalInteger(params: Params, key: string): number | null {
  const value = params[key];
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw invalidParam(key, `Invalid integer: ${String(value)}`);
  }
  return parsed;
}

export function requiredInteger(params: Params, key: string): number {
  const value = optionalInteger(params, key);
  if (value === null) throw missingParam(key);
  return value;
}

export function optionalBoolean(params: Params, key: string): boolean | null {
  const value = params[key];
  if (value === undefined || value === null || value === "") return null;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw invalidParam(key, `Invalid boolean: ${String(value)}`);
}

export function optionalStringArray(params: Params, key: string): string[] | null {
  const value = params[key];
  if (value === undefined || value === null || value === "") return null;
  const items = Array.isArray(value) ? value : typeof value === "object" ? Object.values(value) : [value];
  if (!items.every((item): item is string => typeof item === "string")) {
    throw invalidParam(key, `Invalid array of strings for ${key}`);
  }
  return items;
}

export function optionalObjectArray(params: Params, key: string): Params[] | null {
  const value = params[key];
  if (value === undefined || value === null || value === "") return null;
  const items = Array.isArray(value) ? value : typeof value === "object" ? Object.values(value) : null;
  if (!items || !items.every((item) => typeof item === "object" && item !== null)) {
    throw invalidParam(key, `Invalid array for ${key}`);
  }
  return items as Params[];
}

export function readMetadata(params: Params, existing: Metadata = {}): Metadata {
  const value = params.metadata;
  if (value === undefined) return { ...existing };
  if (value === "") return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidParam("metadata", "Invalid metadata: must be a hash of string keys and values.");
  }

  const merged: Metadata = { ...existing };
  for (const [key, raw] of Object.entries(value)) {
    if (raw === "" || raw === null) {
      delete merged[key];
    } else if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      merged[key] = String(raw);
    } else {
      throw invalidParam(`metadata[${key}]`, "Metadata values must be strings.");
    }
  }
  return merged;
}

export function readCurrency(params: Params, key = "currency"): string {
  const currency = requiredString(params, key).toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) {
    throw invalidParam(key, `Invalid currency: ${currency}. Must be a three-letter ISO code.`);
  }
  return currency;
}

export function readListOptions(query: Params): { limit: number; startingAfter?: string } {
  const limit = optionalInteger(query, "limit") ?? 10;
  if (limit < 1 || limit > 100) {
    throw invalidParam("limit", "Invalid limit: must be between 1 and 100.");
  }
  const startingAfter = optionalString(query, "starting_after") ?? undefined;
  return startingAfter ? { limit, startingAfter } : { limit };
}
