import type {
  CreativeBrief,
  PlanningCharacterRecord,
  VisualDnaDefinition,
} from "@flowforge/core";
import type {
  ExecutionPreview,
  PlanDetail,
  PlanListItem,
  PlanScenePlanRow,
  PlanValidationView,
  ProjectPlanningOverview,
} from "@flowforge/services";
import {
  optionalNumber,
  optionalString,
  parseJsonOption,
  requireString,
  UsageError,
  type ParsedArgs,
} from "./args.js";
import { emit, defaultReviewer, type CommandDefinition } from "./command-context.js";
import { EXIT_BLOCKED } from "./command-context.js";

/**
 * Operator commands for the creative planning domain (Phase 4A).
 *
 * Every command delegates to an application service and renders the same read model a `--json`
 * consumer receives. Nothing here reaches SQL, the queue, or a provider: `plan executable` only
 * *reads* declared provider capabilities, and `plan preview` proves the execution mapping without
 * creating a scene, a version, a job, or a queue entry.
 */

export const PLANNING_COMMANDS: Record<string, CommandDefinition> = {
  "brief create": {
    usage: 'brief create --project-id ID --title TITLE [--concept TEXT] [--objective TEXT] [--audience TEXT] [--tone TEXT] [--style TEXT] [--constraints-json JSON]',
    summary: "Record a creative brief snapshot (immutable; an identical snapshot is reused).",
    flags: ["project-id", "title", "concept", "objective", "audience", "tone", "style", "constraints-json", "brief-id"],
    execution: false,
    run({ options, globals, app }) {
      const result = app.briefs.createBrief({
        briefId: optionalString(options, "brief-id"),
        projectId: requireString(options, "project-id"),
        title: requireString(options, "title"),
        concept: optionalString(options, "concept"),
        objective: optionalString(options, "objective"),
        audience: optionalString(options, "audience"),
        tone: optionalString(options, "tone"),
        style: optionalString(options, "style"),
        constraints: jsonList<{ kind: "MUST" | "MUST_NOT" | "PREFERENCE"; value: string }>(options, "constraints-json"),
      });
      emit(globals, result, ({ brief, created }) => [
        `brief ${brief.id}  v${brief.versionNumber}  "${brief.title}"`,
        `  project: ${brief.projectId}`,
        `  concept: ${brief.concept}`,
        `  objective: ${brief.objective}`,
        `  constraints: ${brief.constraints.map((entry) => `${entry.kind} ${entry.value}`).join(" | ") || "none"}`,
        `  status: ${brief.status}${created ? "" : "  (existing snapshot reused)"}`,
      ]);
    },
  },
  "brief current": {
    usage: "brief current --project-id ID",
    summary: "Show the project's active brief snapshot.",
    flags: ["project-id"],
    execution: false,
    run({ options, globals, app }) {
      const brief = app.briefs.currentBrief(requireString(options, "project-id"));
      emit(globals, brief, (value) => (value ? renderBrief(value) : ["no active brief for this project"]));
    },
  },
  "brief list": {
    usage: "brief list --project-id ID",
    summary: "List every brief snapshot of a project, newest version first.",
    flags: ["project-id"],
    execution: false,
    run({ options, globals, app }) {
      const briefs = app.briefs.listBriefs(requireString(options, "project-id"));
      emit(globals, briefs, (value) =>
        value.length === 0
          ? ["no briefs — create one with `flowforge brief create --project-id … --title …`"]
          : value.map((brief) => `${brief.id}  v${brief.versionNumber}  ${brief.status}  ${brief.title}`),
      );
    },
  },
  "brief show": {
    usage: "brief show --brief-id ID",
    summary: "Show one brief snapshot by id.",
    flags: ["brief-id"],
    execution: false,
    run({ options, globals, app }) {
      const brief = app.briefs.getBrief(requireString(options, "brief-id"));
      emit(globals, brief, renderBrief);
    },
  },
  "definition character-create": {
    usage: 'definition character-create --project-id ID --name NAME [--description TEXT] [--traits-json JSON] [--visual-identity-json JSON]',
    summary: "Create a reusable character identity, optionally with planning traits and visual identity.",
    flags: ["project-id", "name", "description", "traits-json", "visual-identity-json", "character-id"],
    execution: false,
    run({ options, globals, app }) {
      const character = app.definitions.createCharacter({
        characterId: optionalString(options, "character-id"),
        projectId: requireString(options, "project-id"),
        name: requireString(options, "name"),
        description: optionalString(options, "description"),
        traits: parseJsonOption<{ appearance: string; personality: string; role?: string; voice?: string }>(
          options,
          "traits-json",
        ),
        visualIdentity: parseJsonOption<{
          description: string;
          distinguishingFeatures?: string[];
          palette?: string[];
        }>(options, "visual-identity-json"),
      });
      emit(globals, character, renderCharacter);
    },
  },
  "definition world-create": {
    usage: 'definition world-create --project-id ID --name NAME [--description TEXT] [--environment TEXT] [--rules-json JSON] [--visual-identity-json JSON]',
    summary: "Create a world definition snapshot (environment, rules, visual identity).",
    flags: ["project-id", "name", "description", "environment", "rules-json", "visual-identity-json", "world-id"],
    execution: false,
    run({ options, globals, app }) {
      const result = app.definitions.createWorld({
        worldId: optionalString(options, "world-id"),
        projectId: requireString(options, "project-id"),
        name: requireString(options, "name"),
        description: optionalString(options, "description"),
        environment: optionalString(options, "environment"),
        rules: jsonList<string>(options, "rules-json"),
        visualIdentity: parseJsonOption<{ description?: string; palette?: string[]; lighting?: string }>(
          options,
          "visual-identity-json",
        ),
      });
      emit(globals, result, ({ world, created }) => [
        `world ${world.id}  v${world.versionNumber}  "${world.name}"`,
        `  environment: ${world.environment || "(unset)"}`,
        `  rules: ${world.rules.join(" | ") || "none"}`,
        `  status: ${world.status}${created ? "" : "  (existing definition reused)"}`,
      ]);
    },
  },
  "definition dna-create": {
    usage: 'definition dna-create --project-id ID --name NAME --style STYLE [--palette-json JSON] [--lighting TEXT] [--composition TEXT] [--camera-language TEXT] [--rendering-style TEXT] [--atmosphere TEXT] [--consistency-rules-json JSON]',
    summary: "Create a Visual DNA snapshot: the cross-shot aesthetic contract.",
    flags: [
      "project-id",
      "name",
      "style",
      "palette-json",
      "lighting",
      "composition",
      "camera-language",
      "rendering-style",
      "atmosphere",
      "consistency-rules-json",
      "visual-dna-id",
    ],
    execution: false,
    run({ options, globals, app }) {
      const result = app.definitions.createVisualDna({
        visualDnaId: optionalString(options, "visual-dna-id"),
        projectId: requireString(options, "project-id"),
        name: requireString(options, "name"),
        style: requireString(options, "style"),
        description: optionalString(options, "description"),
        palette: jsonList<string>(options, "palette-json"),
        lighting: optionalString(options, "lighting"),
        composition: optionalString(options, "composition"),
        cameraLanguage: optionalString(options, "camera-language"),
        renderingStyle: optionalString(options, "rendering-style"),
        atmosphere: optionalString(options, "atmosphere"),
        consistencyRules: jsonList<string>(options, "consistency-rules-json"),
      });
      emit(globals, result, ({ visualDna, created }) => renderDna(visualDna, created));
    },
  },
  "definition list": {
    usage: "definition list --project-id ID",
    summary: "List a project's characters, worlds, and Visual DNA definitions.",
    flags: ["project-id"],
    execution: false,
    run({ options, globals, app }) {
      const projectId = requireString(options, "project-id");
      const value = {
        characters: app.definitions.listCharacters(projectId),
        worlds: app.definitions.listWorlds(projectId),
        visualDna: app.definitions.listVisualDna(projectId),
      };
      emit(globals, value, (data) => [
        `characters: ${data.characters.length === 0 ? "none" : ""}`,
        ...data.characters.map((character) => `  ${character.id}  ${character.name}${character.traits ? "" : "  (no traits)"}`),
        `worlds: ${data.worlds.length === 0 ? "none" : ""}`,
        ...data.worlds.map((world) => `  ${world.id}  v${world.versionNumber}  ${world.status}  ${world.name}`),
        `visual dna: ${data.visualDna.length === 0 ? "none" : ""}`,
        ...data.visualDna.map((dna) => `  ${dna.id}  v${dna.versionNumber}  ${dna.status}  ${dna.name}  ${dna.style}`),
      ]);
    },
  },
  "plan create": {
    usage: "plan create --project-id ID --brief-id ID --title TITLE [--visual-dna-id ID] [--plan-id ID]",
    summary: "Create a production plan (version 1, DRAFT) pinned to a brief snapshot.",
    flags: ["project-id", "brief-id", "title", "visual-dna-id", "plan-id"],
    execution: false,
    run({ options, globals, app }) {
      const result = app.plans.createPlan({
        planId: optionalString(options, "plan-id"),
        projectId: requireString(options, "project-id"),
        briefId: requireString(options, "brief-id"),
        title: requireString(options, "title"),
        visualDnaId: optionalString(options, "visual-dna-id"),
      });
      emit(globals, result, ({ plan, version, created }) => [
        `plan ${plan.id}  "${plan.title}"`,
        `  version: v${version.versionNumber} (${version.id})  status: ${version.status}`,
        `  content: ${short(version.contentHash)}`,
        created ? "  next: author the story, cast, scene plans, and generation specs" : "  (existing plan reused — same project, brief, and title)",
      ]);
    },
  },
  "plan list": {
    usage: "plan list --project-id ID",
    summary: "List a project's plans with version, status, counts, and next action.",
    flags: ["project-id"],
    execution: false,
    run({ options, globals, app }) {
      const plans = app.planReads.listPlans(requireString(options, "project-id"));
      emit(globals, plans, (value) =>
        value.length === 0
          ? ["no plans — create one with `flowforge plan create --project-id … --brief-id … --title …`"]
          : [
              ...value.map((plan) => renderPlanListRow(plan)),
              "",
              ...value.map((plan) => `next: ${plan.planId} → ${plan.nextAction}${plan.blockers.length ? ` (blocked: ${plan.blockers.join(", ")})` : ""}`),
            ],
      );
    },
  },
  "plan status": {
    usage: "plan status --plan-id ID [--version N]",
    summary: "Version, validity, approval state, executability, remaining errors, and next action.",
    flags: ["plan-id", "version"],
    execution: false,
    run({ options, globals, app }) {
      const detail = app.planReads.inspect(versionTarget(options));
      emit(globals, detail, renderPlanStatus);
      if (detail.validation && detail.validation.findings.some((finding) => finding.severity === "ERROR")) {
        process.exitCode = EXIT_BLOCKED;
      }
    },
  },
  "plan inspect": {
    usage: "plan inspect --plan-id ID [--version N]",
    summary: "Full nested view: brief, story, cast, worlds, DNA, scene plans, specs, findings, lineage.",
    flags: ["plan-id", "version"],
    execution: false,
    run({ options, globals, app }) {
      const detail = app.planReads.inspect(versionTarget(options));
      emit(globals, detail, renderPlanDetail);
    },
  },
  "plan versions": {
    usage: "plan versions --plan-id ID",
    summary: "List every version of a plan with status, content hash, counts, and lineage.",
    flags: ["plan-id"],
    execution: false,
    run({ options, globals, app }) {
      const versions = app.planReads.versions(requireString(options, "plan-id"));
      emit(globals, versions, (value) => [
        "version  status      scenes  specs  validation      current  lineage",
        ...value.map((row) =>
          [
            `v${String(row.versionNumber).padEnd(2)}`,
            row.status.padEnd(10),
            String(row.scenePlans).padEnd(6),
            String(row.generationSpecs).padEnd(6),
            `${row.validationStatus ?? "never"}${row.validationStatus && !row.validationIsCurrent ? " (stale)" : ""}`.padEnd(15),
            row.validationIsCurrent ? "yes" : "no",
            row.predecessorVersionId ? `← ${short(row.predecessorVersionId)}` : "initial",
          ].join("  "),
        ),
      ]);
    },
  },
  "plan validate": {
    usage: "plan validate --plan-id ID [--version N]",
    summary: "Run the deterministic structural validator and record the evidence.",
    flags: ["plan-id", "version"],
    execution: false,
    run({ options, globals, app, opened }) {
      const target = versionTarget(options);
      const result = app.planValidation.validate(target);
      emit(globals, result, (value) => [
        `plan ${value.version.id}  v${value.version.versionNumber}  validation: ${value.report.status}`,
        `  findings: ${value.report.errorCount} error(s), ${value.report.warningCount} warning(s)  validator: ${value.report.validatorVersion}`,
        `  content: ${short(value.report.contentHash)}${value.report.isCurrent ? "" : "  (STALE — content changed since)"}${value.evidenceReused ? "  (existing evidence reused)" : ""}`,
        ...value.report.findings.map((finding) =>
          `    ${finding.severity === "ERROR" ? "!" : "~"} ${finding.code} (${finding.subject.kind} ${short(finding.subject.id)}): ${finding.message}`,
        ),
        `  status now: ${value.version.status}${value.transitioned ? "  (transitioned)" : ""}`,
        value.report.status === "PASSED" && value.version.status === "VALIDATED"
          ? `  next: flowforge plan approve --plan-id ${target.planId} --reviewer NAME`
          : value.report.status === "PASSED"
            ? `  next: ${EXECUTE_HINT}`
            : "  next: fix the reported structure, then validate again",
      ].filter((line) => line.length > 0));
      if (isBlockedByFindings(result)) process.exitCode = EXIT_BLOCKED;
    },
  },
  "plan report": {
    usage: "plan report --plan-id ID [--version N]",
    summary: "Show the latest recorded validation report without re-running the validator.",
    flags: ["plan-id", "version"],
    execution: false,
    run({ options, globals, app }) {
      const report = app.planReads.validationReport(versionTarget(options));
      emit(globals, report, renderValidation);
    },
  },
  "plan approve": {
    usage: "plan approve --plan-id ID [--version N] [--reviewer NAME]",
    summary: "Explicitly approve a validated version against its current validation evidence.",
    flags: ["plan-id", "version", "reviewer"],
    execution: false,
    run({ options, globals, app }) {
      const result = app.plans.approve({
        ...versionTarget(options),
        reviewer: defaultReviewer(options),
      });
      emit(globals, result, (value) => [
        `plan version ${value.version.id}  v${value.version.versionNumber}  status: ${value.version.status}`,
        `  approved by: ${value.version.approvedBy} at ${value.version.approvedAt}`,
        `  evidence: ${value.validation.validationId} (${value.validation.status}, ${short(value.validation.contentHash)})`,
        value.idempotent ? "  (already approved — no change)" : "  next: flowforge plan executable --plan-id … --providers mock",
      ]);
    },
  },
  "plan executable": {
    usage: "plan executable --plan-id ID [--version N] [--providers CSV]",
    summary: "Mark an approved version executable after checking every spec against the named providers' capabilities.",
    flags: ["plan-id", "version", "providers"],
    execution: false,
    run({ options, globals, app }) {
      const result = app.plans.markExecutable({
        ...versionTarget(options),
        providers: providerSelection(options),
      });
      emit(globals, result, (value) => [
        `plan version ${value.version.id}  status: ${value.version.status}`,
        `  providers: ${(value.version.executableProviders ?? []).join(", ") || "none"}`,
        ...value.capabilityCoverage.map((row) =>
          `  spec ${row.specId} (${row.sceneKey}, ${row.kind}): capabilities ${row.requiredCapabilities.join("+") || "none"} → ${row.candidateProviders.join(", ") || "no candidate"}`,
        ),
        value.idempotent ? "  (already executable — no change)" : "",
      ]);
    },
  },
  "plan preview": {
    usage: "plan preview --plan-id ID [--version N]",
    summary: "Show the exact execution mapping a later phase would submit. Creates nothing.",
    flags: ["plan-id", "version"],
    execution: false,
    run({ options, globals, app }) {
      const preview = app.planReads.executionPreview(versionTarget(options));
      emit(globals, preview, renderPreview);
    },
  },
  "plan revise": {
    usage: "plan revise --plan-id ID [--version N] [--note TEXT]",
    summary: "Copy the current version into a new DRAFT version (approved versions are never edited).",
    flags: ["plan-id", "version", "note"],
    execution: false,
    run({ options, globals, app }) {
      const result = app.plans.revise({
        ...versionTarget(options),
        note: optionalString(options, "note"),
      });
      emit(globals, result, (value) => [
        `plan version ${value.version.id}  v${value.version.versionNumber}  status: ${value.version.status}`,
        value.created
          ? `  copied ${value.copiedScenePlans} scene plan(s) and ${value.copiedSpecs} generation spec(s) from v${value.version.versionNumber - 1}`
          : "  (current version is still editable — no new version created)",
        `  predecessor: ${value.version.predecessorVersionId ?? "none"}`,
      ]);
    },
  },
  "plan reopen": {
    usage: "plan reopen --plan-id ID [--version N]",
    summary: "Move a VALIDATED version back to DRAFT so edits must be re-validated.",
    flags: ["plan-id", "version"],
    execution: false,
    run({ options, globals, app }) {
      const version = app.plans.reopen(versionTarget(options));
      emit(globals, version, (value) => [`plan version ${value.id}  status: ${value.status}`, `  content: ${short(value.contentHash)}`]);
    },
  },
  "plan archive": {
    usage: "plan archive --plan-id ID [--version N]",
    summary: "Archive a plan version. Content, findings, and lineage stay in the database.",
    flags: ["plan-id", "version"],
    execution: false,
    run({ options, globals, app }) {
      const version = app.plans.archive(versionTarget(options));
      emit(globals, version, (value) => [`plan version ${value.id}  status: ${value.status}  (immutable history retained)`]);
    },
  },
  "plan set-current-version": {
    usage: "plan set-current-version --plan-id ID --version N",
    summary: "Point the plan at an existing version (the current pointer is the only mutable plan field).",
    flags: ["plan-id", "version"],
    execution: false,
    run({ options, globals, app }) {
      const plan = app.plans.setCurrentVersion(versionTarget(options));
      emit(globals, plan, (value) => [`plan ${value.id}  current version: ${value.currentVersionId}`]);
    },
  },
  "plan story set": {
    usage: "plan story set --plan-id ID [--version N] --premise TEXT [--structure TEXT] [--themes-json JSON] [--beginning TEXT] [--development TEXT] [--ending TEXT]",
    summary: "Set the story/concept of an editable plan version.",
    flags: ["plan-id", "version", "premise", "structure", "themes-json", "beginning", "development", "ending"],
    execution: false,
    run({ options, globals, app }) {
      const story = app.plans.setStory({
        ...versionTarget(options),
        premise: requireString(options, "premise"),
        structure: optionalString(options, "structure"),
        themes: jsonList<string>(options, "themes-json"),
        beginning: optionalString(options, "beginning"),
        development: optionalString(options, "development"),
        ending: optionalString(options, "ending"),
      });
      emit(globals, story, (value) => renderStory(value));
    },
  },
  "plan cast set": {
    usage: 'plan cast set --plan-id ID [--version N] --cast-json [{"characterId":"…","role":"…"}]',
    summary: "Replace the characters declared by a plan version.",
    flags: ["plan-id", "version", "cast-json"],
    execution: false,
    run({ options, globals, app }) {
      const cast = app.plans.setCast({
        ...versionTarget(options),
        cast: castList(options) ?? [],
      });
      emit(globals, cast, (value) =>
        value.length === 0
          ? ["cast cleared"]
          : value.map(
              (row) =>
                `  ${row.characterId}  ${row.name}  role: ${row.role || "(unset)"}${row.inProject ? "" : "  (not in project!)"}${row.hasIdentityTraits ? "" : "  (no traits)"}`,
            ),
      );
    },
  },
  "plan scene add": {
    usage: 'plan scene add --plan-id ID [--version N] --scene-key KEY --title TITLE [--scene-number N] [--narrative-purpose TEXT] [--description TEXT] [--duration-target-ms N] [--world-id ID] [--visual-dna-id ID] [--cast-json JSON] [--continuity-json JSON] [--references-json JSON] [--planned-outputs-json JSON]',
    summary: "Add a scene plan to an editable version. Creating one never creates a job.",
    flags: [
      "plan-id",
      "version",
      "scene-key",
      "title",
      "scene-number",
      "narrative-purpose",
      "description",
      "duration-target-ms",
      "world-id",
      "visual-dna-id",
      "cast-json",
      "continuity-json",
      "references-json",
      "planned-outputs-json",
    ],
    execution: false,
    run({ options, globals, app }) {
      const scenePlan = app.plans.addScenePlan({
        ...versionTarget(options),
        sceneKey: requireString(options, "scene-key"),
        sceneNumber: optionalNumber(options, "scene-number"),
        title: requireString(options, "title"),
        narrativePurpose: optionalString(options, "narrative-purpose"),
        description: optionalString(options, "description"),
        durationTargetMs: optionalNumber(options, "duration-target-ms"),
        worldId: optionalString(options, "world-id"),
        visualDnaId: optionalString(options, "visual-dna-id"),
        cast: castList(options),
        continuity: parseJsonOption<Array<{ statement: string; source?: string }>>(options, "continuity-json"),
        requiredReferences: parseJsonOption<Array<{ kind: string; id: string; note?: string }>>(
          options,
          "references-json",
        ),
        plannedOutputs: parseJsonOption<Array<{ kind: string; count: number; note?: string }>>(
          options,
          "planned-outputs-json",
        ),
      });
      emit(globals, scenePlan, (value) => [
        `scene plan ${value.id}`,
        `  key: ${value.sceneKey}  number: ${value.sceneNumber}  title: ${value.title}`,
        `  narrative purpose: ${value.narrativePurpose || "(unset)"}`,
        `  world: ${value.worldId ?? "none"}  visual DNA: ${value.visualDnaId ?? "version default"}`,
        `  next: flowforge plan spec add --scene-plan-id ${value.id} --kind image --instructions …`,
      ]);
    },
  },
  "plan scene remove": {
    usage: "plan scene remove --scene-plan-id ID",
    summary: "Remove a scene plan (and its specs) from an editable version.",
    flags: ["scene-plan-id"],
    execution: false,
    run({ options, globals, app }) {
      app.plans.removeScenePlan({ scenePlanId: requireString(options, "scene-plan-id") });
      emit(globals, { removed: requireString(options, "scene-plan-id") }, (value) => [`removed scene plan ${value.removed}`]);
    },
  },
  "plan scene cast": {
    usage: 'plan scene cast --scene-plan-id ID --cast-json [{"characterId":"…","role":"…"}]',
    summary: "Set which characters participate in one scene plan.",
    flags: ["scene-plan-id", "cast-json"],
    execution: false,
    run({ options, globals, app }) {
      const row = app.plans.setScenePlanCast({
        scenePlanId: requireString(options, "scene-plan-id"),
        cast: castList(options) ?? [],
      });
      emit(globals, row, (value) => renderSceneRow(value, 0));
    },
  },
  "plan spec add": {
    usage: 'plan spec add --scene-plan-id ID --kind image|video|audio|text --instructions TEXT [--output-count N] [--aspect-ratio 16:9] [--duration-ms N] [--capabilities-csv imageGeneration,referenceImages] [--references-json JSON] [--constraints-json JSON] [--requirement-notes TEXT]',
    summary: "Add a provider-neutral generation spec to a scene plan. Queues nothing.",
    flags: [
      "scene-plan-id",
      "kind",
      "instructions",
      "output-count",
      "aspect-ratio",
      "duration-ms",
      "capabilities-csv",
      "references-json",
      "constraints-json",
      "requirement-notes",
    ],
    execution: false,
    run({ options, globals, app }) {
      const spec = app.plans.addGenerationSpec({
        scenePlanId: requireString(options, "scene-plan-id"),
        kind: requireString(options, "kind"),
        instructions: requireString(options, "instructions"),
        outputCount: optionalNumber(options, "output-count"),
        aspectRatio: optionalString(options, "aspect-ratio"),
        durationMs: optionalNumber(options, "duration-ms"),
        requiredCapabilities: csvList(options, "capabilities-csv"),
        references: parseJsonOption<Array<{ kind: string; id: string; note?: string }>>(
          options,
          "references-json",
        ),
        constraints: jsonList<string>(options, "constraints-json"),
        requirementNotes: optionalString(options, "requirement-notes"),
      });
      emit(globals, spec, (value) => [
        `generation spec ${value.id}  #${value.specNumber}  kind: ${value.kind}`,
        `  instructions: ${value.instructions}`,
        `  outputs: ${value.outputCount}  aspect: ${value.aspectRatio ?? "unset"}  duration: ${value.durationMs ?? "unset"}`,
        `  capabilities: ${value.providerRequirements.capabilities.join(", ") || "none declared"}`,
        `  references: ${value.references.length === 0 ? "none" : value.references.map((reference) => `${reference.kind}:${short(reference.id)}`).join(", ")}`,
      ]);
    },
  },
  "plan spec remove": {
    usage: "plan spec remove --spec-id ID",
    summary: "Remove a generation spec from an editable version.",
    flags: ["spec-id"],
    execution: false,
    run({ options, globals, app }) {
      app.plans.removeGenerationSpec({ specId: requireString(options, "spec-id") });
      emit(globals, { removed: requireString(options, "spec-id") }, (value) => [`removed generation spec ${value.removed}`]);
    },
  },
  "plan overview": {
    usage: "plan overview --project-id ID",
    summary: "Project planning overview: briefs, definitions, and every plan's current state.",
    flags: ["project-id"],
    execution: false,
    run({ options, globals, app }) {
      const overview = app.planReads.projectOverview(requireString(options, "project-id"));
      emit(globals, overview, renderProjectOverview);
    },
  },
};

