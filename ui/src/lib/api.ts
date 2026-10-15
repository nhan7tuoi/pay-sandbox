import type { ConfigPatch, ProviderName, SandboxConfig, SignatureMode, WebhookLog } from "./types";

export const API_ROOT = "/__sandbox";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: init.body ? { "content-type": "application/json", ...init.headers } : init.headers,
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body ? String(body.error) : response.statusText;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  replay: (logId: string) => request<WebhookLog>(`/logs/${logId}/replay`, { method: "POST" }),

  fire: (provider: ProviderName, payload: Record<string, unknown>, signature: SignatureMode) =>
    request<WebhookLog>("/fire", { method: "POST", body: JSON.stringify({ provider, payload, signature }) }),

  trigger: (id: string) =>
    request<{ trigger: string; objects: Record<string, string> }>("/trigger", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),

  updateProviderSettings: (provider: ProviderName, patch: Record<string, string>) =>
    request<SandboxConfig>(`/providers/${provider}/settings`, { method: "PATCH", body: JSON.stringify(patch) }),

  updateConfig: (patch: ConfigPatch) =>
    request<SandboxConfig>("/config", { method: "PATCH", body: JSON.stringify(patch) }),

  clearLogs: () => request<{ ok: true }>("/logs", { method: "DELETE" }),
};
