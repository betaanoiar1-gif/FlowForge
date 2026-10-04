import type {
  CharacterRecord,
  CreativeBrief,
  GenerationSpec,
  PlanStory,
  PlanValidationRecord,
  PlanVersionSnapshot,
  PlanVersionStatus,
  ProviderCapabilityKey,
  ScenePlan,
  VisualDnaDefinition,
  WorldDefinition,
  ProductionPlan,
  ProductionPlanVersion,
} from "@flowforge/core";
import type { PlanningRepository, ProviderRegistry } from "./ports.js";

/**
 * Operator read models for the creative planning domain. Every shape here is derived from the
 * aggregate snapshot the repository returns — the same numbers the JSON output of the CLI prints —
 * so a human reading a table and a script reading `--json` cannot disagree.
 */

export type PlanningNextAction =
  | "AUTHOR_PLAN"
  | "VALIDATE_PLAN"
  | "REVALIDATE_PLAN"
  | "APPROVE_PLAN"
  | "MARK_EXECUTABLE"
  | "EXECUTE_VIA_PHASE_3"
  | "PLAN_ARCHIVED";

export interface PlanningCounts {
  scenePlans: number;
  generationSpecs: number;
  cast: number;
  worlds: number;
  visualDna: number;
}

export interface PlanValidationView {
  validationId: string;
  validatorVersion: string;
  status: PlanValidationRecord["status"];
  contentHash: string;
  /** False when the version's content changed after the evidence was recorded. */
  isCurrent: boolean;
  errorCount: number;
  warningCount: number;
  recordedAt: string;
  findings: PlanValidationRecord["findings"];
}

export interface PlanApprovalView {
  status: PlanVersionStatus;
  approvedBy?: string;
  approvedAt?: string;
  approvedValidationId?: string;
  executableAt?: string;
  executableProviders?: string[];
}

export interface PlanExecutabilityView {
  executable: boolean;
  blockers: string[];
  capabilityCoverage: PlanCapabilityCoverage[];
}

export interface PlanCapabilityCoverage {
  specId: string;
  sceneKey: string;
  kind: GenerationSpec["kind"];
  requiredCapabilities: ProviderCapabilityKey[];
  candidateProviders: string[];
  unsatisfied: ProviderCapabilityKey[];
}

export interface PlanListItem {
  planId: string;
  projectId: string;
  title: string;
  versionNumber: number;
  planVersionId: string;
  status: PlanVersionStatus;
  contentHash: string;
  updatedAt: string;
  brief: Pick<CreativeBrief, "id" | "versionNumber" | "title" | "status"> | null;
  counts: PlanningCounts;
  validation: PlanValidationView | null;
  nextAction: PlanningNextAction;
  blockers: string[];
}

export interface PlanCastRow {
  characterId: string;
  name: string;
  role: string;
  inProject: boolean;
  hasIdentityTraits: boolean;
}

export interface PlanScenePlanRow {
  scenePlanId: string;
  sceneKey: string;
  sceneNumber: number;
  title: string;
  narrativePurpose: string;
  description: string;
  durationTargetMs?: number;
  world: Pick<WorldDefinition, "id" | "name" | "versionNumber"> | null;
  visualDna: PlanVisualDnaResolution | null;
  cast: Array<{ characterId: string; name: string; role: string; position: number }>;
  requiredReferences: ScenePlan["requiredReferences"];
  continuity: ScenePlan["continuity"];
  plannedOutputs: ScenePlan["plannedOutputs"];
  specs: GenerationSpec[];
}

export interface PlanVisualDnaResolution {
  visualDnaId: string;
  name: string;
  versionNumber: number;
  source: "scenePlan" | "planVersion";
  resolvedInProject: boolean;
}

export interface PlanDetail {
  plan: ProductionPlan;
  brief: CreativeBrief | null;
  version: ProductionPlanVersion;
  lineage: {
    predecessorVersionId?: string;
    successorVersionIds: string[];
  };
  story: PlanStory | null;
  cast: PlanCastRow[];
  worlds: Array<Pick<WorldDefinition, "id" | "name" | "versionNumber" | "status" | "environment">>;
  visualDna: Array<Pick<VisualDnaDefinition, "id" | "name" | "versionNumber" | "status" | "style">>;
  scenePlans: PlanScenePlanRow[];
  counts: PlanningCounts;
  validation: PlanValidationView | null;
  approval: PlanApprovalView;
  executability: PlanExecutabilityView;
  nextAction: PlanningNextAction;
}

