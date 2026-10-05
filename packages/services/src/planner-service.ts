import {
  DETERMINISTIC_PLANNER_VERSION,
  PLANNING_RULES_VERSION,
  type PlanningFinding,
  type PlannerTraceStep,
  type ProductionPlan,
  type ProductionPlanVersion,
} from "@flowforge/core";
import { ApplicationError } from "./errors.js";
import { isoNow, type ServiceDeps } from "./deps.js";
import { identifier, requiredText } from "./validation.js";
import { attempt, requirePlanning } from "./planning.js";
import type { PlanningRepository, ProviderRegistry } from "./ports.js";
import type { PlanValidationView } from "./planning-read-models.js";
import { PlanningReadService, PlanningValidationService, ProductionPlanService } from "./planning.js";
import {
  PLANNER_RULES,
  PlannerInputError,
  authoringId,
  runPlanner,
  type PlannerDraft,
  type PlannerInput,
  type PlannerNotice,
  type PlannerOutcome,
  type PlannerProviderCandidate,
  type PlannerRun,
} from "./planner/index.js";
import type { PlanProductionCommand } from "./commands.js";

/**
 * The application service for the deterministic planner (Phase 4B).
 *
 * This is where the pure engine meets persistence. The service resolves what the engine needs from the
 * reviewed reads, runs the engine, and only then — and only for a run the engine itself validated —
 * authors the plan through the *existing* Phase 4A service methods (`setStory`, `setCast`,
 * `addScenePlan`, `addGenerationSpec`). Every write therefore goes through the same validation,
 * content hashing, and trigger protection a hand-authored plan gets: there is no second planning path
 * and no second write surface.
 *
 * Deliberate limits: it never creates a generation job, never enqueues, never constructs a provider,
 * never opens a browser, and never publishes. Handing a plan to execution stays Phase 3's job.
 */
