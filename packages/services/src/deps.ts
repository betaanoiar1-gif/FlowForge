import type { ProviderRegistry, QueuePort, WorkerPort, JobRepository, PlanningRepository } from "./ports.js";

/** Shared, read-mostly context handed to every service constructed by `createApplication`. */
export interface ServiceDeps {
  readonly repository: JobRepository;
  /**
   * Planning persistence is optional so Phase 3 callers keep working unchanged. Planning services
   * fail with `PLANNING_NOT_CONFIGURED` when it is absent, never with a `TypeError`.
   */
  readonly planning?: PlanningRepository;
  readonly queue?: QueuePort;
  readonly worker?: WorkerPort;
  /** Provider ID the wired worker serves; the coverage guard is computed against this. */
  readonly workerProviderId?: string;
  readonly providers: ProviderRegistry;
  readonly now: () => Date;
  readonly defaultMaxAttempts: number;
}

export function isoNow(deps: ServiceDeps, override?: string): string {
  return override ?? deps.now().toISOString();
}
