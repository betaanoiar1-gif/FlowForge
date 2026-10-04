import {
  isGenerationSpecKind,
  isProviderCapabilityKey,
  type CreativeBriefConstraint,
  type GenerationSpec,
  type PlanVersionSnapshot,
  type PlanningFinding,
  type PlanningFindingCode,
  type PlanningFindingSeverity,
  type PlanningFindingSubject,
  type PlanValidationStatus,
  type ProviderCapabilityKey,
  type ScenePlan,
} from "@flowforge/core";
import type { ProviderDescriptor } from "./ports.js";

/**
 * Deterministic structural validation of a plan version (Phase 4A).
 *
 * This module is a pure function over the aggregate snapshot: no clock, no randomness, no database,
 * no provider instance, and no network. The same snapshot always produces byte-identical findings,
 * which is what lets approval be evidence-backed (`plan_validations.content_hash`) and lets Phase 4B
 * or 4C feed the same rules to authored or AI-generated plans before they are persisted.
 */
export const PLAN_ASPECT_RATIO_PATTERN = /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/;
export const MIN_SPEC_DURATION_MS = 250;
export const MAX_SPEC_OUTPUT_COUNT = 32;
const BRIEF_CONSTRAINT_KINDS: readonly CreativeBriefConstraint["kind"][] = [
  "MUST",
  "MUST_NOT",
  "PREFERENCE",
];
const ASPECT_RATIO_KINDS: readonly GenerationSpec["kind"][] = ["image", "video"];

export interface PlanValidationOptions {
  /**
   * Provider declarations used for the capability-satisfiability pass. Omitted or empty means the
   * check is skipped and recorded as a warning — never silently assumed to pass.
   */
  readonly providers?: ReadonlyMap<string, ProviderDescriptor>;
}

export interface PlanValidationSummary {
  status: PlanValidationStatus;
  findings: PlanningFinding[];
  errorCount: number;
  warningCount: number;
}