/* -------------------------------------------------------------------------- */
/* Option helpers                                                              */
/* -------------------------------------------------------------------------- */

function versionTarget(options: ParsedOptions): { planId: string; versionNumber?: number } {
  const planId = requireString(options, "plan-id");
  const versionNumber = optionalNumber(options, "version");
  if (versionNumber !== undefined && !Number.isSafeInteger(versionNumber)) {
    throw new UsageError("--version must be a positive integer.");
  }
  return { planId, versionNumber };
}

/** `--providers mock,google-flow`; without it, no provider is approved for the plan. */
function providerSelection(options: ParsedOptions): string[] | undefined {
  const raw = optionalString(options, "providers");
  if (raw === undefined) return undefined;
  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (values.length === 0) throw new UsageError("--providers must list at least one provider id.");
  return values;
}

type ParsedOptions = ParsedArgs["options"];

function jsonList<T>(options: ParsedOptions, name: string): T[] | undefined {
  const value = parseJsonOption<unknown>(options, name);
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new UsageError(`--${name} must be a JSON array.`);
  return value as T[];
}

function csvList(options: ParsedOptions, name: string): string[] | undefined {
  const raw = optionalString(options, name);
  if (raw === undefined) return undefined;
  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return values.length === 0 ? undefined : values;
}

