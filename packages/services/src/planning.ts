import {
  PLANNING_VALIDATOR_VERSION,
  isGenerationSpecKind,
  isProviderCapabilityKey,
  type CreativeBrief,
  type CreativeBriefConstraint,
  type GenerationSpec,
  type GenerationSpecKind,
  type PlanStory,
  type PlanValidationRecord,
  type PlanVersionSnapshot,
  type PlanningCharacterRecord,
  type PlanningReference,
  type ProductionPlan,
  type ProductionPlanVersion,
  type ProviderCapabilityKey,
  type ScenePlan,
  type VisualDnaDefinition,
  type WorldDefinition,
} from "@flowforge/core";
import { ApplicationError, translateRepositoryError, type ApplicationErrorDetails, type ApplicationErrorCode } from "./errors.js";
import { isoNow, type ServiceDeps } from "./deps.js";
import type { PlanningRepository, ProviderRegistry } from "./ports.js";
import {
  identifier,
  integerRange,
  optionalText,
  requiredText,
  textList,
} from "./validation.js";
import type {
  AddGenerationSpecCommand,
  AddScenePlanCommand,
  CreateBriefCommand,
  CreatePlanningCharacterCommand,
  CreatePlanCommand,
  CreateVisualDnaCommand,
  CreateWorldCommand,
  PlanLifecycleCommand,
  PlanVersionTarget,
  SetPlanCastCommand,
  SetPlanStoryCommand,
  SetScenePlanCastCommand,
} from "./commands.js";
import { validatePlanVersion, sortFindings } from "./plan-validation.js";
import {
  buildExecutionPreview,
  capabilityCoverageFor,
  loadPlanExecutability,
  planCastRows,
  planListItem,
  planningCounts,
  planningNextAction,
  resolveVisualDna,
  resolveWorld,
  toPlanApprovalView,
  toPlanPlannerView,
  toPlanValidationView,
  type ExecutionPreview,
  type PlanDetail,
  type PlanListItem,
  type PlanPlannerView,
  type PlanScenePlanRow,
  type PlanValidationView,
  type ProjectPlanningOverview,
} from "./planning-read-models.js";

/**
 * Application services for the creative planning domain (Phase 4A).
 *
 * Exactly like the Phase 3 services, these classes validate intent, delegate every write to the one
 * component that owns it (`SqlitePlanningRepository` for planning state, `SqliteJobRepository` for
 * the character identity table), and project the stored result into read models. They hold no SQL,
 * no queue, no retry algorithm, and no provider implementation. Nothing here can create a job:
 * handing a plan to execution is an explicit later step through the Phase 3 services.
 */

/** Raised when planning state is requested but the application was composed without it. */
export function planningNotConfigured(): ApplicationError {
  return new ApplicationError(
    "PLANNING_NOT_CONFIGURED",
    "This FlowForge application has no planning repository; create it with createApplication(repository, { planning }).",
    {},
  );
}

/** Shared with the planner service: the one gate that says whether planning is wired at all. */
export function requirePlanning(deps: ServiceDeps): PlanningRepository {
  if (!deps.planning) throw planningNotConfigured();
  return deps.planning;
}

/** Keeps repository rejections operator-readable without hiding anything unexpected. */
/** Shared with the planner service; a repository rejection must never surface as a raw driver error. */
export function attempt<T>(
  deps: ServiceDeps,
  run: () => T,
  code: ApplicationErrorCode,
  details: ApplicationErrorDetails = {},
): T {
  try {
    return run();
  } catch (error) {
    throw translateRepositoryError(error, code, details);
  }
}

/* -------------------------------------------------------------------------- */
/* Creative brief                                                              */
/* -------------------------------------------------------------------------- */

