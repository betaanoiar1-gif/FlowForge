import type { AIPlanner } from "@flowforge/core";
import type {
  ProviderDescriptor,
  ProviderRegistry,
  QueuePort,
  WorkerPort,
  JobRepository,
  PlanningRepository,
} from "./ports.js";
import type { ServiceDeps } from "./deps.js";
import { ProjectService } from "./project-service.js";
import { SceneService } from "./scene-service.js";
import { GenerationService } from "./generation-service.js";
import { QueueService } from "./queue-service.js";
import { ReviewService } from "./review-service.js";
import { ProductionService } from "./production-service.js";
import { PlannerService } from "./planner-service.js";
import { AiPlannerService } from "./ai-planner-service.js";
import { PlanExecutionService } from "./execution/plan-execution-service.js";
import {
  CreativeBriefService,
  PlanningDefinitionService,
  PlanningReadService,
  PlanningValidationService,
  ProductionPlanService,
} from "./planning.js";

export interface ApplicationOptions {
  /** Durable queue port; required only for lease-recovery reporting. */
  queue?: QueuePort;
  /** Durable local worker; required for execution and for provider-side cancellation. */
  worker?: WorkerPort;
  /** The single provider ID `worker` serves. Drives the provider-coverage guard. */
  workerProviderId?: string;
  /** Provider descriptors available for admission checks. No provider is constructed here. */
  providers?: Iterable<ProviderDescriptor>;
  defaultMaxAttempts?: number;
  /** Clock used for timestamps when a command does not override it. */
  now?: () => Date;
  /**
   * Planning persistence for Phase 4A. Optional on purpose: a Phase 3 application keeps working
   * exactly as before, and planning access without it raises `PLANNING_NOT_CONFIGURED`.
   */
  planning?: PlanningRepository;
  /**
   * The AI planner adapter (Phase 4C). Optional, like `planning`: absent means AI planning is unavailable
   * here and `aiPlanning.plan()` fails with `AI_PLANNER_NOT_CONFIGURED`, while every deterministic path
   * keeps working untouched. The adapter is provider-neutral and read-only; it is never handed a
   * repository, a queue, or a lifecycle service, and it can therefore write nothing.
   */
  aiPlanner?: AIPlanner;
}

export interface FlowForgeApplication {
  readonly repository: JobRepository;
  readonly providers: ProviderRegistry;
  readonly projects: ProjectService;
  readonly scenes: SceneService;
  readonly generation: GenerationService;
  readonly execution: QueueService;
  readonly reviews: ReviewService;
  readonly production: ProductionService;
  readonly briefs: CreativeBriefService;
  readonly definitions: PlanningDefinitionService;
  readonly plans: ProductionPlanService;
  readonly planValidation: PlanningValidationService;
  readonly planReads: PlanningReadService;
  /** The deterministic planner: authors plan versions from a brief through the planning services. */
  readonly planner: PlannerService;
  /**
   * Plan materialization (Phase 5): the only path that turns an EXECUTABLE plan version into durable work.
   * It reuses the Phase 3 services for every write and the durable queue/worker for everything after that, so
   * it can create work and nothing else — no run, no retry, no approval, and no execution verb lives here.
   */
  readonly planExecution: PlanExecutionService;
  /**
   * AI-assisted planning (Phase 4C). Propose-only: it builds the request, validates the answer, and hands
   * the result to `planner`, which stays the sole author of plan rows. Nothing here submits, enqueues,
   * or executes anything.
   */
  readonly aiPlanning: AiPlannerService;
}

/**
 * Composition root for the application layer. It wires the existing repository, queue, and
 * worker into services; it constructs no infrastructure and owns no database lifecycle (the
 * caller keeps the repository handle and closes it).
 */
export function createApplication(repository: JobRepository, options: ApplicationOptions = {}): FlowForgeApplication {
  const providers = toProviderRegistry(options.providers);
  const defaultMaxAttempts = options.defaultMaxAttempts ?? 3;
  if (!Number.isSafeInteger(defaultMaxAttempts) || defaultMaxAttempts < 1 || defaultMaxAttempts > 25) {
    throw new RangeError("defaultMaxAttempts must be an integer between 1 and 25.");
  }
  if (options.workerProviderId !== undefined && options.worker === undefined) {
    throw new RangeError("workerProviderId requires a worker to guard.");
  }

  const deps: ServiceDeps = {
    repository,
    queue: options.queue,
    worker: options.worker,
    workerProviderId: options.workerProviderId,
    providers,
    now: options.now ?? (() => new Date()),
    defaultMaxAttempts,
    planning: options.planning,
    aiPlanner: options.aiPlanner,
  };

  const projects = new ProjectService(deps);
  const scenes = new SceneService(deps);
  const generation = new GenerationService(deps);
  const execution = new QueueService(deps);
  const reviews = new ReviewService(deps);
  const production = new ProductionService(deps, scenes);
  const planReads = new PlanningReadService(deps);
  const briefs = new CreativeBriefService(deps);
  const definitions = new PlanningDefinitionService(deps);
  const plans = new ProductionPlanService(deps, planReads);
  const planValidation = new PlanningValidationService(deps, planReads);
  const planner = new PlannerService(deps, planReads, plans, planValidation);
  const planExecution = new PlanExecutionService(deps, planReads, scenes, generation);
  const aiPlanning = new AiPlannerService(deps, planner);
  return {
    repository,
    providers,
    projects,
    scenes,
    generation,
    execution,
    reviews,
    production,
    briefs,
    definitions,
    plans,
    planValidation,
    planReads,
    planner,
    aiPlanning,
    planExecution,
  };
}

function toProviderRegistry(providers: Iterable<ProviderDescriptor> | undefined): ProviderRegistry {
  const registry = new Map<string, ProviderDescriptor>();
  for (const provider of providers ?? []) {
    if (!provider || typeof provider.id !== "string" || !provider.id.trim()) {
      throw new RangeError("Every registered provider needs a non-empty id for capability checks.");
    }
    if (!provider.capabilities) {
      throw new RangeError(`Provider ${provider.id} must declare its capabilities before it can be registered.`);
    }
    registry.set(provider.id, provider);
  }
  return registry;
}