export interface ExecutionPreviewItem {
  scenePlanId: string;
  sceneKey: string;
  sceneNumber: number;
  specId: string;
  specNumber: number;
  kind: GenerationSpec["kind"];
  /** The scene title a future execution would create for this planned unit. */
  sceneTitle: string;
  sceneVersionTitle: string;
  /** The prompt a future execution would submit; the spec's instructions verbatim. */
  prompt: string;
  outputCount: number;
  aspectRatio?: string;
  durationMs?: number;
  references: string[];
  metadata: Record<string, unknown>;
  requiredCapabilities: ProviderCapabilityKey[];
  candidateProviders: string[];
  acceptable: boolean;
  reason?: string;
}

export interface ExecutionPreview {
  planId: string;
  planVersionId: string;
  versionNumber: number;
  status: PlanVersionStatus;
  executable: boolean;
  items: ExecutionPreviewItem[];
  blockers: string[];
  note: string;
}

export interface ProjectPlanningOverview {
  projectId: string;
  briefs: CreativeBrief[];
  characters: Array<Pick<CharacterRecord, "id" | "name" | "description">>;
  worlds: Array<Pick<WorldDefinition, "id" | "name" | "versionNumber" | "status">>;
  visualDna: Array<Pick<VisualDnaDefinition, "id" | "name" | "versionNumber" | "status">>;
  plans: PlanListItem[];
}

export function planningCounts(snapshot: PlanVersionSnapshot): PlanningCounts {
  return {
    scenePlans: snapshot.scenePlans.length,
    generationSpecs: snapshot.specs.length,
    cast: snapshot.cast.length,
    worlds: snapshot.worlds.length,
    visualDna: snapshot.visualDna.length,
  };
}

export function toPlanValidationView(
  record: PlanValidationRecord | null,
  version: ProductionPlanVersion,
): PlanValidationView | null {
  if (!record) return null;
  return {
    validationId: record.id,
    validatorVersion: record.validatorVersion,
    status: record.status,
    contentHash: record.contentHash,
    isCurrent: record.contentHash === version.contentHash,
    errorCount: record.errorCount,
    warningCount: record.warningCount,
    recordedAt: record.createdAt,
    findings: record.findings,
  };
}

export function toPlanApprovalView(version: ProductionPlanVersion): PlanApprovalView {
  return {
    status: version.status,
    approvedBy: version.approvedBy,
    approvedAt: version.approvedAt,
    approvedValidationId: version.approvedValidationId,
    executableAt: version.executableAt,
    executableProviders: version.executableProviders,
  };
}

export function planningNextAction(
  version: ProductionPlanVersion,
  validation: PlanValidationView | null,
  counts: PlanningCounts,
): PlanningNextAction {
  switch (version.status) {
    case "ARCHIVED":
      return "PLAN_ARCHIVED";
    case "EXECUTABLE":
      return "EXECUTE_VIA_PHASE_3";
    case "APPROVED":
      return "MARK_EXECUTABLE";
    case "VALIDATED":
      return validation && !validation.isCurrent ? "REVALIDATE_PLAN" : "APPROVE_PLAN";
    case "DRAFT":
    default:
      return counts.scenePlans === 0 ? "AUTHOR_PLAN" : "VALIDATE_PLAN";
  }
}

/**
 * Blocker codes are the *reasons* an operator cannot go one step further right now. They combine the
 * lifecycle requirement with the current validation evidence, and are derived — never stored.
 */
export function planningBlockers(
  version: ProductionPlanVersion,
  validation: PlanValidationView | null,
  counts: PlanningCounts,
  executability: PlanExecutabilityView,
): string[] {
  const blockers: string[] = [];
  if (version.status === "ARCHIVED") return ["PLAN_ARCHIVED"];
  if (counts.scenePlans === 0) blockers.push("PLAN_HAS_NO_SCENES");
  if (version.status === "DRAFT") {
    if (!validation) blockers.push("VALIDATION_MISSING");
    else if (!validation.isCurrent) blockers.push("VALIDATION_STALE");
    else if (validation.status === "FAILED") blockers.push("VALIDATION_FAILED");
    if (validation && validation.isCurrent) {
      blockers.push(
        ...validation.findings
          .filter((finding) => finding.severity === "ERROR")
          .map((finding) => finding.code),
      );
    }
  }
  if (version.status === "VALIDATED") {
    if (!validation || !validation.isCurrent) blockers.push("VALIDATION_STALE");
    else blockers.push("PLAN_NOT_APPROVED");
  }
  if (version.status === "APPROVED") {
    if (!executability.executable) blockers.push(...executability.blockers);
    else blockers.push("PLAN_NOT_EXECUTABLE");
  }
  return [...new Set(blockers)].sort();
}