export class PlannerService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly reads: PlanningReadService,
    private readonly plans: ProductionPlanService,
    private readonly validation: PlanningValidationService,
  ) {}

  /**
   * Plan a production plan from a brief. `dryRun` answers "what would this produce, and would it
   * validate?" without writing a byte, which is how an operator iterates on a brief safely.
   */
  plan(input: PlanProductionCommand): PlanProductionResult {
    const planning = requirePlanning(this.deps);
    const projectId = identifier(input.projectId, "projectId");
    if (!this.deps.repository.getProject(projectId)) {
      throw new ApplicationError("NOT_FOUND", `Project not found: ${projectId}`, { projectId });
    }
    const now = isoNow(this.deps, input.now);
    const brief =
      input.briefId === undefined
        ? planning.currentBrief(projectId)
        : planning.getBrief(identifier(input.briefId, "briefId"));
    if (!brief) {
      throw new ApplicationError(
        "NOT_FOUND",
        input.briefId === undefined
          ? `Project ${projectId} has no creative brief; planning needs an active brief to author against.`
          : `Creative brief not found: ${String(input.briefId)}`,
        { projectId, briefId: input.briefId ?? null },
      );
    }
    if (brief.status !== "ACTIVE") {
      throw new ApplicationError(
        "VALIDATION_FAILED",
        `Creative brief ${brief.id} is ${brief.status}; plan against the project's active brief, so the plan's provenance names a live creative intent.`,
        { briefId: brief.id, status: brief.status },
      );
    }
    const candidates = this.candidateCapabilities(input.providers);
    const run = this.run({
      projectId,
      brief,
      story: input.story,
      cast: input.cast,
      worlds: input.worlds,
      visualDnaId: input.visualDnaId,
      definitions: {
        characters: planning.listProjectCharacters(projectId),
        worlds: planning.listWorlds(projectId),
        visualDna: planning.listVisualDna(projectId),
      },
      providerCandidates: candidates,
      // `planTitle` is a command field for ergonomics and an option for the engine; the command wins,
      // because the operator typed it on this call.
      options:
        input.planTitle === undefined
          ? input.options
          : { ...(input.options ?? {}), planTitle: input.planTitle },
      asOf: now,
    });
    const summary = summarize(run, candidates.length);
    const draftedPlan = run.draft === undefined ? null : planning.getPlan(run.draft.planId);

    if (input.dryRun === true) {
      return {
        ...summary,
        plan: draftedPlan,
        version: null,
        created: false,
        reused: false,
        validation: null,
        scenePlans: run.draft?.scenePlans.length ?? 0,
        specs: run.draft?.scenePlans.reduce((sum, scene) => sum + scene.specs.length, 0) ?? 0,
        nextAction:
          run.outcome === "SUCCESS"
            ? "The draft validates. Re-run without dryRun to author it into a plan version."
            : "Fix the reported problems; nothing was written.",
      };
    }
    if (run.outcome !== "SUCCESS" || run.draft === undefined) {
      return {
        ...summary,
        plan: draftedPlan,
        version: null,
        created: false,
        reused: false,
        validation: null,
        scenePlans: 0,
        specs: 0,
        nextAction:
          run.outcome === "VALIDATION_FAILURE"
            ? "Nothing was written: the drafted plan fails the planning rules. Repair the brief, story, or definitions, then plan again."
            : "Nothing was written: the planner could not produce a complete draft. Read the notices, then plan again.",
      };
    }
    const draft = run.draft;
    const target = this.resolveTarget(planning, draft, run, input, now);
    if (target.reused) {
      // Same input, same content, already stored and still valid: report it, write nothing.
      const snapshot = this.reads.snapshot(target.version.id);
      return {
        ...summary,
        plan: target.plan,
        version: target.version,
        created: false,
        reused: true,
        validation: this.reads.requireValidationView(target.version),
        scenePlans: snapshot.scenePlans.length,
        specs: snapshot.specs.length,
        nextAction: "The plan version already holds exactly this content, so no write was made.",
      };
    }
    const version = target.version;
    const authored = this.author(draft, version, now, run.inputFingerprint);
    const contentHash = planning.planVersionContentHash(version.id);
    attempt(
      this.deps,
      () =>
        planning.setPlanVersionProvenance({
          planVersionId: version.id,
          provenance: {
            plannerVersion: run.plannerVersion,
            rulesVersion: run.rulesVersion,
            seed: run.seed,
            inputFingerprint: run.inputFingerprint,
            outputFingerprint: run.outputFingerprint ?? "",
            contentHash,
            trace: [...run.trace],
          },
          now,
        }),
      "PERSISTENCE_REJECTED",
      { planVersionId: version.id, planId: version.planId },
    );
    // Revalidate the *stored* aggregate: the authoritative evidence is about rows, not about a draft.
    const report = this.validation.validate({ planId: version.planId, versionNumber: version.versionNumber, now });
    const notices: PlannerNotice[] = [...run.notices];
    let outcome: PlannerOutcome = run.outcome;
    if (report.report.status !== "PASSED") {
      // The engine self-checked with this same validator, so this only happens when the stored rows
      // diverge from the draft (a concurrent edit, or a rule drift). The version stays an editable draft
      // — recoverable, unapproved, and reported loudly rather than quietly accepted.
      outcome = "VALIDATION_FAILURE";
      notices.push({
        code: "PLANNER_PERSISTED_VALIDATION_MISMATCH",
        severity: "ERROR",
        rule: "plan-integrity",
        message: `Plan version ${version.id} was authored but validation reports ${report.report.errorCount} blocking finding(s); it stays a draft.`,
      });
    }
    let currentVersion = report.version;
    let executable = false;
    if (outcome === "SUCCESS" && input.approve === true) {
      const reviewer = requiredText(input.reviewer ?? "deterministic-planner", "reviewer");
      currentVersion = this.plans.approve({
        planId: version.planId,
        versionNumber: version.versionNumber,
        reviewer,
        now,
      }).version;
      if (input.providers !== undefined && input.providers.length > 0) {
        currentVersion = this.plans.markExecutable({
          planId: version.planId,
          versionNumber: version.versionNumber,
          providers: input.providers,
          now,
        }).version;
        executable = true;
      }
    }
    return {
      ...summary,
      outcome,
      notices,
      plan: target.plan,
      version: currentVersion,
      created: target.created,
      reused: false,
      validation: report.report,
      scenePlans: authored.scenePlans,
      specs: authored.specs,
      nextAction:
        outcome === "VALIDATION_FAILURE"
          ? "The authored version failed validation; repair the inputs and re-plan into a new version."
          : executable
            ? "The plan version is EXECUTABLE; Phase 3 execution mapping can claim its specs."
            : "Validation is recorded and the version is VALIDATED; approve it (or re-plan with approve) to reach EXECUTABLE.",
    };
  }

  /** The engine, with an unusable input converted into the same three-outcome shape it reports. */
  private run(input: PlannerInput): PlannerRun {
    try {
      return runPlanner(input);
    } catch (error) {
      if (!(error instanceof PlannerInputError)) throw error;
      const notice: PlannerNotice = {
        code: "PLANNER_INPUT_INVALID",
        severity: "ERROR",
        message: error.message,
        rule: "brief-foundation",
        field: error.field,
      };
      return {
        outcome: "PLANNING_FAILURE",
        plannerVersion: DETERMINISTIC_PLANNER_VERSION,
        rulesVersion: PLANNING_RULES_VERSION,
        // No normalized input, so no fingerprint: the run is identified by the refusal alone.
        inputFingerprint: "",
        outputFingerprint: null,
        seed: input.options?.seed ?? 0,
        notices: [notice],
        findings: [],
        trace: [],
        rulesApplied: [],
        errors: [{ code: notice.code, message: notice.message, field: notice.field }],
      };
    }
  }

  /**
   * Capability declarations to plan within, read from the registry the process was configured with.
   * An explicit list is validated (an unknown id is a wiring mistake, never a silent omission); no list
   * means "everything this process declares", and an empty registry means "assume nothing", which lets
   * the planner skip adaptation instead of inventing coverage.
   */
  private candidateCapabilities(selected: readonly string[] | undefined): readonly PlannerProviderCandidate[] {
    const registry: ProviderRegistry = this.deps.providers;
    const ids = selected === undefined || selected.length === 0 ? [...registry.keys()] : [...new Set(selected)];
    const unknown = ids.filter((id) => !registry.has(id));
    if (ids.length > 0 && unknown.length > 0) {
      throw new ApplicationError(
        "PROVIDER_NOT_CONFIGURED",
        `Provider(s) ${[...unknown].sort().join(", ")} are not configured in this process; the planner cannot plan against capabilities it cannot read.`,
        { unknown: [...unknown].sort(), configuredProviders: [...registry.keys()].sort() },
      );
    }
    // Declarations, never instances: the planner is told what a provider claims and never asks a provider.
    return ids.sort().map((id) => ({ id, capabilities: registry.get(id)!.capabilities }));
  }

  /**
   * Which plan version this run writes into, decided before any write so a refusal changes nothing.
   *
   * - No plan yet: create the plan and its first version.
   * - `new-version` (default): fresh empty version, lineage to the previous one — never a copy, because
   *   the planner authors every scene itself and a copied base would leave unaccounted-for rows.
   * - `in-place`: only an editable version the planner itself authored (or one still empty); its drafted
   *   scene plans are removed and re-authored, so a re-plan never strands a stale scene behind.
   * - `fail`: refuse when anything has already been planned for this input.
   * - Identical content already stored: reuse, with zero writes.
   */
  private resolveTarget(
    planning: PlanningRepository,
    draft: PlannerDraft,
    run: PlannerRun,
    input: PlanProductionCommand,
    now: string,
  ): { plan: ProductionPlan; version: ProductionPlanVersion; created: boolean; reused: boolean } {
    const policy = input.options?.replan ?? "new-version";
    const existing = planning.getPlan(draft.planId);
    if (existing === null) {
      const createdPlan = this.plans.createPlan({
        planId: draft.planId,
        projectId: draft.projectId,
        briefId: draft.briefId,
        title: draft.title,
        visualDnaId: draft.visualDnaId,
        now,
      });
      return { plan: createdPlan.plan, version: createdPlan.version, created: true, reused: false };
    }
    const plan = existing;
    const current =
      plan.currentVersionId === undefined
        ? null
        : (planning.getPlanVersion(plan.currentVersionId) ?? planning.listPlanVersions(plan.id).at(-1) ?? null);
    if (current === null) {
      const fresh = attempt(
        this.deps,
        () => planning.createPlanVersion({ planId: plan.id, visualDnaId: draft.visualDnaId, now }),
        "PERSISTENCE_REJECTED",
        { planId: plan.id },
      );
      return { plan, version: fresh.version, created: true, reused: false };
    }
    const unchanged =
      current.plannerInputFingerprint === run.inputFingerprint &&
      current.plannerOutputFingerprint === run.outputFingerprint &&
      current.plannerContentHash !== undefined &&
      planning.planVersionContentHash(current.id) === current.plannerContentHash;
    if (unchanged && current.status !== "ARCHIVED") {
      return { plan, version: current, created: false, reused: true };
    }
    if (policy === "fail") {
      throw new ApplicationError(
        "IDEMPOTENCY_CONFLICT",
        `Plan ${plan.id} already has version ${current.versionNumber}${unchanged ? " holding this content" : " with different content"}; the replan policy is "fail", so nothing was changed.`,
        { planId: plan.id, planVersionId: current.id, status: current.status },
      );
    }
    if (policy === "in-place") {
      if (current.status !== "DRAFT" && current.status !== "VALIDATED") {
        throw new ApplicationError(
          "PLAN_NOT_EDITABLE",
          `Plan version ${current.id} is ${current.status}; planning "in-place" can only target an editable version. Use the new-version policy instead.`,
          { planId: plan.id, planVersionId: current.id, status: current.status },
        );
      }
      const scenePlans = planning.loadPlanVersionSnapshot(current.id)?.scenePlans ?? [];
      if (current.plannerVersion !== undefined) {
        // Provenance is recorded once per version — that is the guarantee that lets a plan say which
        // planner version produced it — so a *changed* re-plan cannot live in the same version. Re-running
        // identical content is already handled above as a reuse, which is the only in-place outcome that
        // does not rewrite history.
        throw new ApplicationError(
          "IDEMPOTENCY_CONFLICT",
          `Plan version ${current.id} already carries provenance from ${current.plannerVersion}; provenance is write-once, so a changed re-plan must go into a new version.`,
          { planId: plan.id, planVersionId: current.id, plannerVersion: current.plannerVersion },
        );
      }
      if (scenePlans.length > 0) {
        throw new ApplicationError(
          "IDEMPOTENCY_CONFLICT",
          `Plan version ${current.id} holds hand-authored scene plans and no planner provenance; re-planning it in place would destroy work the planner cannot rebuild. Plan into a new version instead.`,
          { planId: plan.id, planVersionId: current.id, scenePlans: scenePlans.length },
        );
      }
      for (const node of scenePlans) {
        this.plans.removeScenePlan({ scenePlanId: node.scenePlan.id, now });
      }
      return { plan, version: current, created: false, reused: false };
    }
    const next = attempt(
      this.deps,
      () =>
        planning.createPlanVersion({
          planId: plan.id,
          predecessorVersionId: current.id,
          visualDnaId: draft.visualDnaId,
          now,
        }),
      "PERSISTENCE_REJECTED",
      { planId: plan.id },
    );
    return { plan, version: next.version, created: true, reused: false };
  }

  /**
   * The authored writes. Row ids are deterministic but version-scoped (see `authoringId` for why), and
   * every call goes through the Phase 4A service, so a plan the planner authors is bound by exactly the
   * rules a human-authored plan is.
   */
  private author(
    draft: PlannerDraft,
    version: ProductionPlanVersion,
    now: string,
    inputFingerprint: string,
  ): { scenePlans: number; specs: number } {
    const target = { planId: version.planId, versionNumber: version.versionNumber, now };
    this.plans.setStory({
      ...target,
      premise: draft.story.premise,
      structure: draft.story.structure,
      themes: draft.story.themes,
      beginning: draft.story.beginning,
      development: draft.story.development,
      ending: draft.story.ending,
    });
    this.plans.setCast({
      ...target,
      cast: draft.cast.map((entry) => ({ characterId: entry.characterId, role: entry.role })),
    });
    let specs = 0;
    // The draft refers to a scene plan by its drafted id; the row carries a version-scoped id. Re-pointing
    // a scene plan's own references is a translation of identity, not of content — the plan still says
    // "this shot continues from that shot", it just names the row that exists rather than the draft it
    // came from. Skipping it would leave every continuity reference dangling once stored.
    const rowIds = new Map<string, string>();
    for (const scene of draft.scenePlans) {
      const scenePlanId = authoringId(inputFingerprint, version.id, "scene-plan", `${scene.beatKey}:${scene.sceneKey}`);
      rowIds.set(scene.id, scenePlanId);
      this.plans.addScenePlan({
        ...target,
        scenePlanId,
        sceneKey: scene.sceneKey,
        sceneNumber: scene.sceneNumber,
        title: scene.title,
        narrativePurpose: scene.narrativePurpose,
        description: scene.description,
        durationTargetMs: scene.durationTargetMs,
        worldId: scene.worldId,
        visualDnaId: scene.visualDnaId,
        continuity: scene.continuity,
        requiredReferences: scene.requiredReferences.map((reference) =>
          reference.kind === "scenePlan" ? { ...reference, id: rowIds.get(reference.id) ?? reference.id } : reference,
        ),
        plannedOutputs: scene.plannedOutputs,
        cast: scene.cast,
      });
      for (const spec of scene.specs) {
        this.plans.addGenerationSpec({
          scenePlanId,
          specId: authoringId(inputFingerprint, version.id, "generation-spec", `${scene.sceneKey}/${spec.specNumber}/${spec.kind}`),
          kind: spec.kind,
          instructions: spec.instructions,
          outputCount: spec.outputCount,
          aspectRatio: spec.aspectRatio,
          durationMs: spec.durationMs,
          references: spec.references,
          constraints: spec.constraints,
          requiredCapabilities: spec.requiredCapabilities,
          requirementNotes: spec.requirementNotes,
          now,
        });
        specs += 1;
      }
    }
    return { scenePlans: draft.scenePlans.length, specs };
  }
}

