import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { WebhookDelivery, WebhookLog } from "./types";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function latestDelivery(log: WebhookLog): WebhookDelivery | undefined {
  return log.deliveries.at(-1);
}

export type DeliveryTone = "pending" | "success" | "warning" | "danger";

/** Colors a delivery by whether the provider accepted the answer, not just by HTTP status. */
export function deliveryTone(delivery: WebhookDelivery | undefined): DeliveryTone {
  if (!delivery) return "pending";
  if (delivery.ok) return "success";
  if (delivery.statusCode === null || delivery.statusCode >= 500) return "danger";
  return "warning";
}

export function deliveryLabel(delivery: WebhookDelivery | undefined): string {
  if (!delivery) return "…";
  return delivery.statusCode === null ? "ERR" : String(delivery.statusCode);
}

export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatRelative(timestamp: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Pretty-prints a response body when it is JSON, otherwise returns it untouched. */
export function prettyMaybeJson(text: string): { text: string; isJson: boolean } {
  try {
    return { text: prettyJson(JSON.parse(text)), isJson: true };
  } catch {
    return { text, isJson: false };
  }
}

export interface RetryInfo {
  tone: "warning" | "danger";
  label: string;
  nextRetryAt: number | null;
}

/**
 * Human-readable retry state for a webhook log, e.g. `Failed (Retrying 2/3…)`
 * or `Failed (Max retries exceeded)`. Returns null when there is nothing to say.
 */
export function retryInfo(log: WebhookLog): RetryInfo | null {
  if (log.status === "retrying") {
    return {
      tone: "warning",
      label: `Failed (Retrying ${log.attempt_count}/${log.max_retries}…)`,
      nextRetryAt: log.next_retry_at,
    };
  }
  if (log.status === "pending" && log.attempt_count > 1) {
    return { tone: "warning", label: `Retrying ${log.attempt_count - 1}/${log.max_retries}…`, nextRetryAt: null };
  }
  if (log.status === "failed") {
    if (log.max_retries === 0) return { tone: "danger", label: "Failed (Auto-retry off)", nextRetryAt: null };
    if (log.attempt_count > log.max_retries) {
      return { tone: "danger", label: "Failed (Max retries exceeded)", nextRetryAt: null };
    }
    return { tone: "danger", label: "Failed (Retries canceled)", nextRetryAt: null };
  }
  return null;
}

export function isFailedLog(log: WebhookLog): boolean {
  return log.status === "failed" || log.status === "retrying";
}

export function formatCountdown(targetMs: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((targetMs - now) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
