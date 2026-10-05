import type { ExecutionUnitOutcome, GenerationJob, PlanExecutionRecord, SceneVersionRecord } from "@flowforge/core";
import { stableJson } from "@flowforge/core";
import { ApplicationError } from "../errors.js";
import { isoNow, type ServiceDeps } from "../deps.js";
import { identifier } from "../validation.js";
import { requirePlanning } from "../planning.js";
import type { PlanningReadService } from "../planning.js";
import type { SceneService } from "../scene-service.js";
import type { GenerationService } from "../generation-service.js";
import { capabilityMapFor, buildExecutionMapping, type ExecutionUnit } from "./execution-mapping.js";
import { assessExecutionReadiness, describeBlocker, type ExecutionReadiness } from "./execution-readiness.js";
import { describeExecutionState } from "./execution-recovery.js";
import type {
  MaterializePlanCommand,
  PlanExecutionCounts,
  PlanExecutionReport,
  PlanExecutionState,
  PlanExecutionVersionTarget,
} from "./execution-types.js";

/**
 * Plan materialization (Phase 5): the only path in FlowForge that turns plan content into durable work.
 *
 * ```text
 * EXECUTABLE ProductionPlanVersion
 *   → readiness gate → execution mapping → deterministic ids
 *   → ONE transaction: plan_executions row, scenes, scene versions, generation jobs (+ queue items)
 *   → report
 * ```
 *
 * What this service owns: the gate, the ordering of writes, and the report. What it owns *nothing of*: job
 * creation (GenerationService and the repository's idempotency key), scene and version rules (SceneService and
 * the immutability triggers), claiming, leases, retries, and recovery (the durable queue and worker), provider
 * behaviour (the registry and the provider itself), and plan content (4A validation plus the planner). It calls
 * the existing services from inside one repository transaction and adds no SQL, no queue code, and no second
 * execution path of any kind. That reuse *is* the phase: the execution backbone is proven to work for planned
 * work because it is the same backbone Phase 1–3 already ran.
 *
 * Three invariants, each enforced rather than asserted:
 *
 * - **All or nothing.** Every write of one materialization happens inside one `BEGIN IMMEDIATE` transaction.
 *   An injected or incidental failure mid-way leaves zero partial execution records — no scene without its
 *   version, no version without its job, no `plan_executions` row describing work that does not exist.
 * - **Reuse, never duplication.** Ids are derived from the execution fingerprint, and job identity stays the
 *   content-keyed idempotency identity Phase 1 established. A repeat call — same process, restarted process,
 *   or a fresh `--data-dir` open of the same database — finds each row already present, reports `REUSED`, and
 *   inserts nothing. A plan version's second materialization is therefore a no-op with a full report.
 * - **Nothing executes here.** Materialization enqueues. Running work is `flowforge queue run`, guarded by the
 *   existing provider-coverage check, and approval stays an explicit review decision. There is no flag that
 *   submits, retries, cancels, or approves from this service, and no path to a browser or Google Flow.
 */
