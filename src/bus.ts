import { EventEmitter } from "node:events";
import type { SandboxConfig } from "./config.js";
import type { WebhookLog } from "./types.js";

export interface BusEvents {
  log: [WebhookLog];
  "logs:cleared": [];
  config: [SandboxConfig];
}

/** Typed in-process pub/sub used to fan out updates to SSE subscribers. */
export class SandboxBus extends EventEmitter<BusEvents> {
  constructor() {
    super();
    this.setMaxListeners(0);
  }
}