export function validatePlanVersion(
  snapshot: PlanVersionSnapshot,
  options: PlanValidationOptions = {},
): PlanningFinding[] {
  const findings: PlanningFinding[] = [];
  const add = (
    code: PlanningFindingCode,
    severity: PlanningFindingSeverity,
    message: string,
    subject: PlanningFindingSubject,
  ): void => {
    findings.push({ code, severity, message, subject });
  };

  const { plan, version, brief, story, scenePlans, characters, worlds, visualDna, cast, specs } =
    snapshot;
  const planVersionSubject: PlanningFindingSubject = { kind: "planVersion", id: version.id };

  /* Ownership: a plan version must describe exactly one project's aggregate. */
  if (!plan.projectId) {
    add(
      "PROJECT_OWNERSHIP_MISSING",
      "ERROR",
      "The production plan has no project id.",
      { kind: "plan", id: plan.id },
    );
  }
  if (version.planId !== plan.id) {
    add(
      "PROJECT_OWNERSHIP_MISSING",
      "ERROR",
      `Plan version ${version.id} belongs to plan ${version.planId}, not ${plan.id}.`,
      planVersionSubject,
    );
  }
  if (snapshot.projectId !== plan.projectId) {
    add(
      "PROJECT_OWNERSHIP_MISSING",
      "ERROR",
      `Plan ${plan.id} is owned by project ${plan.projectId} but the snapshot was read from ${snapshot.projectId}.`,
      { kind: "plan", id: plan.id },
    );
  }

  /* Brief. */
  const briefSubject: PlanningFindingSubject = { kind: "brief", id: brief?.id ?? plan.briefId };
  if (!brief) {
    add(
      "BRIEF_UNUSABLE",
      "ERROR",
      `Plan ${plan.id} references creative brief ${plan.briefId}, which does not exist.`,
      briefSubject,
    );
  } else {
    if (brief.projectId !== plan.projectId) {
      add(
        "PROJECT_OWNERSHIP_MISSING",
        "ERROR",
        `Creative brief ${brief.id} belongs to project ${brief.projectId}, not ${plan.projectId}.`,
        briefSubject,
      );
    }
    if (brief.status !== "ACTIVE") {
      add(
        "BRIEF_UNUSABLE",
        "ERROR",
        `Creative brief ${brief.id} is ${brief.status}; a plan may only be approved against the active brief snapshot it pinned.`,
        briefSubject,
      );
    }
    const missingBriefFields = (
      [
        ["title", brief.title],
        ["concept", brief.concept],
        ["objective", brief.objective],
      ] as const
    )
      .filter(([, value]) => !value.trim())
      .map(([field]) => field);
    if (missingBriefFields.length > 0) {
      add(
        "BRIEF_FIELD_MISSING",
        "ERROR",
        `Creative brief ${brief.id} is missing required field(s): ${missingBriefFields.join(", ")}.`,
        briefSubject,
      );
    }
    brief.constraints.forEach((constraint, index) => {
      if (
        !BRIEF_CONSTRAINT_KINDS.includes(constraint.kind) ||
        typeof constraint.value !== "string" ||
        !constraint.value.trim()
      ) {
        add(
          "BRIEF_CONSTRAINT_INVALID",
          "ERROR",
          `Brief constraint #${index + 1} must declare a kind of ${BRIEF_CONSTRAINT_KINDS.join(", ")} and a non-empty value.`,
          briefSubject,
        );
      }
    });
  }

  /* Story. */
  if (!story) {
    add(
      "STORY_MISSING",
      "ERROR",
      `Plan version ${version.versionNumber} has no story; a production plan needs a narrative interpretation of the brief.`,
      planVersionSubject,
    );
  } else {
    const storySubject: PlanningFindingSubject = { kind: "story", id: story.id };
    const emptyStoryFields = (
      [
        ["premise", story.premise],
        ["structure", story.structure],
        ["beginning", story.beginning],
        ["development", story.development],
        ["ending", story.ending],
      ] as const
    )
      .filter(([, value]) => !value.trim())
      .map(([field]) => field);
    if (emptyStoryFields.length > 0) {
      add(
        "STORY_FIELD_MISSING",
        "ERROR",
        `Story ${story.id} is missing required field(s): ${emptyStoryFields.join(", ")}.`,
        storySubject,
      );
    }
  }

  /* Scene plans: identity, order, and required narrative fields. */
  if (scenePlans.length === 0) {
    add(
      "SCENE_PLANS_EMPTY",
      "ERROR",
      `Plan version ${version.versionNumber} contains no scene plans, so it cannot produce any work.`,
      planVersionSubject,
    );
  }
  const scenePlanIds = new Set(scenePlans.map((node) => node.scenePlan.id));
  findings.push(...duplicateFieldFindings(scenePlans, "sceneKey", "SCENE_KEY_DUPLICATE"));
  findings.push(...duplicateFieldFindings(scenePlans, "sceneNumber", "SCENE_ORDER_CONFLICT"));
  for (const node of scenePlans) {
    const scenePlan = node.scenePlan;
    if (scenePlan.planVersionId !== version.id) {
      add(
        "PROJECT_OWNERSHIP_MISSING",
        "ERROR",
        `Scene plan ${scenePlan.id} belongs to plan version ${scenePlan.planVersionId}, not ${version.id}.`,
        { kind: "scenePlan", id: scenePlan.id },
      );
    }
    const sceneSubject: PlanningFindingSubject = { kind: "scenePlan", id: scenePlan.id };
    const missingSceneFields = (
      [
        ["title", scenePlan.title],
        ["narrativePurpose", scenePlan.narrativePurpose],
      ] as const
    )
      .filter(([, value]) => !value.trim())
      .map(([field]) => field);
    if (missingSceneFields.length > 0) {
      add(
        "SCENE_REQUIRED_FIELDS_MISSING",
        "ERROR",
        `Scene plan "${scenePlan.sceneKey}" is missing required field(s): ${missingSceneFields.join(", ")}.`,
        sceneSubject,
      );
    }
    if (
      scenePlan.durationTargetMs !== undefined &&
      (!Number.isSafeInteger(scenePlan.durationTargetMs) || scenePlan.durationTargetMs <= 0)
    ) {
      add(
        "SCENE_DURATION_INVALID",
        "ERROR",
        `Scene plan "${scenePlan.sceneKey}" duration target must be a positive integer number of milliseconds.`,
        sceneSubject,
      );
    }
  }

  /* Characters: version cast first, then per scene. */
  const projectCharacters = new Map(characters.map((character) => [character.id, character]));
  const castIds = new Set<string>();
  for (const link of cast) {
    castIds.add(link.characterId);
    const characterSubject: PlanningFindingSubject = { kind: "character", id: link.characterId };
    const character = projectCharacters.get(link.characterId);
    if (!character) {
      add(
        "CHARACTER_UNKNOWN_REFERENCE",
        "ERROR",
        `Plan cast references character ${link.characterId}, which is not an identity in project ${plan.projectId}.`,
        characterSubject,
      );
      continue;
    }
    if (character.projectId !== plan.projectId) {
      add(
        "CHARACTER_UNKNOWN_REFERENCE",
        "ERROR",
        `Character ${character.id} belongs to project ${character.projectId}, not ${plan.projectId}.`,
        characterSubject,
      );
    }
    findings.push(...characterProfileFindings(character, plan.projectId));
  }
  for (const node of scenePlans) {
    for (const link of node.cast) {
      if (!projectCharacters.has(link.characterId)) {
        add(
          "CHARACTER_UNKNOWN_REFERENCE",
          "ERROR",
          `Scene plan "${node.scenePlan.sceneKey}" references unknown character ${link.characterId}.`,
          { kind: "character", id: link.characterId },
        );
        continue;
      }
      if (!castIds.has(link.characterId)) {
        add(
          "CHARACTER_NOT_IN_CAST",
          "ERROR",
          `Scene plan "${node.scenePlan.sceneKey}" uses character ${link.characterId}, which the plan version never declared in its cast.`,
          { kind: "character", id: link.characterId },
        );
      }
    }
  }

  /* Worlds. */
  const projectWorlds = new Map(worlds.map((world) => [world.id, world]));
  for (const node of scenePlans) {
    const scenePlan = node.scenePlan;
    if (scenePlan.worldId === undefined) continue;
    const world = projectWorlds.get(scenePlan.worldId);
    if (!world || world.projectId !== plan.projectId) {
      add(
        "WORLD_UNKNOWN_REFERENCE",
        "ERROR",
        `Scene plan "${scenePlan.sceneKey}" references world ${scenePlan.worldId}, which is not a world definition of project ${plan.projectId}.`,
        { kind: "world", id: scenePlan.worldId },
      );
      continue;
    }
    if (!world.environment.trim() && !world.description.trim()) {
      add(
        "WORLD_PROFILE_INCOMPLETE",
        "ERROR",
        `World "${world.name}" needs an environment or description before a scene plan can rely on it.`,
        { kind: "world", id: world.id },
      );
    }
  }

  /* Visual DNA: scene override, then version default. */
  const projectDna = new Map(visualDna.map((dna) => [dna.id, dna]));
  const versionDna = version.visualDnaId === undefined ? undefined : projectDna.get(version.visualDnaId);
  if (version.visualDnaId !== undefined && (!versionDna || versionDna.projectId !== plan.projectId)) {
    add(
      "VISUAL_DNA_NOT_IN_PROJECT",
      "ERROR",
      `Plan version ${version.versionNumber} defaults to visual DNA ${version.visualDnaId}, which is not a definition of project ${plan.projectId}.`,
      planVersionSubject,
    );
  }
  for (const node of scenePlans) {
    const scenePlan = node.scenePlan;
    const dnaId = scenePlan.visualDnaId ?? version.visualDnaId;
    const sceneSubject: PlanningFindingSubject = { kind: "scenePlan", id: scenePlan.id };
    if (dnaId === undefined) {
      add(
        "VISUAL_DNA_MISSING",
        "ERROR",
        `Scene plan "${scenePlan.sceneKey}" has no visual DNA: the scene overrides nothing and the plan version has no default.`,
        sceneSubject,
      );
      continue;
    }
    const dna = projectDna.get(dnaId);
    if (!dna || dna.projectId !== plan.projectId) {
      add(
        "VISUAL_DNA_NOT_IN_PROJECT",
        "ERROR",
        `Scene plan "${scenePlan.sceneKey}" references visual DNA ${dnaId}, which is not a definition of project ${plan.projectId}.`,
        { kind: "visualDna", id: dnaId },
      );
      continue;
    }
    const incomplete = dnaIncompleteFields(dna);
    if (incomplete.length > 0) {
      add(
        "VISUAL_DNA_INCOMPLETE",
        "ERROR",
        `Visual DNA "${dna.name}" is missing required field(s): ${incomplete.join(", ")}.`,
        { kind: "visualDna", id: dna.id },
      );
    }
  }

  /* Generation specs. */
  for (const spec of specs) {
    const specSubject: PlanningFindingSubject = { kind: "generationSpec", id: spec.id };
    if (!scenePlanIds.has(spec.scenePlanId)) {
      add(
        "GENERATION_SPEC_WITHOUT_SCENE_PLAN",
        "ERROR",
        `Generation spec ${spec.id} points at scene plan ${spec.scenePlanId}, which is not part of plan version ${version.versionNumber}.`,
        specSubject,
      );
    }
  }
  for (const node of scenePlans) {
    if (node.specs.length === 0) {
      add(
        "SCENE_WITHOUT_GENERATION_SPEC",
        "ERROR",
        `Scene plan "${node.scenePlan.sceneKey}" has no generation spec, so nothing could be handed to execution.`,
        { kind: "scenePlan", id: node.scenePlan.id },
      );
    }
    for (const spec of node.specs) {
      findings.push(...specFindings(spec));
    }
    if (node.specs.length > 0) {
      // A scene may hold at most one spec per (kind, spec number) pair; the schema enforces the
      // number, so only ordering gaps are reported here.
      const numbers = node.specs.map((spec) => spec.specNumber).sort((left, right) => left - right);
      if (new Set(numbers).size !== numbers.length) {
        add(
          "GENERATION_SPEC_INVALID_VALUE",
          "ERROR",
          `Scene plan "${node.scenePlan.sceneKey}" holds duplicate spec numbers: ${numbers.join(", ")}.`,
          { kind: "scenePlan", id: node.scenePlan.id },
        );
      }
    }
  }

  /* Required references must resolve inside the project (asset versions resolve at execution). */
  for (const node of scenePlans) {
    for (const reference of node.scenePlan.requiredReferences) {
      findings.push(
        ...danglingReferenceFindings(reference, {
          projectId: plan.projectId,
          characters: projectCharacters,
          worlds: projectWorlds,
          visualDna: projectDna,
          scenePlanIds,
          subject: { kind: "scenePlan", id: node.scenePlan.id },
        }),
      );
    }
    for (const spec of node.specs) {
      for (const reference of spec.references) {
        findings.push(
          ...danglingReferenceFindings(reference, {
            projectId: plan.projectId,
            characters: projectCharacters,
            worlds: projectWorlds,
            visualDna: projectDna,
            scenePlanIds,
            subject: { kind: "generationSpec", id: spec.id },
          }),
        );
      }
    }
  }

  /* Continuity is advisory but its absence across a multi-shot plan is worth reporting. */
  if (scenePlans.length > 1) {
    for (const node of scenePlans) {
      if (node.scenePlan.continuity.length === 0) {
        add(
          "SCENE_CONTINUITY_EMPTY",
          "WARNING",
          `Scene plan "${node.scenePlan.sceneKey}" declares no continuity constraints although the plan has ${scenePlans.length} scene plans.`,
          { kind: "scenePlan", id: node.scenePlan.id },
        );
      }
    }
  }

  /* Capability boundary: reuse the existing provider capability model, never a new one. */
  const providers = options.providers;
  if (providers === undefined || providers.size === 0) {
    add(
      "PROVIDER_CAPABILITY_CHECK_SKIPPED",
      "WARNING",
      "No provider capability declarations were available, so capability satisfiability was not checked.",
      planVersionSubject,
    );
  } else {
    for (const node of scenePlans) {
      for (const spec of node.specs) {
        for (const capability of spec.providerRequirements.capabilities) {
          const candidates = [...providers.values()]
            .filter((provider) => provider.capabilities[capability])
            .map((provider) => provider.id)
            .sort();
          if (candidates.length === 0) {
            add(
              "CAPABILITY_UNAVAILABLE",
              "ERROR",
              `Generation spec ${spec.id} requires the "${capability}" capability, which no configured provider declares.`,
              { kind: "generationSpec", id: spec.id },
            );
          }
        }
      }
    }
  }

  return sortFindings(findings);
}