function castList(options: ParsedOptions): Array<{ characterId: string; role?: string; position?: number }> | undefined {
  const value = jsonList<Record<string, unknown>>(options, "cast-json");
  if (value === undefined) return undefined;
  return value.map((entry, index) => {
    const characterId = entry.characterId ?? entry.id;
    if (typeof characterId !== "string" || characterId.trim() === "") {
      throw new UsageError(`--cast-json[${index}] needs a characterId.`);
    }
    if (entry.position !== undefined && typeof entry.position !== "number") {
      throw new UsageError(`--cast-json[${index}].position must be a number.`);
    }
    return {
      characterId,
      role: typeof entry.role === "string" ? entry.role : undefined,
      position: typeof entry.position === "number" ? entry.position : undefined,
    };
  });
}

const EXECUTE_HINT = "flowforge plan executable --plan-id PLAN --providers <configured ids>";

function short(id: string | undefined): string {
  if (id === undefined) return "none";
  return id.length <= 8 ? id : id.slice(0, 8);
}

/* -------------------------------------------------------------------------- */
/* Renderers — the same data the JSON output carries                          */
/* -------------------------------------------------------------------------- */

function renderBrief(brief: CreativeBrief): string[] {
  return [
    `brief ${brief.id}  v${brief.versionNumber}  ${brief.status}`,
    `  title: ${brief.title}`,
    `  concept: ${brief.concept || "(unset)"}`,
    `  objective: ${brief.objective || "(unset)"}`,
    `  audience: ${brief.audience || "(unset)"}  tone: ${brief.tone || "(unset)"}  style: ${brief.style || "(unset)"}`,
    `  constraints: ${brief.constraints.length === 0 ? "none" : ""}`,
    ...brief.constraints.map((constraint) => `    ${constraint.kind}: ${constraint.value}`),
    `  supersedes: ${brief.supersedesBriefId ?? "none"}`,
    `  content: ${short(brief.contentHash)}`,
  ];
}