export class CreativeBriefService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Records an immutable intent snapshot. An identical snapshot is reused (idempotent), a different
   * one becomes the project's active brief and supersedes the previous version.
   */
  createBrief(input: CreateBriefCommand): { brief: CreativeBrief; created: boolean } {
    const planning = requirePlanning(this.deps);
    const projectId = identifier(input.projectId, "projectId");
    this.requireProject(projectId);
    const result = attempt(
      this.deps,
      () =>
        planning.createBrief({
          id: input.briefId === undefined ? undefined : identifier(input.briefId, "briefId"),
          projectId,
          title: requiredText(input.title, "title"),
          concept: optionalText(input.concept, "concept"),
          objective: optionalText(input.objective, "objective"),
          audience: optionalText(input.audience, "audience"),
          tone: optionalText(input.tone, "tone"),
          style: optionalText(input.style, "style"),
          constraints: briefConstraints(input.constraints),
          now: isoNow(this.deps, input.now),
        }),
      "PERSISTENCE_REJECTED",
      { projectId },
    );
    return result;
  }

  getBrief(briefIdInput: string): CreativeBrief {
    const planning = requirePlanning(this.deps);
    const briefId = identifier(briefIdInput, "briefId");
    const brief = planning.getBrief(briefId);
    if (!brief) throw new ApplicationError("NOT_FOUND", `Creative brief not found: ${briefId}`, { briefId });
    return brief;
  }

  listBriefs(projectIdInput: string): CreativeBrief[] {
    const planning = requirePlanning(this.deps);
    const projectId = identifier(projectIdInput, "projectId");
    this.requireProject(projectId);
    return planning.listBriefs(projectId);
  }

  currentBrief(projectIdInput: string): CreativeBrief | null {
    const planning = requirePlanning(this.deps);
    const projectId = identifier(projectIdInput, "projectId");
    this.requireProject(projectId);
    return planning.currentBrief(projectId);
  }

  private requireProject(projectId: string): void {
    if (!this.deps.repository.getProject(projectId)) {
      throw new ApplicationError("NOT_FOUND", `Project not found: ${projectId}`, { projectId });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Project definitions: characters, worlds, visual DNA                         */
/* -------------------------------------------------------------------------- */

export class PlanningDefinitionService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Creates a character through the existing owner of the `characters` table, then attaches planning
   * identity to the same stable ID. One identity, shared by execution and planning.
   */
  createCharacter(input: CreatePlanningCharacterCommand): PlanningCharacterRecord {
    const planning = requirePlanning(this.deps);
    const projectId = identifier(input.projectId, "projectId");
    if (!this.deps.repository.getProject(projectId)) {
      throw new ApplicationError("NOT_FOUND", `Project not found: ${projectId}`, { projectId });
    }
    const traits = input.traits === undefined
      ? undefined
      : {
          role: optionalText(input.traits.role, "traits.role"),
          appearance: requiredText(input.traits.appearance, "traits.appearance"),
          personality: requiredText(input.traits.personality, "traits.personality"),
          voice: optionalText(input.traits.voice, "traits.voice"),
        };
    const visualIdentity = input.visualIdentity === undefined
      ? undefined
      : {
          description: requiredText(input.visualIdentity.description, "visualIdentity.description"),
          distinguishingFeatures: textList(
            input.visualIdentity.distinguishingFeatures,
            "visualIdentity.distinguishingFeatures",
          ),
          palette: textList(input.visualIdentity.palette, "visualIdentity.palette"),
        };
    const now = isoNow(this.deps, input.now);
    return attempt(
      this.deps,
      () => {
        const character = this.deps.repository.createCharacter({
          id: input.characterId === undefined ? undefined : identifier(input.characterId, "characterId"),
          projectId,
          name: requiredText(input.name, "name"),
          description: optionalText(input.description, "description"),
          now,
        });
        if (traits === undefined && visualIdentity === undefined) {
          return planning.getCharacter(character.id) ?? character;
        }
        return planning.setCharacterIdentity({
          characterId: character.id,
          traits,
          visualIdentity,
          now,
        });
      },
      "PERSISTENCE_REJECTED",
      { projectId },
    );
  }

  listCharacters(projectIdInput: string): PlanningCharacterRecord[] {
    const planning = requirePlanning(this.deps);
    const projectId = identifier(projectIdInput, "projectId");
    this.requireProject(projectId);
    return planning.listProjectCharacters(projectId);
  }

  createWorld(input: CreateWorldCommand): { world: WorldDefinition; created: boolean } {
    const planning = requirePlanning(this.deps);
    const projectId = identifier(input.projectId, "projectId");
    this.requireProject(projectId);
    return attempt(
      this.deps,
      () =>
        planning.createWorld({
          id: input.worldId === undefined ? undefined : identifier(input.worldId, "worldId"),
          projectId,
          name: requiredText(input.name, "name"),
          description: optionalText(input.description, "description"),
          environment: optionalText(input.environment, "environment"),
          rules: textList(input.rules, "rules"),
          visualIdentity: input.visualIdentity === undefined
            ? undefined
            : {
                description: input.visualIdentity.description ?? "",
                palette: textList(input.visualIdentity.palette, "visualIdentity.palette"),
                lighting: input.visualIdentity.lighting ?? "",
              },
          now: isoNow(this.deps, input.now),
        }),
      "PERSISTENCE_REJECTED",
      { projectId },
    );
  }

  listWorlds(projectIdInput: string): WorldDefinition[] {
    const planning = requirePlanning(this.deps);
    const projectId = identifier(projectIdInput, "projectId");
    this.requireProject(projectId);
    return planning.listWorlds(projectId);
  }

  createVisualDna(input: CreateVisualDnaCommand): {
    visualDna: VisualDnaDefinition;
    created: boolean;
  } {
    const planning = requirePlanning(this.deps);
    const projectId = identifier(input.projectId, "projectId");
    this.requireProject(projectId);
    return attempt(
      this.deps,
      () =>
        planning.createVisualDna({
          id:
            input.visualDnaId === undefined
              ? undefined
              : identifier(input.visualDnaId, "visualDnaId"),
          projectId,
          name: requiredText(input.name, "name"),
          description: optionalText(input.description, "description"),
          style: requiredText(input.style, "style"),
          palette: textList(input.palette, "palette"),
          lighting: optionalText(input.lighting, "lighting"),
          composition: optionalText(input.composition, "composition"),
          cameraLanguage: optionalText(input.cameraLanguage, "cameraLanguage"),
          renderingStyle: optionalText(input.renderingStyle, "renderingStyle"),
          atmosphere: optionalText(input.atmosphere, "atmosphere"),
          consistencyRules: textList(input.consistencyRules, "consistencyRules"),
          now: isoNow(this.deps, input.now),
        }),
      "PERSISTENCE_REJECTED",
      { projectId },
    );
  }

  listVisualDna(projectIdInput: string): VisualDnaDefinition[] {
    const planning = requirePlanning(this.deps);
    const projectId = identifier(projectIdInput, "projectId");
    this.requireProject(projectId);
    return planning.listVisualDna(projectId);
  }

  private requireProject(projectId: string): void {
    if (!this.deps.repository.getProject(projectId)) {
      throw new ApplicationError("NOT_FOUND", `Project not found: ${projectId}`, { projectId });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Production plan aggregate                                                   */
/* -------------------------------------------------------------------------- */

export class ProductionPlanService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly reads: PlanningReadService,
  ) {}

  createPlan(input: CreatePlanCommand): {
    plan: ProductionPlan;
    version: ProductionPlanVersion;
    created: boolean;
  } {
    const planning = requirePlanning(this.deps);
    const projectId = identifier(input.projectId, "projectId");
    if (!this.deps.repository.getProject(projectId)) {
      throw new ApplicationError("NOT_FOUND", `Project not found: ${projectId}`, { projectId });
    }
    const briefId = identifier(input.briefId, "briefId");
    const brief = planning.getBrief(briefId);
    if (!brief) {
      throw new ApplicationError("NOT_FOUND", `Creative brief not found: ${briefId}`, { briefId });
    }
    if (brief.projectId !== projectId) {
      throw new ApplicationError("VALIDATION_FAILED", `Creative brief ${briefId} belongs to another project.`, {
        briefId,
        projectId,
      });
    }
    const result = attempt(
      this.deps,
      () =>
        planning.createPlanWithInitialVersion({
          id: input.planId === undefined ? undefined : identifier(input.planId, "planId"),
          projectId,
          briefId,
          title: requiredText(input.title, "title"),
          visualDnaId:
            input.visualDnaId === undefined ? undefined : identifier(input.visualDnaId, "visualDnaId"),
          now: isoNow(this.deps, input.now),
        }),
      "PERSISTENCE_REJECTED",
      { projectId, briefId },
    );
    return { plan: result.plan, version: result.version, created: result.created };
  }

  /**
   * Creates the next version by copying the current one. If the current version is still editable
   * there is nothing to fork, so the call is idempotent and reports `created: false` — a revision
   * never throws away an approved version and never mutates one.
   */
  revise(input: PlanLifecycleCommand): {
    version: ProductionPlanVersion;
    created: boolean;
    copiedScenePlans: number;
    copiedSpecs: number;
  } {
    const planning = requirePlanning(this.deps);
    const { plan, version } = this.reads.resolveVersion(input);
    if (version.status === "DRAFT" || version.status === "VALIDATED") {
      return { version, created: false, copiedScenePlans: 0, copiedSpecs: 0 };
    }
    const result = attempt(
      this.deps,
      () =>
        planning.copyPlanVersion({
          sourceVersionId: version.id,
          revisionNote: optionalText(input.note, "note"),
          now: isoNow(this.deps, input.now),
        }),
      "PERSISTENCE_REJECTED",
      { planId: plan.id, planVersionId: version.id },
    );
    return {
      version: result.version,
      created: true,
      copiedScenePlans: result.copiedScenePlans,
      copiedSpecs: result.copiedSpecs,
    };
  }

  /** VALIDATED -> DRAFT, so a fix is always re-validated before it can be approved. */
  reopen(input: PlanLifecycleCommand): ProductionPlanVersion {
    const planning = requirePlanning(this.deps);
    const { version } = this.reads.resolveVersion(input);
    if (version.status === "DRAFT") return version;
    if (version.status !== "VALIDATED") {
      throw new ApplicationError(
        "INVALID_STATE_TRANSITION",
        `Only a validated plan version can be reopened in place; plan version ${version.id} is ${version.status}. Use plan revise to fork a new version instead.`,
        { planVersionId: version.id, status: version.status },
      );
    }
    return attempt(
      this.deps,
      () =>
        planning.transitionPlanVersionStatus({
          planVersionId: version.id,
          to: "DRAFT",
          now: isoNow(this.deps, input.now),
        }),
      "INVALID_STATE_TRANSITION",
      { planVersionId: version.id },
    );
  }

  archive(input: PlanLifecycleCommand): ProductionPlanVersion {
    const planning = requirePlanning(this.deps);
    const { version } = this.reads.resolveVersion(input);
    if (version.status === "ARCHIVED") return version;
    return attempt(
      this.deps,
      () =>
        planning.transitionPlanVersionStatus({
          planVersionId: version.id,
          to: "ARCHIVED",
          now: isoNow(this.deps, input.now),
        }),
      "INVALID_STATE_TRANSITION",
      { planVersionId: version.id },
    );
  }

  /**
   * Explicit approval. It requires a `PASSED` evidence row recorded against the *current* content
   * hash, so approving after an edit is impossible rather than merely discouraged.
   */
  approve(input: PlanLifecycleCommand): {
    version: ProductionPlanVersion;
    validation: PlanValidationView;
    idempotent: boolean;
  } {
    const planning = requirePlanning(this.deps);
    const { version } = this.reads.resolveVersion(input);
    if (version.status === "APPROVED" || version.status === "EXECUTABLE") {
      const validation = this.reads.requireCurrentValidation(version);
      return { version, validation, idempotent: true };
    }
    if (version.status !== "VALIDATED") {
      throw new ApplicationError(
        "PLAN_VALIDATION_REQUIRED",
        `Plan version ${version.id} is ${version.status}; validate it before approval.`,
        { planVersionId: version.id, status: version.status },
      );
    }
    const validation = this.reads.requireCurrentValidation(version);
    if (validation.status !== "PASSED") {
      throw new ApplicationError(
        "PLAN_VALIDATION_REQUIRED",
        `Plan version ${version.id} has ${validation.errorCount} blocking finding(s); approval refused.`,
        { planVersionId: version.id, findings: validation.findings.filter((finding) => finding.severity === "ERROR") },
      );
    }
    const reviewer = requiredText(input.reviewer ?? "unknown", "reviewer");
    const updated = attempt(
      this.deps,
      () =>
        planning.transitionPlanVersionStatus({
          planVersionId: version.id,
          to: "APPROVED",
          approvedBy: reviewer,
          approvedValidationId: validation.validationId,
          now: isoNow(this.deps, input.now),
        }),
      "INVALID_STATE_TRANSITION",
      { planVersionId: version.id },
    );
    return { version: updated, validation: this.reads.requireValidationView(updated), idempotent: false };
  }

  /**
   * APPROVED -> EXECUTABLE. The gate is the existing provider capability model: every capability a
   * spec requires must be satisfiable by at least one *explicitly selected* provider ID. No provider
   * is constructed and no session is touched, so this check works with no browser and no auth.
   */
  markExecutable(input: PlanLifecycleCommand): {
    version: ProductionPlanVersion;
    capabilityCoverage: PlanDetail["executability"]["capabilityCoverage"];
    idempotent: boolean;
  } {
    const planning = requirePlanning(this.deps);
    const { snapshot, version } = this.reads.resolveSnapshot(input);
    if (version.status === "EXECUTABLE") {
      return {
        version,
        capabilityCoverage: capabilityCoverageFor(
          snapshot,
          this.deps.providers,
          version.executableProviders && version.executableProviders.length > 0
            ? version.executableProviders
            : undefined,
        ),
        idempotent: true,
      };
    }
    // The provider list is part of the invocation, so it is checked before plan state: an unknown
    // provider id is a wiring mistake whoever reports it, and refusing early keeps the message useful.
    const selected = providerSelection(input.providers, this.deps.providers, version);
    if (version.status !== "APPROVED") {
      throw new ApplicationError(
        "PLAN_NOT_APPROVED",
        `Plan version ${version.id} is ${version.status}; approve it before marking it executable.`,
        { planVersionId: version.id, status: version.status },
      );
    }
    this.reads.requireCurrentValidation(version);
    const coverage = capabilityCoverageFor(snapshot, this.deps.providers, selected);
    const unsatisfied = coverage.filter((row) => row.unsatisfied.length > 0);
    if (unsatisfied.length > 0) {
      throw new ApplicationError("PLAN_CAPABILITY_UNMET", "No selected provider can satisfy every generation spec of this plan version.", {
        planVersionId: version.id,
        selectedProviders: selected,
        unmet: unsatisfied.map((row) => ({
          specId: row.specId,
          sceneKey: row.sceneKey,
          unsatisfiedCapabilities: row.unsatisfied,
        })),
      });
    }
    if (snapshot.scenePlans.length === 0 || snapshot.specs.length === 0) {
      throw new ApplicationError(
        "PLAN_NOT_EXECUTABLE",
        "An executable plan version needs at least one scene plan with a generation spec.",
        { planVersionId: version.id, scenePlans: snapshot.scenePlans.length, specs: snapshot.specs.length },
      );
    }
    const updated = attempt(
      this.deps,
      () =>
        planning.transitionPlanVersionStatus({
          planVersionId: version.id,
          to: "EXECUTABLE",
          executableProviders: selected,
          now: isoNow(this.deps, input.now),
        }),
      "INVALID_STATE_TRANSITION",
      { planVersionId: version.id },
    );
    return {
      version: updated,
      capabilityCoverage: capabilityCoverageFor(snapshot, this.deps.providers, selected),
      idempotent: false,
    };
  }

  setStory(input: SetPlanStoryCommand): PlanStory {
    const planning = requirePlanning(this.deps);
    const { version } = this.reads.resolveVersion(input);
    return attempt(
      this.deps,
      () =>
        planning.upsertStory({
          planVersionId: version.id,
          premise: requiredText(input.premise, "premise"),
          structure: optionalText(input.structure, "structure"),
          themes: textList(input.themes, "themes"),
          beginning: optionalText(input.beginning, "beginning"),
          development: optionalText(input.development, "development"),
          ending: optionalText(input.ending, "ending"),
          now: isoNow(this.deps, input.now),
        }),
      "PERSISTENCE_REJECTED",
      { planVersionId: version.id },
    );
  }

  setCast(input: SetPlanCastCommand): PlanDetail["cast"] {
    const planning = requirePlanning(this.deps);
    const { snapshot, version } = this.reads.resolveSnapshot(input);
    const cast = (input.cast ?? []).map((link, index) => ({
      characterId: identifier(link.characterId, `cast[${index}].characterId`),
      role: link.role ?? "",
    }));
    for (const link of cast) {
      const character = planning.getCharacter(link.characterId);
      if (!character || character.projectId !== snapshot.plan.projectId) {
        throw new ApplicationError(
          "VALIDATION_FAILED",
          `Cast character ${link.characterId} is not a character of project ${snapshot.plan.projectId}.`,
          { planVersionId: version.id, characterId: link.characterId },
        );
      }
    }
    attempt(
      this.deps,
      () => planning.replacePlanCast({ planVersionId: version.id, cast, now: isoNow(this.deps, input.now) }),
      "PERSISTENCE_REJECTED",
      { planVersionId: version.id },
    );
    return planCastRows(this.reads.snapshot(version.id));
  }

  addScenePlan(input: AddScenePlanCommand): ScenePlan {
    const planning = requirePlanning(this.deps);
    const { snapshot, version } = this.reads.resolveSnapshot(input);
    const sceneNumber =
      input.sceneNumber ??
      snapshot.scenePlans.reduce((max, node) => Math.max(max, node.scenePlan.sceneNumber), 0) + 1;
    const cast = (input.cast ?? []).map((link, index) => ({
      characterId: identifier(link.characterId, `cast[${index}].characterId`),
      role: link.role ?? "",
      position: link.position,
    }));
    return attempt(
      this.deps,
      () =>
        planning.addScenePlan({
          // The planner authors with pre-minted ids so a re-plan is addressable; every other caller lets
          // the repository mint one. Either way the row is written by the same reviewed method.
          id: input.scenePlanId === undefined ? undefined : identifier(input.scenePlanId, "scenePlanId"),
          planVersionId: version.id,
          sceneKey: identifier(input.sceneKey, "sceneKey"),
          sceneNumber: integerRange(sceneNumber, "sceneNumber", { min: 1, max: 9_999 }),
          title: requiredText(input.title, "title"),
          narrativePurpose: optionalText(input.narrativePurpose, "narrativePurpose") ?? "",
          description: optionalText(input.description, "description") ?? "",
          durationTargetMs:
            input.durationTargetMs === undefined
              ? undefined
              : integerRange(input.durationTargetMs, "durationTargetMs", { min: 1, max: 3_600_000 }),
          worldId: input.worldId === undefined ? undefined : identifier(input.worldId, "worldId"),
          visualDnaId:
            input.visualDnaId === undefined ? undefined : identifier(input.visualDnaId, "visualDnaId"),
          continuity: continuityList(input.continuity),
          requiredReferences: referenceList(input.requiredReferences),
          plannedOutputs: plannedOutputs(input.plannedOutputs),
          cast,
          now: isoNow(this.deps, input.now),
        }),
      "PERSISTENCE_REJECTED",
      { planVersionId: version.id, sceneKey: input.sceneKey },
    ).scenePlan;
  }

  setScenePlanCast(input: SetScenePlanCastCommand): PlanScenePlanRow {
    const planning = requirePlanning(this.deps);
    const scenePlanId = identifier(input.scenePlanId, "scenePlanId");
    const snapshot = this.reads.snapshotForScenePlan(scenePlanId);
    const cast = (input.cast ?? []).map((link, index) => ({
      characterId: identifier(link.characterId, `cast[${index}].characterId`),
      role: link.role ?? "",
      position: link.position,
    }));
    attempt(
      this.deps,
      () => planning.replaceScenePlanCast({ scenePlanId, cast, now: isoNow(this.deps, input.now) }),
      "PERSISTENCE_REJECTED",
      { scenePlanId },
    );
    return this.reads.scenePlanRow(snapshot, scenePlanId);
  }

  removeScenePlan(input: { scenePlanId: string; now?: string }): void {
    const planning = requirePlanning(this.deps);
    const scenePlanId = identifier(input.scenePlanId, "scenePlanId");
    attempt(
      this.deps,
      () => planning.deleteScenePlan({ scenePlanId, now: isoNow(this.deps, input.now) }),
      "PLAN_NOT_EDITABLE",
      { scenePlanId },
    );
  }

  addGenerationSpec(input: AddGenerationSpecCommand): GenerationSpec {
    const planning = requirePlanning(this.deps);
    const scenePlanId = identifier(input.scenePlanId, "scenePlanId");
    if (!isGenerationSpecKind(input.kind)) {
      throw new ApplicationError(
        "VALIDATION_FAILED",
        `kind must be one of image, video, audio, text; received "${String(input.kind)}".`,
        { field: "kind" },
      );
    }
    // Narrowed before the write closure so the persisted kind is one the domain understands.
    const kind = input.kind;
    const capabilities = (input.requiredCapabilities ?? []).map((capability, index) => {
      if (!isProviderCapabilityKey(capability)) {
        throw new ApplicationError(
          "VALIDATION_FAILED",
          `requiredCapabilities[${index}] must be a ProviderCapabilities key (${capability}).`,
          { field: "requiredCapabilities" },
        );
      }
      return capability as ProviderCapabilityKey;
    });
    return attempt(
      this.deps,
      () =>
        planning.addGenerationSpec({
          id: input.specId === undefined ? undefined : identifier(input.specId, "specId"),
          scenePlanId,
          kind,
          instructions: requiredText(input.instructions, "instructions"),
          outputCount: integerRange(input.outputCount ?? 1, "outputCount", { min: 1, max: 32 }),
          aspectRatio: optionalText(input.aspectRatio, "aspectRatio"),
          durationMs:
            input.durationMs === undefined
              ? undefined
              : integerRange(input.durationMs, "durationMs", { min: 250, max: 3_600_000 }),
          references: referenceList(input.references),
          constraints: textList(input.constraints, "constraints"),
          requiredCapabilities: capabilities,
          requirementNotes: optionalText(input.requirementNotes, "requirementNotes"),
          now: isoNow(this.deps, input.now),
        }),
      "PERSISTENCE_REJECTED",
      { scenePlanId },
    ).spec;
  }

  removeGenerationSpec(input: { specId: string; now?: string }): void {
    const planning = requirePlanning(this.deps);
    const specId = identifier(input.specId, "specId");
    attempt(
      this.deps,
      () => planning.deleteGenerationSpec({ specId, now: isoNow(this.deps, input.now) }),
      "PLAN_NOT_EDITABLE",
      { specId },
    );
  }

  setCurrentVersion(input: PlanVersionTarget & { now?: string }): ProductionPlan {
    const planning = requirePlanning(this.deps);
    const { plan, version } = this.reads.resolveVersion(input);
    return attempt(
      this.deps,
      () => planning.setPlanCurrentVersion(plan.id, version.id, isoNow(this.deps, input.now)),
      "PERSISTENCE_REJECTED",
      { planId: plan.id },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export class PlanningValidationService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly reads: PlanningReadService,
  ) {}

  /**
   * Runs the deterministic validator over the stored aggregate, appends the evidence, and moves the
   * version's status to match: DRAFT -> VALIDATED when nothing blocks, VALIDATED -> DRAFT when the
   * content behind a passing validation no longer matches. Returns the report either way, because a
   * failing validation is information for the operator, not a crash.
   */
  validate(input: PlanVersionTarget & { now?: string }): {
    report: PlanValidationView;
    version: ProductionPlanVersion;
    transitioned: boolean;
    evidenceReused: boolean;
  } {
    const planning = requirePlanning(this.deps);
    const { snapshot, version } = this.reads.resolveSnapshot(input);
    const now = isoNow(this.deps, input.now);
    const contentHash = planning.planVersionContentHash(version.id);
    const findings = sortFindings(
      validatePlanVersion(snapshot, {
        providers: this.deps.providers.size > 0 ? this.deps.providers : undefined,
      }),
    );
    const errorCount = findings.filter((finding) => finding.severity === "ERROR").length;
    const record = attempt(
      this.deps,
      () =>
        planning.recordPlanValidation({
          planVersionId: version.id,
          validatorVersion: PLANNING_VALIDATOR_VERSION,
          status: errorCount === 0 ? "PASSED" : "FAILED",
          contentHash,
          findings,
          now,
        }),
      "PERSISTENCE_REJECTED",
      { planVersionId: version.id },
    );
    let transitioned = false;
    let current = version;
    if (errorCount === 0 && version.status === "DRAFT") {
      current = attempt(
        this.deps,
        () => planning.transitionPlanVersionStatus({ planVersionId: version.id, to: "VALIDATED", now }),
        "INVALID_STATE_TRANSITION",
        { planVersionId: version.id },
      );
      transitioned = true;
    } else if (errorCount > 0 && version.status === "VALIDATED") {
      current = attempt(
        this.deps,
        () => planning.transitionPlanVersionStatus({ planVersionId: version.id, to: "DRAFT", now }),
        "INVALID_STATE_TRANSITION",
        { planVersionId: version.id },
      );
      transitioned = true;
    }
    return {
      report:
        this.reads.validationView(current, record.validation) ?? this.reads.requireValidationView(current),
      version: current,
      transitioned,
      evidenceReused: !record.created,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Read models                                                                 */
/* -------------------------------------------------------------------------- */

export class PlanningReadService {
  constructor(private readonly deps: ServiceDeps) {}

  listPlans(projectIdInput: string): PlanListItem[] {
    const planning = requirePlanning(this.deps);
    const projectId = identifier(projectIdInput, "projectId");
    if (!this.deps.repository.getProject(projectId)) {
      throw new ApplicationError("NOT_FOUND", `Project not found: ${projectId}`, { projectId });
    }
    return planning
      .listPlans(projectId)
      .map((plan) => this.planSummary(plan.id))
      .filter((summary): summary is PlanListItem => summary !== null);
  }

  getPlan(planIdInput: string): ProductionPlan {
    const planning = requirePlanning(this.deps);
    const planId = identifier(planIdInput, "planId");
    const plan = planning.getPlan(planId);
    if (!plan) throw new ApplicationError("NOT_FOUND", `Production plan not found: ${planId}`, { planId });
    return plan;
  }

  planSummary(planIdInput: string): PlanListItem | null {
    const plan = this.getPlan(planIdInput);
    const versionId = plan.currentVersionId;
    if (!versionId) return null;
    const snapshot = this.snapshot(versionId);
    const validation = this.validationView(snapshot.version);
    const executability = loadPlanExecutability(this.planning, this.deps.providers, snapshot);
    return planListItem(snapshot, validation, executability);
  }

  inspect(input: PlanVersionTarget): PlanDetail {
    const { snapshot } = this.resolveSnapshot(input);
    const planning = this.planning;
    const { version, plan } = snapshot;
    const validation = this.validationView(version);
    const executability = loadPlanExecutability(planning, this.deps.providers, snapshot);
    const counts = planningCounts(snapshot);
    return {
      plan,
      brief: snapshot.brief,
      version,
      planner: toPlanPlannerView(version, planning.planVersionContentHash(version.id)),
      lineage: {
        predecessorVersionId: version.predecessorVersionId,
        successorVersionIds: planning
          .listPlanVersions(plan.id)
          .filter((candidate) => candidate.predecessorVersionId === version.id)
          .map((candidate) => candidate.id),
      },
      story: snapshot.story,
      cast: planCastRows(snapshot),
      worlds: snapshot.worlds.map((world) => ({
        id: world.id,
        name: world.name,
        versionNumber: world.versionNumber,
        status: world.status,
        environment: world.environment,
      })),
      visualDna: snapshot.visualDna.map((dna) => ({
        id: dna.id,
        name: dna.name,
        versionNumber: dna.versionNumber,
        status: dna.status,
        style: dna.style,
      })),
      scenePlans: snapshot.scenePlans.map((node) => this.scenePlanRow(snapshot, node.scenePlan.id)),
      counts,
      validation,
      approval: toPlanApprovalView(version),
      executability,
      nextAction: planningNextAction(version, validation, counts),
    };
  }

  versions(planIdInput: string): Array<{
    planVersionId: string;
    versionNumber: number;
    status: ProductionPlanVersion["status"];
    contentHash: string;
    predecessorVersionId?: string;
    revisionNote?: string;
    scenePlans: number;
    generationSpecs: number;
    validationStatus: PlanValidationRecord["status"] | null;
    validationIsCurrent: boolean;
    approvedBy?: string;
    approvedAt?: string;
    executableProviders?: string[];
    planned: boolean;
    plannerVersion?: string;
    plannerRulesVersion?: string;
    plannerSeed?: number;
    unchangedSincePlanning: boolean | null;
  }> {
    const plan = this.getPlan(planIdInput);
    return this.planning.listPlanVersions(plan.id).map((version) => {
      const snapshot = this.snapshot(version.id);
      const validation = this.validationView(version);
      return {
        planVersionId: version.id,
        versionNumber: version.versionNumber,
        status: version.status,
        contentHash: version.contentHash,
        predecessorVersionId: version.predecessorVersionId,
        revisionNote: version.revisionNote,
        scenePlans: snapshot.scenePlans.length,
        generationSpecs: snapshot.specs.length,
        validationStatus: validation?.status ?? null,
        validationIsCurrent: validation?.isCurrent ?? false,
        approvedBy: version.approvedBy,
        approvedAt: version.approvedAt,
        executableProviders: version.executableProviders,
        // Planning provenance, so a version list says which entries a deterministic run authored and
        // whether anyone has edited them since. `null` means "not planned", never "broken".
        planned: version.plannerVersion !== undefined,
        plannerVersion: version.plannerVersion,
        plannerRulesVersion: version.plannerRulesVersion,
        plannerSeed: version.plannerSeed,
        unchangedSincePlanning:
          version.plannerContentHash === undefined ? null : version.plannerContentHash === version.contentHash,
      };
    });
  }

  validationReport(input: PlanVersionTarget): PlanValidationView {
    const { version } = this.resolveVersion(input);
    return this.requireCurrentValidation(version);
  }

  executionPreview(input: PlanVersionTarget): ExecutionPreview {
    const { snapshot } = this.resolveSnapshot(input);
    return buildExecutionPreview(
      snapshot,
      this.deps.providers,
      capabilityCoverageFor(
        snapshot,
        this.deps.providers,
        snapshot.version.status === "EXECUTABLE" && snapshot.version.executableProviders?.length
          ? snapshot.version.executableProviders
          : undefined,
      ),
    );
  }

  projectOverview(projectIdInput: string): ProjectPlanningOverview {
    const planning = requirePlanning(this.deps);
    const projectId = identifier(projectIdInput, "projectId");
    if (!this.deps.repository.getProject(projectId)) {
      throw new ApplicationError("NOT_FOUND", `Project not found: ${projectId}`, { projectId });
    }
    return {
      projectId,
      briefs: planning.listBriefs(projectId),
      characters: planning.listProjectCharacters(projectId).map((character) => ({
        id: character.id,
        name: character.name,
        description: character.description,
      })),
      worlds: planning.listWorlds(projectId).map((world) => ({
        id: world.id,
        name: world.name,
        versionNumber: world.versionNumber,
        status: world.status,
      })),
      visualDna: planning.listVisualDna(projectId).map((dna) => ({
        id: dna.id,
        name: dna.name,
        versionNumber: dna.versionNumber,
        status: dna.status,
      })),
      plans: this.listPlans(projectId),
    };
  }

  /* ------------------------------- internals -------------------------------- */

  get planning(): PlanningRepository {
    return requirePlanning(this.deps);
  }

  /** Resolves the version a command targets: an explicit number, else the plan's current pointer. */
  resolveVersion(input: PlanVersionTarget): {
    plan: ProductionPlan;
    version: ProductionPlanVersion;
  } {
    const plan = this.getPlan(input.planId);
    if (input.versionNumber === undefined) {
      const versionId = plan.currentVersionId;
      if (!versionId) {
        throw new ApplicationError("NOT_FOUND", `Production plan ${plan.id} has no versions.`, {
          planId: plan.id,
        });
      }
      const version = this.planning.getPlanVersion(versionId);
      if (!version) {
        throw new ApplicationError("NOT_FOUND", `Plan version not found: ${versionId}`, {
          planVersionId: versionId,
        });
      }
      return { plan, version };
    }
    const versionNumber = integerRange(input.versionNumber, "versionNumber", { min: 1, max: 9_999 });
    const version = this.planning.getPlanVersionByNumber(plan.id, versionNumber);
    if (!version) {
      throw new ApplicationError("NOT_FOUND", `Plan version ${versionNumber} not found for plan ${plan.id}.`, {
        planId: plan.id,
        versionNumber,
      });
    }
    return { plan, version };
  }

  resolveSnapshot(input: PlanVersionTarget): {
    plan: ProductionPlan;
    version: ProductionPlanVersion;
    snapshot: PlanVersionSnapshot;
  } {
    const { plan, version } = this.resolveVersion(input);
    return { plan, version, snapshot: this.snapshot(version.id) };
  }

  snapshot(planVersionId: string): PlanVersionSnapshot {
    const snapshot = this.planning.loadPlanVersionSnapshot(planVersionId);
    if (!snapshot) {
      throw new ApplicationError("NOT_FOUND", `Plan version not found: ${planVersionId}`, { planVersionId });
    }
    return snapshot;
  }

  /** Resolves the version that owns a scene plan, so spec commands can address it directly. */
  snapshotForScenePlan(scenePlanIdInput: string): PlanVersionSnapshot {
    const scenePlanId = identifier(scenePlanIdInput, "scenePlanId");
    const scenePlan = this.planning.getScenePlan(scenePlanId);
    if (!scenePlan) {
      throw new ApplicationError("NOT_FOUND", `Scene plan not found: ${scenePlanId}`, { scenePlanId });
    }
    return this.snapshot(scenePlan.planVersionId);
  }

  scenePlanRow(snapshot: PlanVersionSnapshot, scenePlanId: string): PlanScenePlanRow {
    const node = snapshot.scenePlans.find((candidate) => candidate.scenePlan.id === scenePlanId);
    if (!node) {
      throw new ApplicationError("NOT_FOUND", `Scene plan not found: ${scenePlanId}`, { scenePlanId });
    }
    return toScenePlanRow(snapshot, node.scenePlan, node.specs, node.cast);
  }

  /** Latest recorded evidence rendered for display; `null` when the version was never validated. */
  validationView(version: ProductionPlanVersion, record?: PlanValidationRecord | null): PlanValidationView | null {
    const stored = record === undefined ? this.planning.getLatestPlanValidation(version.id) : record;
    return toPlanValidationView(stored, version);
  }

  /** The same view for the paths that legitimately require evidence (`plan report`). */
  requireValidationView(version: ProductionPlanVersion): PlanValidationView {
    const view = this.validationView(version);
    if (!view) {
      throw new ApplicationError("NOT_FOUND", `No validation evidence for plan version ${version.id}.`, {
        planVersionId: version.id,
      });
    }
    return view;
  }

  /** Approval requires evidence about the content *as it stands now*, never a stale report. */
  requireCurrentValidation(version: ProductionPlanVersion): PlanValidationView {
    const stored = this.planning.getLatestPlanValidation(version.id);
    if (!stored) {
      throw new ApplicationError(
        "PLAN_VALIDATION_REQUIRED",
        `Plan version ${version.id} has never been validated.`,
        { planVersionId: version.id },
      );
    }
    const view = toPlanValidationView(stored, version);
    if (!view?.isCurrent) {
      throw new ApplicationError(
        "PLAN_VALIDATION_REQUIRED",
        `Plan version ${version.id} changed after it was validated; validate again before this transition.`,
        {
          planVersionId: version.id,
          validatedContentHash: stored.contentHash,
          currentContentHash: version.contentHash,
        },
      );
    }
    return view;
  }

}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

function toScenePlanRow(
  snapshot: PlanVersionSnapshot,
  scenePlan: ScenePlan,
  specs: readonly GenerationSpec[],
  cast: readonly { characterId: string; role: string; position: number }[],
): PlanScenePlanRow {
  const names = new Map(snapshot.characters.map((character) => [character.id, character.name]));
  return {
    scenePlanId: scenePlan.id,
    sceneKey: scenePlan.sceneKey,
    sceneNumber: scenePlan.sceneNumber,
    title: scenePlan.title,
    narrativePurpose: scenePlan.narrativePurpose,
    description: scenePlan.description,
    durationTargetMs: scenePlan.durationTargetMs,
    world: resolveWorld(scenePlan, snapshot),
    visualDna: resolveVisualDna(scenePlan, snapshot.version, snapshot),
    cast: [...cast]
      .sort((left, right) => left.position - right.position)
      .map((link) => ({
        characterId: link.characterId,
        name: names.get(link.characterId) ?? `${link.characterId} (unknown)`,
        role: link.role,
        position: link.position,
      })),
    requiredReferences: scenePlan.requiredReferences,
    continuity: scenePlan.continuity,
    plannedOutputs: scenePlan.plannedOutputs,
    specs: [...specs].sort((left, right) => left.specNumber - right.specNumber),
  };
}

function briefConstraints(
  value: CreateBriefCommand["constraints"],
): CreativeBriefConstraint[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "constraints must be an array.", { field: "constraints" });
  }
  return value.map((constraint, index) => ({
    kind: constraintKind(constraint?.kind, index),
    value: requiredText(constraint?.value, `constraints[${index}].value`),
  }));
}

function constraintKind(value: unknown, index: number): CreativeBriefConstraint["kind"] {
  if (value === "MUST" || value === "MUST_NOT" || value === "PREFERENCE") return value;
  throw new ApplicationError(
    "VALIDATION_FAILED",
    `constraints[${index}].kind must be MUST, MUST_NOT, or PREFERENCE.`,
    { field: `constraints[${index}].kind` },
  );
}

function continuityList(value: AddScenePlanCommand["continuity"]) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "continuity must be an array.", { field: "continuity" });
  }
  return value.map((entry, index) => ({
    statement: requiredText(entry.statement, `continuity[${index}].statement`),
    source: optionalText(entry.source, `continuity[${index}].source`),
  }));
}

function referenceList(value: AddScenePlanCommand["requiredReferences"]): PlanningReference[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "requiredReferences must be an array.", {
      field: "requiredReferences",
    });
  }
  return value.map((reference, index) => {
    if (reference.kind !== "character" && reference.kind !== "world" && reference.kind !== "visualDna" && reference.kind !== "scenePlan" && reference.kind !== "assetVersion") {
      throw new ApplicationError(
        "VALIDATION_FAILED",
        `requiredReferences[${index}].kind must be character, world, visualDna, scenePlan, or assetVersion.`,
        { field: `requiredReferences[${index}].kind` },
      );
    }
    return {
      kind: reference.kind as PlanningReference["kind"],
      id: identifier(reference.id, `requiredReferences[${index}].id`),
      note: optionalText(reference.note, `requiredReferences[${index}].note`),
    };
  });
}