export function summarizePlanFindings(
  findings: readonly PlanningFinding[],
  contentHash: string,
  validatorVersion: string,
): PlanValidationSummary & { contentHash: string; validatorVersion: string } {
  const errorCount = findings.filter((finding) => finding.severity === "ERROR").length;
  return {
    status: errorCount === 0 ? "PASSED" : "FAILED",
    findings: [...findings],
    errorCount,
    warningCount: findings.length - errorCount,
    contentHash,
    validatorVersion,
  };
}

/** ERROR before WARNING, then by code, subject kind, subject id, and message: a stable report. */
export function sortFindings(findings: readonly PlanningFinding[]): PlanningFinding[] {
  return [...findings].sort(
    (left, right) =>
      severityRank(left.severity) - severityRank(right.severity) ||
      left.code.localeCompare(right.code) ||
      left.subject.kind.localeCompare(right.subject.kind) ||
      left.subject.id.localeCompare(right.subject.id) ||
      left.message.localeCompare(right.message),
  );
}

function severityRank(severity: PlanningFindingSeverity): number {
  return severity === "ERROR" ? 0 : 1;
}

function duplicateFieldFindings(
  scenePlans: readonly { scenePlan: ScenePlan }[],
  field: "sceneKey" | "sceneNumber",
  code: PlanningFindingCode,
): PlanningFinding[] {
  const groups = new Map<string, ScenePlan[]>();
  for (const node of scenePlans) {
    const key = String(node.scenePlan[field]);
    const bucket = groups.get(key);
    if (bucket) bucket.push(node.scenePlan);
    else groups.set(key, [node.scenePlan]);
  }
  const findings: PlanningFinding[] = [];
  for (const [key, bucket] of [...groups.entries()].sort()) {
    if (bucket.length < 2) continue;
    findings.push({
      code,
      severity: "ERROR",
      message:
        field === "sceneKey"
          ? `Scene key "${key}" is used by ${bucket.length} scene plans of this version; scene keys are stable identities and must be unique.`
          : `Scene number ${key} is assigned to ${bucket.length} scene plans of this version; order must be unique.`,
      subject: { kind: "scenePlan", id: [...bucket.map((scenePlan) => scenePlan.id)].sort()[0]! },
    });
  }
  return findings;
}

