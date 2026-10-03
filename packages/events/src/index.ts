export type FlowForgeEvent =
  | { type: "browser.connected"; at: string }
  | { type: "browser.disconnected"; at: string }
  | { type: "browser.state_changed"; at: string; state: string }
  | { type: "generation.created"; at: string; jobId: string }
  | { type: "generation.completed"; at: string; jobId: string }
  | { type: "generation.failed"; at: string; jobId: string; reason: string };

export type EventHandler = (event: FlowForgeEvent) => void | Promise<void>;
