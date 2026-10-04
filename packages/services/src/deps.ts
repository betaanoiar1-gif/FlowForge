import type { ProviderRegistry, QueuePort, WorkerPort, JobRepository } from "./ports.js";

/** Shared, read-mostly context handed to every service constructed by `createApplication`. */
export interface ServiceDeps {
  readonly repository: JobRepository;
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