function renderCharacter(character: PlanningCharacterRecord): string[] {
  return [
    `character ${character.id}  ${character.name}`,
    `  description: ${character.description ?? "(unset)"}`,
    `  traits: ${character.traits ? `${character.traits.role ?? "role unset"} / ${character.traits.appearance} / ${character.traits.personality}` : "none yet"}`,
    `  visual identity: ${character.visualIdentity?.description ?? "none yet"}`,
    `  distinguishing: ${(character.visualIdentity?.distinguishingFeatures ?? []).join(", ") || "none"}`,
  ];
}

function renderDna(dna: VisualDnaDefinition, created: boolean): string[] {
  return [
    `visual dna ${dna.id}  v${dna.versionNumber}  "${dna.name}"`,
    `  style: ${dna.style}  rendering: ${dna.renderingStyle || "(unset)"}`,
    `  palette: ${dna.palette.join(", ") || "(unset)"}`,
    `  lighting: ${dna.lighting || "(unset)"}  composition: ${dna.composition || "(unset)"}`,
    `  camera language: ${dna.cameraLanguage || "(unset)"}  atmosphere: ${dna.atmosphere || "(unset)"}`,
    `  consistency rules: ${dna.consistencyRules.join(" | ") || "none"}`,
    `  status: ${dna.status}${created ? "" : "  (existing definition reused)"}`,
  ];
}

