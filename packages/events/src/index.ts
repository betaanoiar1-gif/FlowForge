export type FlowForgeEvent =
  | { type: "browser.connected"; at: string }
  | { type: "browser.disconnected"; at: string }
  | { type: "browser.state_changed"; at: string; state: string }
  | { type: "generation.created"; at: string; jobId: string }
  | { type: "generation.preparing"; at: string; jobId: string }
  | { type: "generation.submitting"; at: string; jobId: string }
  | { type: "generation.generating"; at: string; jobId: string; externalId: string }
  | { type: "generation.verifying"; at: string; jobId: string; externalId: string }
  | { type: "generation.failed"; at: string; jobId: string; reason: string };

export type EventHandler = (event: FlowForgeEvent) => void | Promise<void>;

export interface EventPublisher {
  publish(event: FlowForgeEvent): void | Promise<void>;
}