export class PlanExecutionService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly reads: PlanningReadService,
    private readonly scenes: SceneService,
    private readonly generation: GenerationService,
  ) {}

  /**
   * Materialize one plan version into durable execution work.
   *
   * `dryRun` is a report, not a rehearsal of a different code path: it runs the same readiness gate, the same
   * mapping, and the same identity derivation, and it predicts each unit's create-or-reuse outcome from the
   * durable state. Because it also refuses to write, a dry run on a blocked plan answers "what would happen?"
   * with "this would be refused, for these reasons" instead of throwing.
   */
  materialize(input: MaterializePlanCommand): PlanExecutionReport {
    const planning = requirePlanning(this.deps);
    const planId = identifier(input.planId, "planId");
    const { plan, version, snapshot } = this.reads.resolveSnapshot({ planId, versionNumber: input.versionNumber });
    const projectId = plan.projectId;
    const dryRun = input.dryRun === true;

    // One provider pool: the version's approved list, narrowed by an explicit `--providers` only when it names
    // a subset. Widening beyond what the executability gate approved is not offered.
    const selected = resolveSelection(input.providers, version.executableProviders);
    const mapping = buildExecutionMapping(
      snapshot,
      { providers: this.deps.providers, allowUnapproved: dryRun, maxAttempts: input.maxAttempts },
      selected,
    );
    const existingScenes = new Map<string, { projectId: string; status: string }>();
    for (const unit of mapping.units) {
      const scene = this.deps.repository.getScene(unit.sceneId);
      if (scene) existingScenes.set(unit.sceneId, { projectId: scene.projectId, status: scene.status });
    }
    const validation = planning.getLatestPlanValidation(version.id);
    const readiness = assessExecutionReadiness({
      snapshot,
      units: mapping.units,
      skipped: mapping.skipped,
      providers: capabilityMapFor(this.deps.providers, selected),
      registeredProviderIds: [...this.deps.providers.keys()],
      validation: validation
        ? {
            present: true,
            isCurrent: validation.contentHash === version.contentHash,
            status: validation.status,
            errorCount: validation.findings.filter((finding) => finding.severity === "ERROR").length,
          }
        : null,
      existingScenes,
      dryRun,
    });

    if (!readiness.ready && !dryRun) {
      throw new ApplicationError(
        readiness.capabilityBlocked ? "EXECUTION_CAPABILITY_UNAVAILABLE" : "EXECUTION_NOT_READY",
        `Plan version ${version.id} cannot be materialized: ${readiness.blockers.map((blocker) => describeBlocker(blocker)).join(" ")}`,
        {
          planVersionId: version.id,
          executionFingerprint: mapping.executionFingerprint,
          blockers: readiness.blockers,
          notices: readiness.notices,
          hint: readiness.capabilityBlocked
            ? "Configure a provider that declares the required capabilities, or revise the plan's specs."
            : "Validate, approve, and mark the version executable (flowforge plan executable --providers …), then materialize again.",
        },
      );
    }

    const now = isoNow(this.deps, input.now);
    const maxAttempts = input.maxAttempts;
    // Resolved once, before either branch, so a dry run reports the numbers a real run would write.
    const sceneNumbers = this.allocateSceneNumbers(projectId, mapping.units);

    if (dryRun) {
      const predicted = mapping.units.map((unit) => this.predict(unit, mapping.executionId, sceneNumbers));
      const counts = emptyCounts(predicted);
      for (const { outcome } of predicted) applyTally(counts, outcome);
      return this.report({
        snapshot,
        plan,
        version,
        projectId,
        mapping,
        readiness,
        execution: null,
        created: false,
        dryRun: true,
        now,
        units: predicted.map((entry) => entry.outcome),
        counts,
      });
    }

    const written = this.deps.repository.transaction(() => {
      const predictions = mapping.units.map((unit) => this.predict(unit, mapping.executionId, sceneNumbers));
      const counts = emptyCounts(predictions);
      // The execution row is written first because scene versions reference it, and its counts come from the
      // same pre-pass the writes are checked against below: the numbers a report shows are the numbers stored.
      const { execution, created } = this.deps.repository.createPlanExecutionWithCreated({
        id: mapping.executionId,
        projectId,
        planId: plan.id,
        planVersionId: version.id,
        executionFingerprint: mapping.executionFingerprint,
        rulesVersion: mapping.rulesVersion,
        mappingScope: mapping.mappingScope,
        providerId: providerOf(mapping.units),
        sceneCount: new Set(mapping.units.map((unit) => unit.sceneId)).size,
        sceneVersionCount: mapping.units.length,
        jobCount: mapping.units.length,
        reusedJobCount: counts.jobsReused,
        now,
      });
      const outcomes: ExecutionUnitOutcome[] = [];
      for (const { unit, outcome } of predictions) {
        outcomes.push(this.materializeUnit(execution, unit, outcome, maxAttempts, counts));
      }
      return { execution, created, outcomes, counts };
    });

    return this.report({
      snapshot,
      plan,
      version,
      projectId,
      mapping,
      readiness,
      execution: written.execution,
      created: written.created,
      dryRun: false,
      now,
      units: written.outcomes,
      counts: written.counts,
    });
  }

  /**
   * Read-only state of one materialization: jobs, queue, attempts, assets, QC, review, and what to do next.
   * Refuses only when the plan version was never materialized, because then there is nothing to report.
   */
  status(input: PlanExecutionVersionTarget): PlanExecutionState {
    const { snapshot, version } = this.reads.resolveSnapshot({
      planId: identifier(input.planId, "planId"),
      versionNumber: input.versionNumber,
    });
    const executions = this.deps.repository.listPlanExecutionsForVersion(version.id);
    if (executions.length === 0) {
      throw new ApplicationError(
        "NOT_FOUND",
        `Plan version ${version.id} has not been materialized; run flowforge plan execute first.`,
        { planVersionId: version.id },
      );
    }
    const execution =
      input.executionId === undefined
        ? executions[executions.length - 1]
        : executions.find((candidate) => candidate.id === input.executionId);
    if (!execution) {
      throw new ApplicationError("NOT_FOUND", `Plan execution not found: ${input.executionId}`, {
        executionId: input.executionId,
      });
    }
    return this.state(execution, snapshot);
  }

  /** Every materialization recorded for one plan version, oldest first. */
  executions(input: { planId: string; versionNumber?: number }): PlanExecutionRecord[] {
    const { version } = this.reads.resolveSnapshot({
      planId: identifier(input.planId, "planId"),
      versionNumber: input.versionNumber,
    });
    return this.deps.repository.listPlanExecutionsForVersion(version.id);
  }

  /**
   * Whether a plan version may be materialized right now, and why not. Never writes and never throws for
   * blocked state: this is the question `plan execute` answers before it decides to do anything.
   */
  readiness(input: PlanExecutionVersionTarget): ExecutionReadiness {
    const planning = requirePlanning(this.deps);
    const { version, snapshot } = this.reads.resolveSnapshot({
      planId: identifier(input.planId, "planId"),
      versionNumber: input.versionNumber,
    });
    const selected = resolveSelection(input.providers, version.executableProviders);
    const mapping = buildExecutionMapping(snapshot, { providers: this.deps.providers, allowUnapproved: true }, selected);
    const existingScenes = new Map<string, { projectId: string; status: string }>();
    for (const unit of mapping.units) {
      const scene = this.deps.repository.getScene(unit.sceneId);
      if (scene) existingScenes.set(unit.sceneId, { projectId: scene.projectId, status: scene.status });
    }
    const validation = planning.getLatestPlanValidation(version.id);
    return assessExecutionReadiness({
      snapshot,
      units: mapping.units,
      skipped: mapping.skipped,
      providers: capabilityMapFor(this.deps.providers, selected),
      registeredProviderIds: [...this.deps.providers.keys()],
      validation: validation
        ? {
            present: true,
            isCurrent: validation.contentHash === version.contentHash,
            status: validation.status,
            errorCount: validation.findings.filter((finding) => finding.severity === "ERROR").length,
          }
        : null,
      existingScenes,
      dryRun: true,
    });
  }

  private state(execution: PlanExecutionRecord, snapshot: Parameters<typeof describeExecutionState>[2]): PlanExecutionState {
    const links = buildExecutionMapping(snapshot, { providers: this.deps.providers, allowUnapproved: true }).units.map(
      (unit) => ({
        sceneKey: unit.sceneKey,
        sceneNumber: unit.sceneNumber,
        specId: unit.specId,
        kind: unit.kind,
        sceneId: unit.sceneId,
        sceneVersionId: unit.sceneVersionId,
        dependsOn: unit.dependsOn,
      }),
    );
    return describeExecutionState({ repository: this.deps.repository }, execution, snapshot, links);
  }

  /**
   * A `Scene` is a project-level container, and `scenes.scene_number` is unique inside a project. The plan's
   * own numbering is the *intent*; when the project already holds that number for a different scene — a
   * second plan, or a re-plan whose scene keys changed — taking the next free number keeps the plan's
   * relative order instead of surfacing a database constraint mid-materialization. Reused scenes keep the
   * number they already have: rewriting a scene's number would silently reorder finished work.
   */
  private allocateSceneNumbers(projectId: string, units: readonly ExecutionUnit[]): Map<string, number> {
    const scenes = this.deps.repository.listProjectScenes(projectId);
    const byId = new Map(scenes.map((scene) => [scene.id, scene]));
    const taken = new Set(scenes.map((scene) => scene.sceneNumber));
    const allocated = new Map<string, number>();
    for (const unit of units) {
      const existing = byId.get(unit.sceneId);
      if (existing) {
        allocated.set(unit.sceneId, existing.sceneNumber);
        continue;
      }
      let sceneNumber = unit.sceneNumber;
      while (taken.has(sceneNumber)) sceneNumber += 1;
      taken.add(sceneNumber);
      allocated.set(unit.sceneId, sceneNumber);
    }
    return allocated;
  }

  /** What already exists for one unit, so the write path can reuse it and the report can say so honestly. */
  private predict(
    unit: ExecutionUnit,
    executionId: string,
    sceneNumbers: Map<string, number>,
  ): { unit: ExecutionUnit; outcome: ExecutionUnitOutcome; existingVersion: SceneVersionRecord | null } {
    const scene = this.deps.repository.getScene(unit.sceneId);
    const existingVersion = this.deps.repository.getSceneVersion(unit.sceneVersionId);
    const versionMatches =
      existingVersion !== null &&
      existingVersion.sceneId === unit.sceneId &&
      existingVersion.prompt === unit.prompt &&
      stableJson(existingVersion.references) === stableJson(unit.references) &&
      existingVersion.planExecutionId === executionId;
    const reusableJob = this.findReusableJob(unit);
    return {
      unit,
      existingVersion: versionMatches ? existingVersion : null,
      outcome: {
        scenePlanId: unit.scenePlanId,
        sceneKey: unit.sceneKey,
        sceneNumber: sceneNumbers.get(unit.sceneId) ?? unit.sceneNumber,
        specId: unit.specId,
        specNumber: unit.specNumber,
        kind: unit.kind,
        providerId: unit.providerId,
        sceneId: unit.sceneId,
        scene: scene ? "REUSED" : "CREATED",
        sceneVersionId: unit.sceneVersionId,
        sceneVersion: versionMatches ? "REUSED" : "CREATED",
        jobId: reusableJob?.id ?? "",
        jobKey: unit.jobKey,
        job: reusableJob ? "REUSED" : "CREATED",
        jobStatus: reusableJob?.status ?? "PENDING",
        queueItemId: reusableJob ? this.deps.repository.getQueueItemByJob(reusableJob.id)?.id : undefined,
        queueStatus: reusableJob ? this.deps.repository.getQueueItemByJob(reusableJob.id)?.status : undefined,
        priority: unit.priority,
        dependsOn: [...unit.dependsOn],
      },
    };
  }

  /**
   * A planned unit reuses the job whose identity already matches it — same deterministic scene version, same
   * provider, same parameters. This mirrors how Phase 1 decides idempotency (the key is computed from the
   * scene version's prompt and references plus these parameters) without reaching into the key's construction:
   * the version id is part of the identity, so a match here is a match on the key.
   */
  private findReusableJob(unit: ExecutionUnit): GenerationJob | null {
    const parameters = stableJson(unit.parameters);
    for (const job of this.deps.repository.listGenerationJobs({ sceneVersionId: unit.sceneVersionId })) {
      if (job.request.provider !== unit.providerId) continue;
      if (stableJson(job.request.parameters ?? {}) !== parameters) continue;
      return job;
    }
    return null;
  }

  private materializeUnit(
    execution: PlanExecutionRecord,
    unit: ExecutionUnit,
    outcome: ExecutionUnitOutcome,
    maxAttempts: number | undefined,
    counts: PlanExecutionCounts,
  ): ExecutionUnitOutcome {
    if (outcome.scene === "CREATED") {
      this.scenes.createScene({
        projectId: execution.projectId,
        sceneId: unit.sceneId,
        sceneNumber: outcome.sceneNumber,
        title: unit.sceneTitle,
        description: unit.sceneDescription,
        metadata: unit.metadata,
      });
    }
    if (outcome.sceneVersion === "CREATED") {
      this.scenes.addSceneVersion({
        sceneId: unit.sceneId,
        sceneVersionId: unit.sceneVersionId,
        prompt: unit.prompt,
        references: [...unit.references],
        metadata: unit.metadata,
        planLink: {
          planExecutionId: execution.id,
          planVersionId: execution.planVersionId,
          scenePlanId: unit.scenePlanId,
          generationSpecId: unit.specId,
        },
      });
    }

    const result = this.generation.requestGeneration({
      projectId: execution.projectId,
      sceneId: unit.sceneId,
      sceneVersionId: unit.sceneVersionId,
      provider: unit.providerId,
      parameters: unit.parameters,
      metadata: unit.metadata,
      priority: unit.priority,
      maxAttempts,
      planExecutionId: execution.id,
    });
    // A pre-pass prediction that disagrees with the write means the durable state moved under us inside the
    // transaction, which the write lock rules out — so disagreement is a bug, and it fails the whole run
    // rather than leaving counts that describe work the database does not contain.
    if ((result.created ? "CREATED" : "REUSED") !== outcome.job) {
      throw new ApplicationError(
        "EXECUTION_STATE_INCONSISTENT",
        `Materialization predicted job ${outcome.job} for spec ${unit.specId} but the write reported ${result.created ? "created" : "reused"}.`,
        { specId: unit.specId, jobId: result.job.id },
      );
    }
    const final: ExecutionUnitOutcome = {
      ...outcome,
      jobId: result.job.id,
      job: result.created ? "CREATED" : "REUSED",
      jobStatus: result.job.status,
      queueItemId: result.queue?.id,
      queueStatus: result.queue?.status,
    };
    applyTally(counts, final);
    return final;
  }

  private report(input: {
    snapshot: Parameters<typeof describeExecutionState>[2];
    plan: { id: string };
    version: { id: string; versionNumber: number; status: string };
    projectId: string;
    mapping: ReturnType<typeof buildExecutionMapping>;
    readiness: ExecutionReadiness;
    execution: PlanExecutionRecord | null;
    created: boolean;
    dryRun: boolean;
    now: string;
    units: ExecutionUnitOutcome[];
    counts: PlanExecutionCounts;
  }): PlanExecutionReport {
    const { mapping, readiness, counts } = input;
    return {
      planId: input.plan.id,
      planVersionId: input.version.id,
      versionNumber: input.version.versionNumber,
      planVersionStatus: input.version.status,
      projectId: input.projectId,
      executionId: input.execution?.id ?? null,
      executionFingerprint: mapping.executionFingerprint,
      rulesVersion: mapping.rulesVersion,
      mappingScope: mapping.mappingScope,
      providerId: providerOf(mapping.units),
      dryRun: input.dryRun,
      created: input.created,
      materializedAt: input.dryRun ? null : input.now,
      units: input.units,
      skipped: mapping.skipped,
      blockers: readiness.blockers,
      notices: readiness.notices,
      counts,
      nextAction: nextActionFor(input.dryRun, readiness, counts, input.created),
    };
  }
}