export function planListItem(
  snapshot: PlanVersionSnapshot,
  validation: PlanValidationView | null,
  executability: PlanExecutabilityView,
): PlanListItem {
  const { plan, version, brief } = snapshot;
  const counts = planningCounts(snapshot);
  return {
    planId: plan.id,
    projectId: plan.projectId,
    title: plan.title,
    versionNumber: version.versionNumber,
    planVersionId: version.id,
    status: version.status,
    contentHash: version.contentHash,
    updatedAt: version.updatedAt,
    brief: brief
      ? { id: brief.id, versionNumber: brief.versionNumber, title: brief.title, status: brief.status }
      : null,
    counts,
    validation,
    nextAction: planningNextAction(version, validation, counts),
    blockers: planningBlockers(version, validation, counts, executability),
  };
}

export function capabilityCoverageFor(
  snapshot: PlanVersionSnapshot,
  providers: ProviderRegistry,
  allowedProviderIds?: readonly string[],
): PlanCapabilityCoverage[] {
  const scope =
    allowedProviderIds === undefined
      ? [...providers.values()]
      : allowedProviderIds
          .map((id) => providers.get(id))
          .filter((provider): provider is NonNullable<typeof provider> => provider !== undefined);
  const rows: PlanCapabilityCoverage[] = [];
  for (const node of snapshot.scenePlans) {
    for (const spec of node.specs) {
      const required = spec.providerRequirements.capabilities;
      const candidates = scope
        .filter((provider) =>
          required.length === 0 ? true : required.every((capability) => provider.capabilities[capability]),
        )
        .map((provider) => provider.id)
        .sort();
      const unsatisfied = required
        .filter(
          (capability) =>
            !scope.some((provider) => provider.capabilities[capability]),
        )
        .sort();
      rows.push({
        specId: spec.id,
        sceneKey: node.scenePlan.sceneKey,
        kind: spec.kind,
        requiredCapabilities: [...required],
        candidateProviders: candidates,
        unsatisfied,
      });
    }
  }
  return rows.sort((left, right) => left.specId.localeCompare(right.specId));
}

/**
 * The planning-to-execution boundary made visible: exactly what a later phase would hand to
 * `ProjectService.createScene`/`createSceneVersion` and `GenerationService.requestGeneration`. This
 * function only reads; it never creates a scene, version, job, or queue item.
 */
export function buildExecutionPreview(
  snapshot: PlanVersionSnapshot,
  providers: ProviderRegistry,
  coverage: readonly PlanCapabilityCoverage[] = [],
): ExecutionPreview {
  const { plan, version } = snapshot;
  const executable = version.status === "EXECUTABLE";
  const allowed = executable ? (version.executableProviders ?? []) : undefined;
  const coverageBySpec = new Map(coverage.map((row) => [row.specId, row]));
  const blockers: string[] = [];
  if (!executable) {
    blockers.push(
      version.status === "APPROVED"
        ? "PLAN_NOT_EXECUTABLE"
        : version.status === "VALIDATED"
          ? "PLAN_NOT_APPROVED"
          : version.status === "ARCHIVED"
            ? "PLAN_ARCHIVED"
            : "PLAN_NOT_VALIDATED",
    );
  }
  if (snapshot.specs.length === 0) blockers.push("PLAN_HAS_NO_GENERATION_SPECS");

  const items: ExecutionPreviewItem[] = [];
  for (const node of snapshot.scenePlans) {
    for (const spec of node.specs) {
      const row = coverageBySpec.get(spec.id);
      const candidates = row ? row.candidateProviders : [];
      const unsatisfied = row ? row.unsatisfied : [];
      let reason: string | undefined;
      if (!executable) reason = `plan version is ${version.status}, not EXECUTABLE`;
      else if (allowed !== undefined && allowed.length > 0 && candidates.length === 0) {
        reason = `no provider approved for this plan version satisfies ${unsatisfied.join(", ") || "the declared capabilities"}`;
      } else if (candidates.length === 0 && spec.providerRequirements.capabilities.length > 0) {
        reason = `no configured provider satisfies ${unsatisfied.join(", ")}`;
      }
      items.push({
        scenePlanId: node.scenePlan.id,
        sceneKey: node.scenePlan.sceneKey,
        sceneNumber: node.scenePlan.sceneNumber,
        specId: spec.id,
        specNumber: spec.specNumber,
        kind: spec.kind,
        sceneTitle: `${String(node.scenePlan.sceneNumber).padStart(2, "0")} ${node.scenePlan.title}`,
        sceneVersionTitle: node.scenePlan.title,
        prompt: spec.instructions,
        outputCount: spec.outputCount,
        aspectRatio: spec.aspectRatio,
        durationMs: spec.durationMs,
        references: spec.references.map((reference) => `${reference.kind}:${reference.id}`),
        metadata: {
          projectId: plan.projectId,
          planId: plan.id,
          planVersionId: version.id,
          planVersionNumber: version.versionNumber,
          sceneKey: node.scenePlan.sceneKey,
          scenePlanId: node.scenePlan.id,
          generationSpecId: spec.id,
          contentHash: version.contentHash,
          visualDnaId: node.scenePlan.visualDnaId ?? version.visualDnaId ?? null,
          worldId: node.scenePlan.worldId ?? null,
          constraints: spec.constraints,
          plannedDurationTargetMs: node.scenePlan.durationTargetMs ?? null,
        },
        requiredCapabilities: [...spec.providerRequirements.capabilities],
        candidateProviders: candidates,
        acceptable: reason === undefined,
        reason,
      });
    }
  }
  return {
    planId: plan.id,
    planVersionId: version.id,
    versionNumber: version.versionNumber,
    status: version.status,
    executable,
    items,
    blockers: [...new Set(blockers)].sort(),
    note: "Preview only: FlowForge does not create scenes, jobs, or queue entries from a plan in Phase 4A.",
  };
}

