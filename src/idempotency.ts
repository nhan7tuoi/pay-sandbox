import { createHash } from "node:crypto";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export interface CachedResponse {
  fingerprint: string;
  method: string;
  path: string;
  statusCode: number;
  contentType: string;
  body: string;
  createdAt: number;
  expiresAt: number;
}

export type BeginResult =
  | { kind: "acquired" }
  | { kind: "replay"; response: CachedResponse }
  | { kind: "mismatch"; response: CachedResponse }
  | { kind: "in_progress" };

/**
 * In-memory implementation of Stripe's idempotency layer.
 *
 * The first request with a given key executes and its response is saved for
 * 24 hours. Later requests with the same key and identical parameters get the
 * saved response back verbatim; the handler never runs again, so no records
 * are created and no webhooks are fired. Reusing a key with different
 * parameters is rejected, and a concurrent request with a key that is still
 * executing is rejected with 409.
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, CachedResponse>();
  private readonly inProgress = new Map<string, string>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly ttlMs: number = IDEMPOTENCY_TTL_MS) {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  begin(scopedKey: string, fingerprint: string): BeginResult {
    const cached = this.get(scopedKey);
    if (cached) {
      return cached.fingerprint === fingerprint ? { kind: "replay", response: cached } : { kind: "mismatch", response: cached };
    }
    if (this.inProgress.has(scopedKey)) return { kind: "in_progress" };
    this.inProgress.set(scopedKey, fingerprint);
    return { kind: "acquired" };
  }

  complete(scopedKey: string, response: Omit<CachedResponse, "createdAt" | "expiresAt">): void {
    const now = Date.now();
    this.entries.set(scopedKey, { ...response, createdAt: now, expiresAt: now + this.ttlMs });
    this.inProgress.delete(scopedKey);
  }

  /** Releases the lock without saving, e.g. for validation errors or aborted requests. */
  release(scopedKey: string): void {
    this.inProgress.delete(scopedKey);
  }

  get(scopedKey: string): CachedResponse | undefined {
    const entry = this.entries.get(scopedKey);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(scopedKey);
      return undefined;
    }
    return entry;
  }

  sweep(now: number = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.inProgress.clear();
  }

  dispose(): void {
    clearInterval(this.sweeper);
    this.clear();
  }
}

/** Keys are scoped per API key, like Stripe scopes them per account. */
export function scopeKey(apiKey: string, idempotencyKey: string): string {
  return `${apiKey}\u0000${idempotencyKey}`;
}

/** Hash of method, path and parameters, insensitive to parameter order. */
export function fingerprintRequest(method: string, path: string, body: unknown): string {
  return createHash("sha256").update(`${method} ${path}\n${stableStringify(body ?? {})}`).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