function resolveSelection(requested: readonly string[] | undefined, approved: readonly string[] | undefined): readonly string[] | undefined {
  if (requested === undefined || requested.length === 0) return approved && approved.length > 0 ? approved : undefined;
  if (!approved || approved.length === 0) return requested;
  const outside = requested.filter((id) => !approved.includes(id));
  if (outside.length > 0) {
    throw new ApplicationError(
      "EXECUTION_NOT_READY",
      `Provider(s) ${outside.join(", ")} were not approved for this plan version; materialization may not widen the executable provider set.`,
      { requested, approved, blockers: [{ code: "EXECUTION_PROVIDER_NOT_APPROVED", detail: "providers outside the approved set" }] },
    );
  }
  return requested;
}

/**
 * The provider(s) this materialization targets, sorted and comma-joined: a plan may legitimately spread units
 * across several approved providers, and a single "the" provider field would have to pick one arbitrarily.
 * "none" only ever appears on a dry run with no mappable unit, which the write path refuses before storing.
 */
function providerOf(units: readonly ExecutionUnit[]): string {
  const ids = new Set(units.map((unit) => unit.providerId));
  return [...ids].sort().join(",") || "none";
}

/**
 * The counts a report and the durable `plan_executions` row both use. One function on purpose: the numbers an
 * operator reads are the numbers stored, and a dry run reports exactly the tally a real run would write.
 */