function plannedOutputKind(value: unknown, index: number): GenerationSpecKind {
  if (!isGenerationSpecKind(value)) {
    throw new ApplicationError(
      "VALIDATION_FAILED",
      `plannedOutputs[${index}].kind must be image, video, audio, or text.`,
      { field: `plannedOutputs[${index}].kind` },
    );
  }
  return value;
}

function plannedOutputs(value: AddScenePlanCommand["plannedOutputs"]) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "plannedOutputs must be an array.", {
      field: "plannedOutputs",
    });
  }
  return value.map((entry, index) => ({
    kind: plannedOutputKind(entry.kind, index),
    count: integerRange(entry.count ?? 1, `plannedOutputs[${index}].count`, { min: 1, max: 32 }),
    note: optionalText(entry.note, `plannedOutputs[${index}].note`),
  }));
}

/**
 * Provider IDs selected for executability. Unknown IDs are refused rather than ignored, and the
 * registry is only *read* — a provider is never constructed, so this path needs no browser, no
 * credentials, and no network.
 */
function providerSelection(
  providers: readonly string[] | undefined,
  registry: ProviderRegistry,
  version: ProductionPlanVersion,
): string[] {
  if (providers === undefined || providers.length === 0) {
    throw new ApplicationError(
      "VALIDATION_FAILED",
      "Marking a plan executable requires an explicit --provider list of configured provider ids.",
      { planVersionId: version.id, configuredProviders: [...registry.keys()].sort() },
    );
  }
  const selected = [...new Set(providers.map((provider) => requiredText(provider, "provider")))];
  const unknown = selected.filter((provider) => !registry.has(provider));
  if (unknown.length > 0) {
    throw new ApplicationError(
      "PROVIDER_NOT_CONFIGURED",
      `Provider(s) ${unknown.join(", ")} are not configured for capability checks in this process.`,
      { unknown, configuredProviders: [...registry.keys()].sort() },
    );
  }
  return selected.sort();
}