function renderPlanListRow(plan: PlanListItem): string {
  return [
    `${plan.planId}  v${plan.versionNumber}  ${plan.status.padEnd(10)}`,
    `  "${plan.title}"  scenes: ${plan.counts.scenePlans}  specs: ${plan.counts.generationSpecs}  cast: ${plan.counts.cast}`,
    `  validation: ${plan.validation ? `${plan.validation.status} (${plan.validation.errorCount} errors, ${plan.validation.warningCount} warnings)${plan.validation.isCurrent ? "" : " STALE"}` : "never run"}`,
    `  next action: ${plan.nextAction}${plan.blockers.length > 0 ? `  blocked: ${plan.blockers.join(", ")}` : ""}`,
  ].join("\n");
}

export function renderPlanStatus(detail: PlanDetail): string[] {
  const { plan, version, brief, counts, validation, approval, executability, story } = detail;
  const errors = validation?.findings.filter((finding) => finding.severity === "ERROR") ?? [];
  const warnings = validation?.findings.filter((finding) => finding.severity === "WARNING") ?? [];
  return [
    `plan ${plan.id}  "${plan.title}"  project ${plan.projectId}`,
    `  brief: ${brief ? `${brief.id} v${brief.versionNumber} "${brief.title}" (${brief.status})` : "MISSING"}`,
    `  version: v${version.versionNumber} (${version.id})  status: ${version.status}  content: ${short(version.contentHash)}`,
    `  story: ${story ? story.premise : "missing"}`,
    `  counts: ${counts.scenePlans} scene plan(s), ${counts.generationSpecs} generation spec(s), ${counts.cast} cast, ${counts.worlds} world(s), ${counts.visualDna} dna snapshot(s)`,
    `  validity: ${validation ? `${validation.status} via ${validation.validatorVersion} @ ${validation.recordedAt}${validation.isCurrent ? "" : "  (STALE — content changed since)"}` : "never validated"}`,
    ...errors.slice(0, 12).map((finding) => `    ! ${finding.code} (${finding.subject.kind} ${short(finding.subject.id)}): ${finding.message}`),
    ...(errors.length > 12 ? [`    … ${errors.length - 12} more error(s)`] : []),
    ...warnings.slice(0, 6).map((finding) => `    ~ ${finding.code} (${finding.subject.kind} ${short(finding.subject.id)}): ${finding.message}`),
    `  approval: ${approval.approvedBy ? `${approval.approvedBy} @ ${approval.approvedAt}` : "not approved"}  evidence: ${approval.approvedValidationId ? short(approval.approvedValidationId) : "none"}`,
    `  executability: ${executability.executable ? "EXECUTABLE" : "not executable"}  providers: ${(approval.executableProviders ?? []).join(", ") || "none"}  blockers: ${executability.blockers.join(", ") || "none"}`,
    `  unsatisfiable specs: ${executability.capabilityCoverage.filter((row) => row.unsatisfied.length > 0).length}`,
    `  next action: ${detail.nextAction}`,
    ...(validation && validation.status === "FAILED" ? [`  blocking findings: ${validation.errorCount}`] : []),
  ];
}