/** Resolves a scene plan's aesthetic contract, preferring the scene override. */
export function resolveVisualDna(
  scenePlan: ScenePlan,
  version: ProductionPlanVersion,
  snapshot: PlanVersionSnapshot,
): PlanVisualDnaResolution | null {
  const source = scenePlan.visualDnaId !== undefined ? "scenePlan" : "planVersion";
  const id = scenePlan.visualDnaId ?? version.visualDnaId;
  if (id === undefined) return null;
  const found = snapshot.visualDna.find((dna) => dna.id === id);
  return {
    visualDnaId: id,
    name: found?.name ?? `${id} (unresolved)`,
    versionNumber: found?.versionNumber ?? 0,
    source,
    resolvedInProject: found !== undefined && found.projectId === snapshot.plan.projectId,
  };
}

export function resolveWorld(
  scenePlan: ScenePlan,
  snapshot: PlanVersionSnapshot,
): Pick<WorldDefinition, "id" | "name" | "versionNumber"> | null {
  if (scenePlan.worldId === undefined) return null;
  const world = snapshot.worlds.find((candidate) => candidate.id === scenePlan.worldId);
  if (!world) return { id: scenePlan.worldId, name: `${scenePlan.worldId} (unresolved)`, versionNumber: 0 };
  return { id: world.id, name: world.name, versionNumber: world.versionNumber };
}

export function planCastRows(snapshot: PlanVersionSnapshot): PlanCastRow[] {
  const byId = new Map(snapshot.characters.map((character) => [character.id, character]));
  return snapshot.cast
    .map((link) => {
      const character = byId.get(link.characterId);
      return {
        characterId: link.characterId,
        name: character?.name ?? `${link.characterId} (unknown)`,
        role: link.role,
        inProject: character !== undefined && character.projectId === snapshot.plan.projectId,
        hasIdentityTraits: character?.traits !== undefined,
      };
    })
    .sort((left, right) => left.characterId.localeCompare(right.characterId));
}

/** Loads a version snapshot and derives executability in one place, shared by every read model. */
export function loadPlanExecutability(
  planning: PlanningRepository,
  providers: ProviderRegistry,
  snapshot: PlanVersionSnapshot,
): PlanExecutabilityView {
  const coverage = capabilityCoverageFor(snapshot, providers);
  const validation = toPlanValidationView(
    planning.getLatestPlanValidation(snapshot.version.id),
    snapshot.version,
  );
  const blockers: string[] = [];
  if (snapshot.scenePlans.length === 0) blockers.push("PLAN_HAS_NO_SCENES");
  if (snapshot.specs.length === 0) blockers.push("PLAN_HAS_NO_GENERATION_SPECS");
  if (!validation) blockers.push("VALIDATION_MISSING");
  else if (!validation.isCurrent) blockers.push("VALIDATION_STALE");
  else if (validation.status !== "PASSED") blockers.push("VALIDATION_FAILED");
  const unsatisfiable = coverage.filter((row) => row.unsatisfied.length > 0);
  for (const row of unsatisfiable) {
    blockers.push(`CAPABILITY_UNAVAILABLE:${row.specId}`);
  }
  if (
    snapshot.version.status !== "APPROVED" &&
    snapshot.version.status !== "EXECUTABLE"
  ) {
    blockers.push("PLAN_NOT_APPROVED");
  }
  return {
    executable: snapshot.version.status === "EXECUTABLE" && blockers.length === 0,
    blockers: [...new Set(blockers)].sort(),
    capabilityCoverage: coverage,
  };
}