function characterProfileFindings(
  character: { id: string; name: string; traits?: { appearance: string; personality: string } },
  projectId: string,
): PlanningFinding[] {
  const subject: PlanningFindingSubject = { kind: "character", id: character.id };
  if (!character.traits) {
    return [
      {
        code: "CHARACTER_PROFILE_INCOMPLETE",
        severity: "ERROR",
        message: `Character ${character.id} in project ${projectId} carries no planning identity traits; a cast member needs an appearance and a personality.`,
        subject,
      },
    ];
  }
  const missing = (
    [
      ["appearance", character.traits.appearance],
      ["personality", character.traits.personality],
    ] as const
  )
    .filter(([, value]) => !value.trim())
    .map(([field]) => field);
  if (missing.length === 0) return [];
  return [
    {
      code: "CHARACTER_PROFILE_INCOMPLETE",
      severity: "ERROR",
      message: `Character ${character.id} is missing required trait field(s): ${missing.join(", ")}.`,
      subject,
    },
  ];
}

function dnaIncompleteFields(dna: {
  style: string;
  palette: string[];
  lighting: string;
  composition: string;
  cameraLanguage: string;
  renderingStyle: string;
  atmosphere: string;
}): string[] {
  return (
    [
      ["style", dna.style],
      ["palette", dna.palette.length > 0 ? "set" : ""],
      ["lighting", dna.lighting],
      ["composition", dna.composition],
      ["cameraLanguage", dna.cameraLanguage],
      ["renderingStyle", dna.renderingStyle],
      ["atmosphere", dna.atmosphere],
    ] as const
  )
    .filter(([, value]) => !value.trim())
    .map(([field]) => field);
}