function renderPlanDetail(detail: PlanDetail): string[] {
  const lines = renderPlanStatus(detail);
  const { version, story, cast, worlds, visualDna, scenePlans, lineage } = detail;
  lines.push(
    `  lineage: predecessor ${lineage.predecessorVersionId ? short(lineage.predecessorVersionId) : "none"}; successors ${lineage.successorVersionIds.map((id) => short(id)).join(", ") || "none"}`,
    `  revision note: ${version.revisionNote ?? "none"}`,
    "",
    "cast:",
    ...(cast.length === 0 ? ["  none"] : cast.map((row) => `  ${row.name} (${short(row.characterId)})  role: ${row.role || "(unset)"}${row.hasIdentityTraits ? "" : "  no traits"}`)),
    "",
    "worlds:",
    ...(worlds.length === 0 ? ["  none"] : worlds.map((world) => `  ${world.name} v${world.versionNumber} ${world.status}  ${world.environment || "(no environment)"}`)),
    "",
    "visual dna:",
    ...(visualDna.length === 0 ? ["  none"] : visualDna.map((dna) => `  ${dna.name} v${dna.versionNumber} ${dna.status}  ${dna.style}`)),
  );
  if (story) {
    lines.push(
      "",
      `story ${story.id}:`,
      `  premise: ${story.premise}`,
      `  structure: ${story.structure || "(unset)"}`,
      `  themes: ${story.themes.join(", ") || "none"}`,
      `  beginning: ${story.beginning || "(unset)"}`,
      `  development: ${story.development || "(unset)"}`,
      `  ending: ${story.ending || "(unset)"}`,
    );
  }
  lines.push("", `scene plans (${scenePlans.length}):`);
  for (const row of scenePlans) lines.push(...renderSceneRow(row, 2));
  return lines;
}