function emptyCounts(entries: readonly { unit: ExecutionUnit }[]): PlanExecutionCounts {
  return {
    scenePlans: new Set(entries.map((entry) => entry.unit.scenePlanId)).size,
    generationSpecs: entries.length,
    units: entries.length,
    scenesCreated: 0,
    scenesReused: 0,
    sceneVersionsCreated: 0,
    sceneVersionsReused: 0,
    jobsCreated: 0,
    jobsReused: 0,
    queueItemsCreated: 0,
  };
}

function applyTally(counts: PlanExecutionCounts, outcome: ExecutionUnitOutcome): void {
  if (outcome.scene === "CREATED") counts.scenesCreated += 1;
  else counts.scenesReused += 1;
  if (outcome.sceneVersion === "CREATED") counts.sceneVersionsCreated += 1;
  else counts.sceneVersionsReused += 1;
  if (outcome.job === "CREATED") {
    counts.jobsCreated += 1;
    // Job creation and its queue item are one repository transaction, so a created job always has an item.
    if (outcome.queueItemId) counts.queueItemsCreated += 1;
  } else {
    counts.jobsReused += 1;
  }
}

function nextActionFor(
  dryRun: boolean,
  readiness: ExecutionReadiness,
  counts: PlanExecutionCounts,
  created: boolean,
): string {
  if (!readiness.ready) {
    return readiness.capabilityBlocked
      ? "Blocked: configure a provider that declares the required capabilities."
      : `Blocked: ${readiness.blockers.map((blocker) => blocker.code).join(", ")}.`;
  }
  if (dryRun) {
    return counts.jobsCreated > 0
      ? `Would enqueue ${counts.jobsCreated} job(s); re-run without --dry-run to write.`
      : "Everything already exists; the real run would write nothing.";
  }
  if (counts.jobsCreated === 0) {
    return created
      ? "Materialized with no new jobs; every unit already had durable work."
      : "Already materialized: nothing was created, which is the idempotent result.";
  }
  return `flowforge queue run --max-jobs ${counts.jobsCreated} (the durable worker owns claiming, leases, retries, QC, and asset writes).`;
}