function specFindings(spec: GenerationSpec): PlanningFinding[] {
  const findings: PlanningFinding[] = [];
  const subject: PlanningFindingSubject = { kind: "generationSpec", id: spec.id };
  const invalid = (message: string): void => {
    findings.push({ code: "GENERATION_SPEC_INVALID_VALUE", severity: "ERROR", message, subject });
  };
  if (!isGenerationSpecKind(spec.kind)) {
    invalid(`Generation spec ${spec.id} has unknown kind "${String(spec.kind)}".`);
    return findings;
  }
  if (!spec.instructions.trim()) {
    invalid(`Generation spec ${spec.id} must carry instructions for the shot it describes.`);
  }
  if (!Number.isSafeInteger(spec.outputCount) || spec.outputCount < 1) {
    invalid(`Generation spec ${spec.id} output count must be an integer of at least 1.`);
  } else if (spec.outputCount > MAX_SPEC_OUTPUT_COUNT) {
    invalid(
      `Generation spec ${spec.id} output count must not exceed ${MAX_SPEC_OUTPUT_COUNT}; split the shot into more scene plans instead.`,
    );
  }
  if (spec.aspectRatio !== undefined && !PLAN_ASPECT_RATIO_PATTERN.test(spec.aspectRatio)) {
    invalid(
      `Generation spec ${spec.id} aspect ratio "${spec.aspectRatio}" must look like 16:9 or 2.39:1.`,
    );
  }
  if (spec.aspectRatio !== undefined && !ASPECT_RATIO_KINDS.includes(spec.kind)) {
    invalid(`Generation spec ${spec.id} may only declare an aspect ratio for image or video specs.`);
  }
  if (spec.durationMs !== undefined) {
    if (!Number.isSafeInteger(spec.durationMs) || spec.durationMs < MIN_SPEC_DURATION_MS) {
      invalid(
        `Generation spec ${spec.id} duration must be an integer of at least ${MIN_SPEC_DURATION_MS} milliseconds.`,
      );
    }
    if (spec.kind !== "video") {
      invalid(`Generation spec ${spec.id} may only declare a duration for video specs.`);
    }
  }
  for (const [index, constraint] of spec.constraints.entries()) {
    if (typeof constraint !== "string" || !constraint.trim()) {
      invalid(`Generation spec ${spec.id} constraint #${index + 1} must be a non-empty string.`);
    }
  }
  const capabilities = spec.providerRequirements.capabilities;
  const known = new Set<ProviderCapabilityKey>();
  for (const capability of capabilities) {
    if (!isProviderCapabilityKey(capability)) {
      findings.push({
        code: "GENERATION_SPEC_UNKNOWN_CAPABILITY",
        severity: "ERROR",
        message: `Generation spec ${spec.id} requires unknown provider capability "${String(capability)}"; valid keys are those of ProviderCapabilities.`,
        subject,
      });
      continue;
    }
    if (known.has(capability)) {
      invalid(`Generation spec ${spec.id} declares capability "${capability}" more than once.`);
    }
    known.add(capability);
  }
  const mismatch = (capability: ProviderCapabilityKey, reason: string): void => {
    if (!known.has(capability)) {
      findings.push({
        code: "GENERATION_SPEC_CAPABILITY_MISMATCH",
        severity: "ERROR",
        message: `Generation spec ${spec.id} ${reason}; it must require "${capability}".`,
        subject,
      });
    }
  };
  if (spec.kind === "image") mismatch("imageGeneration", "is an image spec");
  if (spec.kind === "video") mismatch("videoGeneration", "is a video spec");
  if (spec.references.length > 0) mismatch("referenceImages", "carries references");
  if (spec.outputCount > 1) mismatch("batchGeneration", "asks for more than one output");
  return findings;
}

function danglingReferenceFindings(
  reference: { kind: string; id: string },
  context: {
    projectId: string;
    characters: Map<string, unknown>;
    worlds: Map<string, unknown>;
    visualDna: Map<string, unknown>;
    scenePlanIds: Set<string>;
    subject: PlanningFindingSubject;
  },
): PlanningFinding[] {
  const resolved =
    reference.kind === "character"
      ? context.characters.has(reference.id)
      : reference.kind === "world"
        ? context.worlds.has(reference.id)
        : reference.kind === "visualDna"
          ? context.visualDna.has(reference.id)
          : reference.kind === "scenePlan"
            ? context.scenePlanIds.has(reference.id)
            : true; // assetVersion references are resolved by execution mapping, not here.
  if (resolved) return [];
  return [
    {
      code: "DANGLING_PLANNING_REFERENCE",
      severity: "ERROR",
      message: `A ${reference.kind} reference points at ${reference.id}, which does not exist in project ${context.projectId}.`,
      subject: context.subject,
    },
  ];
}