export function renderSceneRow(row: PlanScenePlanRow, indent: number): string[] {
  const pad = " ".repeat(indent);
  return [
    `${pad}${row.sceneNumber}. ${row.title}  [${row.sceneKey}] ${row.scenePlanId}`,
    `${pad}  purpose: ${row.narrativePurpose || "(unset)"}  duration target: ${row.durationTargetMs ?? "unset"}`,
    `${pad}  world: ${row.world ? `${row.world.name}${row.world.versionNumber ? ` v${row.world.versionNumber}` : ""}` : "none"}`,
    `${pad}  visual dna: ${row.visualDna ? `${row.visualDna.name} (from ${row.visualDna.source})${row.visualDna.resolvedInProject ? "" : " UNRESOLVED"}` : "MISSING"}`,
    `${pad}  cast: ${row.cast.length === 0 ? "none" : row.cast.map((link) => `${link.name}${link.role ? ` as ${link.role}` : ""}`).join(", ")}`,
    `${pad}  continuity: ${row.continuity.length === 0 ? "none" : row.continuity.map((entry) => entry.statement).join(" | ")}`,
    `${pad}  required references: ${row.requiredReferences.length === 0 ? "none" : row.requiredReferences.map((reference) => `${reference.kind}:${short(reference.id)}`).join(", ")}`,
    `${pad}  planned outputs: ${row.plannedOutputs.length === 0 ? "none" : row.plannedOutputs.map((output) => `${output.kind}×${output.count}`).join(", ")}`,
    ...row.specs.map((spec) =>
      `${pad}  spec #${spec.specNumber} ${spec.kind} ${spec.id}`,
    ),
    ...row.specs.map((spec) =>
      `${pad}    outputs: ${spec.outputCount}  aspect: ${spec.aspectRatio ?? "unset"}  duration: ${spec.durationMs ?? "unset"}  capabilities: ${spec.providerRequirements.capabilities.join("+") || "none"}`,
    ),
    ...row.specs.map((spec) => `${pad}    instructions: ${spec.instructions}`),
  ];
}