/** What a planning run produced: the plan it wrote (or would have written), and why. */
export interface PlanProductionResult {
  outcome: PlannerOutcome;
  /** Null while nothing exists: a failed or dry run reports the plan it *would* have written to. */
  plan: ProductionPlan | null;
  version: ProductionPlanVersion | null;
  /** True when this call created the version it authored into. */
  created: boolean;
  /** True when an identical, still-valid plan version already existed, so nothing was written. */
  reused: boolean;
  validation: PlanValidationView | null;
  notices: readonly PlannerNotice[];
  findings: readonly PlanningFinding[];
  trace: readonly PlannerTraceStep[];
  rulesApplied: readonly string[];
  errors: readonly { code: string; message: string; field?: string }[];
  scenePlans: number;
  specs: number;
  planner: {
    plannerVersion: string;
    rulesVersion: string;
    seed: number;
    inputFingerprint: string;
    outputFingerprint: string | null;
    /** How many provider declarations the capability envelope was computed from. */
    providerCandidates: number;
    /** The registry this run executed, in order — proof of what the engine is allowed to do. */
    rules: readonly string[];
  };
  nextAction: string;
}

function summarize(run: PlannerRun, providerCandidates: number) {
  return {
    outcome: run.outcome,
    notices: run.notices,
    findings: run.findings,
    trace: run.trace,
    rulesApplied: run.rulesApplied,
    errors: run.errors,
    planner: {
      plannerVersion: run.plannerVersion,
      rulesVersion: run.rulesVersion,
      seed: run.seed,
      inputFingerprint: run.inputFingerprint,
      outputFingerprint: run.outputFingerprint,
      providerCandidates,
      rules: PLANNER_RULES.map((rule) => rule.id),
    },
  };
}

/** The plan-to-execution mapping lives beside this service; it is never invoked from here. */
export type { PlanExecutionMapping, PlannedJobIntent } from "./plan-execution.js";
export { mapPlanToJobs } from "./plan-execution.js";
