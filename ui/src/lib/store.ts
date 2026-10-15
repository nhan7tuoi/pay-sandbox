import { create } from "zustand";
import { API_ROOT, api } from "./api";
import { DEMO_CONFIG, DEMO_LOGS } from "./mock-data";
import type {
  ConfigPatch,
  ConnectionState,
  ProviderFilter,
  ProviderName,
  SandboxConfig,
  SignatureMode,
  WebhookLog,
} from "./types";

const OFFLINE_GRACE_MS = 1_500;
const FILTER_STORAGE_KEY = "pay-sandbox:provider-filter";
const FILTERS: ProviderFilter[] = ["all", "stripe", "momo", "zalopay", "vnpay"];

function readStoredFilter(): ProviderFilter {
  try {
    const stored = window.localStorage.getItem(FILTER_STORAGE_KEY);
    return FILTERS.includes(stored as ProviderFilter) ? (stored as ProviderFilter) : "all";
  } catch {
    return "all";
  }
}

interface SandboxState {
  logs: WebhookLog[];
  config: SandboxConfig | null;
  connection: ConnectionState;
  demo: boolean;
  selectedId: string | null;
  providerFilter: ProviderFilter;
  error: string | null;

  connect: () => () => void;
  select: (id: string | null) => void;
  setProviderFilter: (filter: ProviderFilter) => void;
  selectRelative: (offset: number, visibleIds: string[]) => void;
  dismissError: () => void;
  replay: (id: string) => Promise<void>;
  fire: (provider: ProviderName, payload: Record<string, unknown>, signature: SignatureMode) => Promise<void>;
  trigger: (id: string) => Promise<void>;
  updateProviderSettings: (provider: ProviderName, patch: Record<string, string>) => Promise<void>;
  updateConfig: (patch: ConfigPatch) => Promise<void>;
  clearLogs: () => Promise<void>;
}

function upsert(logs: WebhookLog[], log: WebhookLog): WebhookLog[] {
  const index = logs.findIndex((item) => item.id === log.id);
  if (index === -1) return [log, ...logs];
  const next = logs.slice();
  next[index] = log;
  return next;
}

export const useSandbox = create<SandboxState>((set, get) => {
  /** Wraps an API call so failures surface in the UI instead of being swallowed. */
  const guarded = async (action: () => Promise<void>) => {
    if (get().demo) {
      set({ error: "Start pay-sandbox (npx pay-sandbox) to send real webhooks. You are viewing sample data." });
      return;
    }
    try {
      await action();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  };

  return {
    logs: [],
    config: null,
    connection: "connecting",
    demo: false,
    selectedId: null,
    providerFilter: readStoredFilter(),
    error: null,

    connect: () => {
      const source = new EventSource(`${API_ROOT}/stream`);
      let everConnected = false;

      const offlineTimer = window.setTimeout(() => {
        if (!everConnected) {
          set((state) => ({
            connection: "offline",
            demo: true,
            logs: DEMO_LOGS,
            config: DEMO_CONFIG,
            selectedId: state.selectedId ?? DEMO_LOGS[0]?.id ?? null,
          }));
        }
      }, OFFLINE_GRACE_MS);

      source.addEventListener("snapshot", (message) => {
        everConnected = true;
        window.clearTimeout(offlineTimer);
        const snapshot = JSON.parse(message.data) as { logs: WebhookLog[]; config: SandboxConfig };
        set((state) => {
          const stillExists = snapshot.logs.some((log) => log.id === state.selectedId);
          return {
            connection: "live",
            demo: false,
            logs: snapshot.logs,
            config: snapshot.config,
            selectedId: stillExists
              ? state.selectedId
              : (snapshot.logs.find((log) => state.providerFilter === "all" || log.provider === state.providerFilter)?.id ??
                null),
          };
        });
      });

      source.addEventListener("log", (message) => {
        const log = JSON.parse(message.data) as WebhookLog;
        set((state) => {
          const visible = state.providerFilter === "all" || state.providerFilter === log.provider;
          return { logs: upsert(state.logs, log), selectedId: state.selectedId ?? (visible ? log.id : null) };
        });
      });

      source.addEventListener("cleared", () => set({ logs: [], selectedId: null }));

      source.addEventListener("config", (message) => {
        set({ config: JSON.parse(message.data) as SandboxConfig });
      });

      source.onerror = () => {
        if (everConnected) set({ connection: "connecting" });
      };

      return () => {
        window.clearTimeout(offlineTimer);
        source.close();
      };
    },

    select: (id) => set({ selectedId: id }),

    setProviderFilter: (filter) => {
      try {
        window.localStorage.setItem(FILTER_STORAGE_KEY, filter);
      } catch {
        // Storage can be unavailable (private mode); the filter still applies for this session.
      }
      set((state) => {
        const visible = state.logs.filter((log) => filter === "all" || log.provider === filter);
        const keep = visible.some((log) => log.id === state.selectedId);
        return { providerFilter: filter, selectedId: keep ? state.selectedId : (visible[0]?.id ?? null) };
      });
    },

    selectRelative: (offset, visibleIds) => {
      if (visibleIds.length === 0) return;
      const current = visibleIds.indexOf(get().selectedId ?? "");
      const nextIndex = current === -1 ? 0 : Math.min(Math.max(current + offset, 0), visibleIds.length - 1);
      set({ selectedId: visibleIds[nextIndex] ?? null });
    },

    dismissError: () => set({ error: null }),

    replay: (id) =>
      guarded(async () => {
        await api.replay(id);
      }),

    fire: (provider, payload, signature) =>
      guarded(async () => {
        const log = await api.fire(provider, payload, signature);
        set((state) => ({ logs: upsert(state.logs, log), selectedId: log.id }));
      }),

    trigger: (id) =>
      guarded(async () => {
        await api.trigger(id);
      }),

    updateProviderSettings: (provider, patch) =>
      guarded(async () => {
        const config = await api.updateProviderSettings(provider, patch);
        set({ config });
      }),

    updateConfig: (patch) =>
      guarded(async () => {
        const config = await api.updateConfig(patch);
        set({ config });
      }),

    clearLogs: () =>
      guarded(async () => {
        await api.clearLogs();
      }),
  };
});