function renderValidation(report: PlanValidationView): string[] {
  return [
    `validation ${report.validationId}: ${report.status}`,
    `  validator: ${report.validatorVersion}  recorded: ${report.recordedAt}`,
    `  content: ${short(report.contentHash)}${report.isCurrent ? " (current)" : " (STALE)"}`,
    `  findings: ${report.errorCount} error(s), ${report.warningCount} warning(s)`,
    ...report.findings.map((finding) => `    ${finding.severity === "ERROR" ? "!" : "~"} ${finding.code} (${finding.subject.kind} ${short(finding.subject.id)}): ${finding.message}`),
  ];
}

function renderPreview(preview: ExecutionPreview): string[] {
  return [
    `execution preview for plan ${preview.planId}  v${preview.versionNumber}  status: ${preview.status}`,
    `  executable: ${preview.executable ? "yes" : "no"}  blockers: ${preview.blockers.join(", ") || "none"}`,
    `  ${preview.note}`,
    ...preview.items.map((item) =>
      [
        `  ${item.sceneNumber}. ${item.sceneKey} → scene "${item.sceneTitle}", new version, ${item.kind} spec ${short(item.specId)}`,
        `      prompt: ${item.prompt}`,
        `      command: scene version add --title "${item.sceneVersionTitle}" --prompt … then generate --output-count ${item.outputCount}${item.aspectRatio ? ` --aspect-ratio ${item.aspectRatio}` : ""}`,
        `      capabilities: ${item.requiredCapabilities.join("+") || "none"}  candidates: ${item.candidateProviders.join(", ") || "none"}`,
        `      acceptable: ${item.acceptable ? "yes" : `no — ${item.reason}`}`,
      ].join("\n"),
    ),
  ];
}

function renderProjectOverview(overview: ProjectPlanningOverview): string[] {
  return [
    `project ${overview.projectId}`,
    `  briefs: ${overview.briefs.length}  characters: ${overview.characters.length}  worlds: ${overview.worlds.length}  visual dna: ${overview.visualDna.length}`,
    ...overview.briefs.map((brief) => `  brief ${short(brief.id)}  v${brief.versionNumber}  ${brief.status}  ${brief.title}`),
    `  plans: ${overview.plans.length}`,
    ...overview.plans.map((plan) => renderPlanListRow(plan)),
  ];
}

function renderStory(story: { id: string; premise: string; structure: string; themes: string[]; beginning: string; development: string; ending: string }): string[] {
  return [
    `story ${story.id}`,
    `  premise: ${story.premise}`,
    `  structure: ${story.structure || "(unset)"}`,
    `  themes: ${story.themes.join(", ") || "none"}`,
    `  beginning: ${story.beginning || "(unset)"}`,
    `  development: ${story.development || "(unset)"}`,
    `  ending: ${story.ending || "(unset)"}`,
  ];
}

/** `plan validate` reports a blocking exit code when the recorded report still contains errors. */
function isBlockedByFindings(result: { report: PlanValidationView }): boolean {
  return result.report.status === "FAILED";
}
