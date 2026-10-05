import { describeThrown } from "@flowforge/services";
import type {
  FlowForgeApplication,
  GenerationStatus,
  ProductionReadiness,
  ProjectOverview,
  ProjectProductionSummary,
  QueueStatus,
  ReviewQueueItem,
  SceneDetail,
} from "@flowforge/services";
import { parseArgs, rejectUnknown, UsageError, isSet, optionalNumber, optionalString, parseJsonOption, requireString } from "./args.js";
import type { ParsedArgs } from "./args.js";
import { GLOBAL_FLAGS, openApplication, resolveGlobals, type OpenedApplication, type ResolvedGlobals } from "./runtime.js";

export { EXIT_BLOCKED, EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "./command-context.js";

import {
  EXIT_BLOCKED,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  defaultReviewer,
  emit,
  type CommandContext,
  type CommandDefinition,
} from "./command-context.js";
import { PLANNING_COMMANDS } from "./planning-commands.js";
import { PLANNER_COMMANDS } from "./planner-commands.js";

/**
 * Codes where the command was well formed and the durable state legitimately refuses it. Planning
 * approvals and the executability gate land here, so scripts can distinguish "fix the plan" from
 * "fix the invocation".
 */
const BLOCKING_CODES = new Set<string>([
  "READINESS_NOT_SATISFIED",
  "PROVIDER_COVERAGE_INCOMPLETE",
  "ACTIVE_WORK_PRESENT",
  "RETRY_BLOCKED_UNSAFE_STATE",
  "REVIEW_ALREADY_DECIDED",
  "PLAN_VALIDATION_REQUIRED",
  "PLAN_NOT_APPROVED",
  "PLAN_NOT_EXECUTABLE",
  "PLAN_NOT_EDITABLE",
  "PLAN_CAPABILITY_UNMET",
]);

export async function runOperatorCommand(argv: readonly string[]): Promise<number> {
  // Decided up front so even a parse or wiring failure can be reported in the requested shape.
  const jsonOutput = argv.includes("--json");
  try {
    return await dispatchOperatorCommand(argv);
  } catch (error) {
    return reportError(error, jsonOutput);
  }
}

async function dispatchOperatorCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const path = args.command.join(" ");
  if (args.command.length === 0) return printTopLevelHelp();
  if (path === "help" || path === "help help") {
    const topic = args.command.slice(1).join(" ");
    return topic ? printCommandHelp(topic) : printTopLevelHelp();
  }
  const definition = COMMANDS[path];
  if (!definition) {
    throw new UsageError(`Unknown command: ${args.command.join(" ")}`, "Run `flowforge help` for the command list.");
  }
  if (isSet(args.options, "help")) return printCommandHelp(path);
  rejectUnknown(args.options, [...definition.flags, ...GLOBAL_FLAGS, "help"], path);

  const globals = resolveGlobals(args);
  const opened = await openApplication(globals, { execution: definition.execution === true });
  try {
    await definition.run({ options: args.options, globals, app: opened.app, opened });
    return process.exitCode === EXIT_BLOCKED ? EXIT_BLOCKED : EXIT_OK;
  } catch (error) {
    return reportError(error, globals.json);
  } finally {
    await opened.close();
  }
}

function reportError(error: unknown, json: boolean): number {
  const described = describeThrown(error);
  if (error instanceof UsageError) {
    console.error(`Usage error: ${described.message}${error.hint ? `\n  ${error.hint}` : ""}`);
    return EXIT_USAGE;
  }
  if (json) {
    console.log(JSON.stringify({ ok: false, ...described }, null, 2));
  } else {
    console.error(`${described.code}: ${described.message}`);
    const details = describeDetails(described.details);
    if (details.length > 0) console.error(details.map((line) => `  ${line}`).join("\n"));
  }
  return described.code !== "UNEXPECTED_ERROR" && BLOCKING_CODES.has(described.code) ? EXIT_BLOCKED : EXIT_ERROR;
}

function describeDetails(details: Readonly<Record<string, unknown>>): string[] {
  const lines: string[] = [];
  const blockers = details.blockers;
  if (Array.isArray(blockers)) {
    for (const blocker of blockers) {
      if (blocker && typeof blocker === "object" && "message" in blocker) {
        const entry = blocker as { code?: unknown; message?: unknown };
        lines.push(`${String(entry.code ?? "BLOCKER")}: ${String(entry.message ?? "")}`);
        continue;
      }
      lines.push(String(blocker));
    }
  }
  for (const [key, value] of Object.entries(details)) {
    if (key === "blockers" || value === undefined) continue;
    lines.push(`${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  return lines;
}

const COMMANDS: Record<string, CommandDefinition> = {
  "project create": {
    usage: 'project create --name NAME [--description TEXT] [--project-id ID] [--metadata-json JSON]',
    summary: "Create a project (the durable container for scenes).",
    flags: ["name", "description", "project-id", "metadata-json"],
    execution: false,
    run({ options, globals, app }) {
      const project = app.projects.createProject({
        projectId: optionalString(options, "project-id"),
        name: requireString(options, "name"),
        description: optionalString(options, "description"),
        metadata: parseJsonOption<Record<string, unknown>>(options, "metadata-json"),
      });
      emit(globals, project, (value) => [`project ${value.id}`, `  name: ${value.name}`, `  status: ${value.status}`]);
    },
  },
  "project list": {
    usage: "project list",
    summary: "List projects.",
    flags: [],
    execution: false,
    run({ globals, app }) {
      const projects = app.projects.listProjects();
      emit(globals, projects, (value) =>
        value.length === 0
          ? ["no projects — create one with `flowforge project create --name …`"]
          : value.map((project) => `${project.id}  ${project.status}  ${project.name}`),
      );
    },
  },
  "project show": {
    usage: "project show --project-id ID",
    summary: "Project overview: scenes, job totals, pending reviews, queue depth.",
    flags: ["project-id"],
    execution: false,
    run({ options, globals, app }) {
      const overview = app.projects.overview(requireString(options, "project-id"));
      emit(globals, overview, renderProjectOverview);
    },
  },
  "project archive": {
    usage: "project archive --project-id ID",
    summary: "Archive a project once no generation work is open.",
    flags: ["project-id"],
    execution: false,
    run({ options, globals, app }) {
      const project = app.projects.archiveProject({ projectId: requireString(options, "project-id") });
      emit(globals, project, (value) => [`project ${value.id} status: ${value.status}`]);
    },
  },
  "scene create": {
    usage: 'scene create --project-id ID --title TITLE [--scene-number N] [--scene-id ID] [--description TEXT] [--metadata-json JSON]',
    summary: "Create a scene inside a project.",
    flags: ["project-id", "title", "scene-number", "scene-id", "description", "metadata-json"],
    execution: false,
    run({ options, globals, app }) {
      const scene = app.scenes.createScene({
        projectId: requireString(options, "project-id"),
        sceneId: optionalString(options, "scene-id"),
        title: requireString(options, "title"),
        sceneNumber: optionalNumber(options, "scene-number"),
        description: optionalString(options, "description"),
        metadata: parseJsonOption<Record<string, unknown>>(options, "metadata-json"),
      });
      emit(globals, scene, (value) => [`scene ${value.id}`, `  number: ${value.sceneNumber}`, `  title: ${value.title}`, `  status: ${value.status}`]);
    },
  },
  "scene list": {
    usage: "scene list --project-id ID",
    summary: "Scene board for a project, with readiness and blockers.",
    flags: ["project-id"],
    execution: false,
    run({ options, globals, app }) {
      const scenes = app.scenes.listScenes(requireString(options, "project-id"));
      emit(globals, scenes, (value) =>
        value.length === 0
          ? ["no scenes — create one with `flowforge scene create …`"]
          : value.map(
              (scene) =>
                `#${scene.sceneNumber} ${scene.title} [${scene.status}] jobs=${scene.jobCount} open=${scene.openJobCount} reviews=${scene.pendingReviewCount}` +
                `${scene.productionReady ? " PRODUCTION-READY" : ` blocked: ${scene.blockers.join(", ") || "none"}`}`,
            ),
      );
    },
  },
  "scene show": {
    usage: "scene show --scene-id ID",
    summary: "Scene detail: versions, jobs, outputs, readiness evidence.",
    flags: ["scene-id"],
    execution: false,
    run({ options, globals, app }) {
      const detail = app.scenes.detail(requireString(options, "scene-id"));
      emit(globals, detail, renderSceneDetail);
    },
  },
  "scene version add": {
    usage: 'scene version add --scene-id ID --prompt TEXT [--references-json JSON] [--metadata-json JSON]',
    summary: "Record an immutable scene version (the canonical prompt) and make it current.",
    flags: ["scene-id", "prompt", "references-json", "metadata-json"],
    execution: false,
    run({ options, globals, app }) {
      const version = app.scenes.addSceneVersion({
        sceneId: requireString(options, "scene-id"),
        prompt: requireString(options, "prompt"),
        references: parseJsonOption<string[]>(options, "references-json"),
        metadata: parseJsonOption<Record<string, unknown>>(options, "metadata-json"),
      });
      emit(globals, version, (value) => [
        `scene version ${value.id}`,
        `  number: ${value.versionNumber} (now current)`,
        `  prompt: ${value.prompt}`,
        `  references: ${value.references.length}`,
      ]);
    },
  },
  "scene version list": {
    usage: "scene version list --scene-id ID",
    summary: "List scene versions with the current pointer marked.",
    flags: ["scene-id"],
    execution: false,
    run({ options, globals, app }) {
      const versions = app.scenes.listSceneVersions(requireString(options, "scene-id"));
      emit(globals, versions, (value) =>
        value.map(
          (version) =>
            `v${version.versionNumber}${version.isCurrent ? " *" : "  "} ${version.id}  ${version.prompt.slice(0, 72)}`,
        ),
      );
    },
  },
  "scene version set": {
    usage: "scene version set --scene-id ID --scene-version-id ID",
    summary: "Point the scene at an existing scene version.",
    flags: ["scene-id", "scene-version-id"],
    execution: false,
    run({ options, globals, app }) {
      const scene = app.scenes.setCurrentVersion({
        sceneId: requireString(options, "scene-id"),
        sceneVersionId: requireString(options, "scene-version-id"),
      });
      emit(globals, scene, (value) => [`scene ${value.id} current version: ${value.currentVersionId}`]);
    },
  },
  "scene status set": {
    usage: "scene status set --scene-id ID --status DRAFT|ARCHIVED",
    summary: "Reopen or archive a scene. READY is set by `production ready`, never here.",
    flags: ["scene-id", "status"],
    execution: false,
    run({ options, globals, app }) {
      const status = requireString(options, "status").toUpperCase();
      if (status !== "DRAFT" && status !== "ARCHIVED") {
        throw new UsageError("--status must be DRAFT or ARCHIVED for this command.", "Use `flowforge production ready --scene-id …`.");
      }
      const scene = app.scenes.setStatus({ sceneId: requireString(options, "scene-id"), status });
      emit(globals, scene, (value) => [`scene ${value.id} status: ${value.status}`]);
    },
  },
  generate: {
    usage: "generate --project-id ID --scene-id ID [--scene-version-id ID] [--provider ID] [--parameters-json JSON] [--metadata-json JSON] [--max-attempts N] [--priority N] [--allow-unconfigured-provider]",
    summary: "Validate the request, then create or reuse the idempotent job (queued atomically).",
    flags: ["project-id", "scene-id", "scene-version-id", "parameters-json", "metadata-json", "max-attempts", "priority", "allow-unconfigured-provider"],
    execution: false,
    run({ options, globals, app }) {
      const result = app.generation.requestGeneration({
        projectId: requireString(options, "project-id"),
        sceneId: requireString(options, "scene-id"),
        sceneVersionId: optionalString(options, "scene-version-id"),
        provider: globals.provider,
        parameters: parseJsonOption<Record<string, unknown>>(options, "parameters-json"),
        metadata: parseJsonOption<Record<string, unknown>>(options, "metadata-json"),
        maxAttempts: optionalNumber(options, "max-attempts"),
        priority: optionalNumber(options, "priority"),
        allowUnconfiguredProvider: isSet(options, "allow-unconfigured-provider"),
      });
      emit(globals, result, (value) => [
        `${value.created ? "queued" : "reused existing"} job ${value.job.id}`,
        `  status: ${value.job.status}  provider: ${value.job.provider}  attempts: ${value.job.attemptCount}/${value.job.maxAttempts}`,
        `  queue: ${value.queue?.status ?? "none"}  next action: ${value.status.nextAction}`,
      ]);
    },
  },
  status: {
    usage: "status (--job-id ID | --scene-id ID)",
    summary: "Generation status read model: job, queue item, attempts, outputs, next action.",
    flags: ["job-id", "scene-id"],
    execution: false,
    run({ options, globals, app }) {
      const jobId = optionalString(options, "job-id");
      const sceneId = optionalString(options, "scene-id");
      if (!jobId && !sceneId) throw new UsageError("status needs --job-id or --scene-id.");
      if (jobId) {
        const status = app.generation.status(jobId);
        emit(globals, status, renderGenerationStatus);
        return;
      }
      const statuses = app.generation.statusForScene(sceneId!);
      emit(globals, statuses, (value) =>
        value.length === 0 ? ["no generations for this scene"] : value.map(renderGenerationStatus).flat(),
      );
    },
  },
  cancel: {
    usage: "cancel --job-id ID [--local-only]",
    summary: "Cancel queued or running work. Local cancellation is final; provider cancellation only runs through the serving worker.",
    flags: ["job-id", "local-only"],
    execution: true,
    async run({ options, globals, app }) {
      const result = await app.generation.cancel({
        jobId: requireString(options, "job-id"),
        localOnly: isSet(options, "local-only"),
      });
      emit(globals, result, (value) => [
        `job ${value.job.id} status: ${value.job.status}`,
        `  local cancellation: ${value.localCancellation}`,
        `  provider cancellation: ${value.providerCancellation}${value.providerCancellationReason ? ` (${value.providerCancellationReason})` : ""}`,
      ]);
    },
  },
  retry: {
    usage: "retry --job-id ID [--available-at ISO]",
    summary: "Requeue a failed job when the durable state proves resubmission is safe.",
    flags: ["job-id", "available-at"],
    execution: false,
    run({ options, globals, app }) {
      const result = app.generation.retry({
        jobId: requireString(options, "job-id"),
        availableAt: optionalString(options, "available-at"),
      });
      emit(globals, result.status, (value) => [
        `job ${value.job.id} requeued (status ${value.job.status}, attempts ${value.job.attemptCount}/${value.job.maxAttempts})`,
        `  queue: ${value.queue?.status ?? "none"}  next action: ${value.nextAction}`,
      ]);
    },
  },
  "queue status": {
    usage: "queue status",
    summary: "Queue depth, items, and which providers this worker serves.",
    flags: [],
    execution: false,
    run({ globals, app }) {
      const status = app.execution.status();
      emit(globals, status, renderQueueStatus);
    },
  },
  "queue run": {
    usage: "queue run [--max-jobs N] [--all] [--ignore-provider-coverage]",
    summary: "Drive the durable worker over the queued work.",
    flags: ["max-jobs", "all", "ignore-provider-coverage"],
    execution: true,
    async run({ options, globals, app }) {
      const maxJobs = isSet(options, "all") ? optionalNumber(options, "max-jobs") ?? 10_000 : optionalNumber(options, "max-jobs") ?? 1;
      const execution = await app.execution.drain({
        maxJobs,
        ignoreProviderCoverage: isSet(options, "ignore-provider-coverage"),
      });
      emit(globals, execution, (value) => [
        `worker ${value.workerId}: attempted ${value.attempted} job(s)`,
        ...value.results.map(
          (result) => `  ${result.jobId}  ${result.status}${result.qcStatus ? `  qc=${result.qcStatus}` : ""}${result.assetVersionId ? `  asset=${result.assetVersionId}` : ""}${result.error ? `  error=${result.error}` : ""}`,
        ),
        ...(value.attempted === 0 ? ["  nothing claimable for the served provider"] : []),
        `  queue after: ${value.after.depth.claimableNow} claimable, ${value.after.depth.claimed} claimed`,
      ]);
    },
  },
  "queue recover": {
    usage: "queue recover",
    summary: "Requeue work whose worker lease expired (the durable recovery path).",
    flags: [],
    execution: false,
    run({ globals, app }) {
      const recovery = app.execution.recoverLeases();
      emit(globals, recovery, (value) => [
        `recovered leases: ${value.recoveredLeases}`,
        `  queue now: ${value.after.depth.claimableNow} claimable, ${value.after.depth.claimed} claimed`,
      ]);
    },
  },
  "review list": {
    usage: "review list [--project-id ID] [--scene-id ID] [--all]",
    summary: "Asset versions awaiting a human decision (or every decided one with --all).",
    flags: ["project-id", "scene-id", "all"],
    execution: false,
    run({ options, globals, app }) {
      const includeAll = isSet(options, "all");
      const sceneId = optionalString(options, "scene-id");
      const projectId = optionalString(options, "project-id");
      const items = includeAll
        ? collectAll(app, { sceneId, projectId })
        : sceneId
          ? app.reviews.listForScene(sceneId)
          : app.reviews.listPending({ sceneId, projectId });
      emit(globals, items, (value) =>
        value.length === 0
          ? [includeAll ? "no reviewed asset versions" : "nothing awaiting review"]
          : ["asset version              scene               qc        review      selected", ...value.map(renderReviewRow)],
      );
    },
  },
  "review show": {
    usage: "review show --asset-version-id ID",
    summary: "One review row with QC evidence and the storage path to inspect.",
    flags: ["asset-version-id"],
    execution: false,
    run({ options, globals, app }) {
      const item = app.reviews.get(requireString(options, "asset-version-id"));
      emit(globals, item, renderReviewDetail);
    },
  },
  "review approve": {
    usage: "review approve --asset-version-id ID [--reviewer NAME] [--comment TEXT] [--reason TEXT]",
    summary: "Record an explicit APPROVED decision.",
    flags: ["asset-version-id", "reviewer", "comment", "reason"],
    execution: false,
    run({ options, globals, app }) {
      const result = app.reviews.decide({
        assetVersionId: requireString(options, "asset-version-id"),
        decision: "APPROVED",
        reviewer: defaultReviewer(options),
        comment: optionalString(options, "comment"),
        reason: optionalString(options, "reason"),
      });
      emit(globals, result, (value) => [
        `review ${value.review.assetVersionId}: ${value.review.status}${value.idempotent ? " (unchanged, decision already recorded)" : ""}`,
        `  reviewer: ${value.review.reviewer ?? "n/a"}`,
      ]);
    },
  },
  "review reject": {
    usage: "review reject --asset-version-id ID [--reviewer NAME] [--comment TEXT] [--reason TEXT]",
    summary: "Record an explicit REJECTED decision.",
    flags: ["asset-version-id", "reviewer", "comment", "reason"],
    execution: false,
    run({ options, globals, app }) {
      const result = app.reviews.decide({
        assetVersionId: requireString(options, "asset-version-id"),
        decision: "REJECTED",
        reviewer: defaultReviewer(options),
        comment: optionalString(options, "comment"),
        reason: optionalString(options, "reason"),
      });
      emit(globals, result, (value) => [
        `review ${value.review.assetVersionId}: ${value.review.status}${value.idempotent ? " (unchanged, decision already recorded)" : ""}`,
        `  reason: ${value.review.reason ?? "n/a"}`,
      ]);
    },
  },
  "review select": {
    usage: "review select --scene-id ID --asset-version-id ID",
    summary: "Explicitly select an approved, QC-passing asset version as the scene's output.",
    flags: ["scene-id", "asset-version-id"],
    execution: false,
    run({ options, globals, app }) {
      const selection = app.reviews.select({
        sceneId: requireString(options, "scene-id"),
        assetVersionId: requireString(options, "asset-version-id"),
      });
      emit(globals, selection, (value) => [
        `scene ${value.scene.id} selected ${value.assetVersion.id}`,
        `  checksum: ${value.assetVersion.checksum}`,
        `  production ready: ${value.readiness.productionReady ? "yes" : `no (${value.readiness.blockers.map((blocker) => blocker.code).join(", ")})`}`,
      ]);
    },
  },
  "review selected": {
    usage: "review selected --scene-id ID",
    summary: "Show the scene's currently selected asset version, if any.",
    flags: ["scene-id"],
    execution: false,
    run({ options, globals, app }) {
      const output = app.reviews.selected(requireString(options, "scene-id"));
      emit(globals, output, (value) =>
        value === null
          ? ["no asset version selected"]
          : [
              `selected ${value.assetVersionId}`,
              `  file: ${value.storagePath}`,
              `  qc: ${value.qc?.status ?? "not recorded"}  review: ${value.review?.status ?? "none"}`,
            ],
      );
    },
  },
  "production scene": {
    usage: "production scene --scene-id ID",
    summary: "Derived production readiness for one scene, with every blocking reason.",
    flags: ["scene-id"],
    execution: false,
    run({ options, globals, app }) {
      const readiness = app.production.readiness(requireString(options, "scene-id"));
      emit(globals, readiness, renderReadiness);
    },
  },
  ...PLANNING_COMMANDS,
  ...PLANNER_COMMANDS,
  "production ready": {
    usage: "production ready --scene-id ID",
    summary: "Mark a scene READY after the readiness gate passes.",
    flags: ["scene-id"],
    execution: false,
    run({ options, globals, app }) {
      const readiness = app.production.markReady(requireString(options, "scene-id"));
      emit(globals, readiness, renderReadiness);
    },
  },
  "production reopen": {
    usage: "production reopen --scene-id ID",
    summary: "Reopen a READY scene for further work.",
    flags: ["scene-id"],
    execution: false,
    run({ options, globals, app }) {
      const scene = app.production.reopen(requireString(options, "scene-id"));
      emit(globals, scene, (value) => [`scene ${value.id} status: ${value.status}`]);
    },
  },
  "production project": {
    usage: "production project --project-id ID",
    summary: "Project-wide production summary: per-scene readiness and blocking reasons.",
    flags: ["project-id"],
    execution: false,
    run({ options, globals, app }) {
      const summary = app.production.projectSummary(requireString(options, "project-id"));
      emit(globals, summary, renderProjectSummary);
    },
  },
  "provider list": {
    usage: "provider list [--provider ID]",
    summary: "Declared capabilities of the providers wired into this invocation.",
    flags: [],
    execution: false,
    run({ globals, app }) {
      const providers = [...app.providers.values()].map((descriptor) => ({ id: descriptor.id, capabilities: descriptor.capabilities }));
      emit(globals, providers, (value) =>
        value.flatMap((entry) => [
          `provider ${entry.id}`,
          ...Object.entries(entry.capabilities).map(([capability, enabled]) => `  ${capability}: ${enabled ? "supported" : "not supported"}`),
        ]),
      );
    },
  },
};

function collectAll(app: FlowForgeApplication, filter: { sceneId?: string; projectId?: string }): ReviewQueueItem[] {
  const sceneIds = filter.sceneId
    ? [filter.sceneId]
    : filter.projectId
      ? app.scenes.listScenes(filter.projectId).map((scene) => scene.sceneId)
      : app.projects.listProjects().flatMap((project) => app.scenes.listScenes(project.id).map((scene) => scene.sceneId));
  return sceneIds.flatMap((sceneId) => app.reviews.listForScene(sceneId));
}

function renderProjectOverview(overview: ProjectOverview): string[] {
  const totals = overview.totals;
  return [
    `project ${overview.project.id} — ${overview.project.name} [${overview.project.status}]`,
    `  scenes ${totals.scenes} (production ready ${totals.readyScenes})  jobs ${totals.jobs}  pending reviews ${totals.pendingReviews}  queued ${totals.queuedWork}  assets ${totals.assets}`,
    `  jobs by status: ${Object.entries(totals.jobsByStatus).filter(([, count]) => count > 0).map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`,
    ...(overview.scenes.length === 0 ? ["  no scenes yet"] : []),
    ...overview.scenes.map(
      (scene) =>
        `  #${scene.sceneNumber} ${scene.title} [${scene.status}] v${scene.currentVersionNumber ?? "-"} jobs=${scene.jobCount} open=${scene.openJobCount}` +
        `${scene.productionReady ? "  PRODUCTION-READY" : `  blocked: ${scene.blockers.join(", ") || "none"}`}`,
    ),
  ];
}

function renderSceneDetail(detail: SceneDetail): string[] {
  return [
    `scene ${detail.scene.id} — ${detail.scene.title} [${detail.scene.status}]`,
    `  current version: ${detail.scene.currentVersionId ?? "none"}`,
    `  selected asset: ${detail.scene.selectedAssetVersionId ?? "none"}`,
    ...detail.versions.map((version) => `  v${version.versionNumber}${version.isCurrent ? " *" : "  "} ${version.id}  ${version.prompt}`),
    ...(detail.jobs.length === 0 ? ["  no generation jobs"] : detail.jobs.map((job) => `  job ${job.id}  ${job.status}  provider=${job.provider}  attempts=${job.attemptCount}/${job.maxAttempts}`)),
    ...detail.outputs.map(
      (output) =>
        `  output ${output.assetVersionId}  qc=${output.qc?.status ?? "n/a"}  review=${output.review?.status ?? "none"}${output.selected ? "  SELECTED" : ""}`,
    ),
    "",
    ...renderReadiness(detail.readiness),
  ];
}

function renderGenerationStatus(status: GenerationStatus): string[] {
  return [
    `job ${status.job.id}  ${status.job.status}`,
    `  request: ${status.request.sceneId} v-${status.request.sceneVersionId ?? "legacy"}  provider=${status.request.provider}  refs=${status.request.referenceCount}`,
    `  prompt: ${status.request.promptPreview}`,
    `  queue: ${status.queue ? `${status.queue.status} (claims ${status.queue.claimCount})` : "none"}  next action: ${status.nextAction}`,
    `  safe to retry: ${status.safeToRetry ? "yes" : "no"}`,
    ...status.attempts.map(
      (attempt) =>
        `  attempt ${attempt.attemptNumber} ${attempt.status}${attempt.errorClass ? ` [${attempt.errorClass}]` : ""}${attempt.providerJobId ? `  providerJob=${attempt.providerJobId}` : ""}${attempt.recoveryCount ? `  recoveries=${attempt.recoveryCount}` : ""}`,
    ),
    ...status.outputs.map(
      (output) =>
        `  output ${output.assetVersionId}  ${output.mimeType} ${output.sizeBytes}B  qc=${output.qc?.status ?? "n/a"}  review=${output.review?.status ?? "none"}${output.selected ? "  SELECTED" : ""}`,
    ),
    ...(status.job.error ? [`  error: ${status.job.error}`] : []),
  ];
}

function renderQueueStatus(status: QueueStatus): string[] {
  return [
    `queue depth: ${status.depth.claimableNow} claimable now, ${status.depth.claimed} claimed, ${status.depth.acked} acked, ${status.depth.failed} failed, ${status.depth.cancelled} cancelled`,
    `worker: ${status.worker ? `${status.worker.workerId} (provider ${status.worker.providerId})` : "not wired in this invocation"}`,
    `configured providers: ${status.configuredProviders.join(", ") || "none"}`,
    `jobs by status: ${Object.entries(status.jobsByStatus).filter(([, count]) => count > 0).map(([jobStatus, count]) => `${jobStatus}=${count}`).join(", ") || "none"}`,
    ...(status.items.length === 0 ? ["  empty"] : []),
    ...status.items.slice(0, 25).map(
      (item) =>
        `  ${item.jobId}  ${item.status}${item.claimableNow ? " (claimable)" : ""}  provider=${item.provider}  job=${item.jobStatus}  claims=${item.claimCount}  available=${item.availableAt}` +
        `${item.workerId ? `  worker=${item.workerId}` : ""}${item.lastError ? `  lastError=${item.lastError}` : ""}`,
    ),
    ...(status.items.length > 25 ? [`  … ${status.items.length - 25} more (use --json for the full list)`] : []),
  ];
}

function renderReadiness(readiness: ProductionReadiness): string[] {
  return [
    `scene ${readiness.sceneId} production ready: ${readiness.productionReady ? "YES" : "NO"}  [${readiness.sceneStatus}]`,
    `  current version: ${readiness.currentSceneVersionId ?? "none"}  selected asset: ${readiness.selectedAssetVersionId ?? "none"}`,
    ...(readiness.blockers.length > 0
      ? readiness.blockers.map((blocker) => `  blocker ${blocker.code}: ${blocker.message}`)
      : readiness.sceneStatus === "READY"
        ? ["  no blockers — the scene is marked READY for production use"]
        : ["  no blockers — run `flowforge production ready --scene-id …` to mark it READY"]),
  ];
}

function renderProjectSummary(summary: ProjectProductionSummary): string[] {
  return [
    `project ${summary.projectId} — ${summary.projectName} [${summary.projectStatus}]`,
    `  production ready: ${summary.productionReady ? "YES" : "NO"}  (scenes ${summary.counts.productionReady}/${summary.counts.scenes} ready; ${summary.counts.archived} archived)`,
    `  assets: ${summary.assets.count}`,
    ...summary.scenes.map(
      (scene) =>
        `  ${scene.sceneId}  [${scene.status}]  ${scene.productionReady ? "PRODUCTION-READY" : `blocked: ${scene.blockers.join(", ") || "none"}`}${scene.selectedAssetVersionId ? `  asset=${scene.selectedAssetVersionId}` : ""}`,
    ),
    ...(summary.blockingReasons.length === 0 ? [] : [`  blockers: ${summary.blockingReasons.join(", ")}`]),
  ];
}

function renderReviewRow(item: ReviewQueueItem): string {
  return (
    `${item.assetVersionId.padEnd(24)}  ${(item.sceneTitle.slice(0, 18) + "                ").slice(0, 18)}  ` +
    `${(item.qcStatus ?? "n/a").padEnd(7)}  ${item.reviewStatus.padEnd(9)}  ${item.selected ? "SELECTED" : ""}  v${item.sceneVersionNumber} job=${item.jobStatus}`
  );
}

function renderReviewDetail(item: ReviewQueueItem): string[] {
  return [
    `asset version ${item.assetVersionId}`,
    `  scene: #${item.sceneNumber} ${item.sceneTitle} (version ${item.sceneVersionNumber})`,
    `  job: ${item.jobId} [${item.jobStatus}]  provider: ${item.provider}`,
    `  file: ${item.storagePath}`,
    `  qc: ${item.qcStatus ?? "not recorded"}${item.failedChecks.length ? `  failed checks: ${item.failedChecks.join(", ")}` : ""}`,
    `  review: ${item.reviewStatus}${item.reviewer ? ` by ${item.reviewer}` : ""}${item.comment ? `  comment: ${item.comment}` : ""}${item.reason ? `  reason: ${item.reason}` : ""}`,
    `  selected: ${item.selected ? "yes" : "no"}`,
    `  decide with: flowforge review approve --asset-version-id ${item.assetVersionId}`,
  ];
}

export function printTopLevelHelp(): number {
  const groups = new Map<string, CommandDefinition[]>();
  for (const [path, definition] of Object.entries(COMMANDS)) {
    const group = path.includes(" ") ? path.split(" ")[0]! : "workflow";
    const list = groups.get(group) ?? [];
    list.push(definition);
    groups.set(group, list);
  }
  console.log(
    [
      "FlowForge operator CLI",
      "",
      "Usage:",
      "  flowforge <group> <action> [flags]",
      "  flowforge vertical-slice [flags]     (Phase 1 engine demonstration)",
      "",
      ...[...groups.entries()].flatMap(([group, definitions]) => [
        `${group}:`,
        ...definitions.map((definition) => `  ${definition.usage.padEnd(105)} ${definition.summary}`),
        "",
      ]),
      "Global flags:",
      "  --data-dir PATH            Directory holding flowforge.sqlite and the asset store (default .flowforge)",
      "  --provider ID              mock (default, deterministic) or google-flow (manual browser session)",
      "  --mode / --artifact        Mock provider behaviour for this invocation",
      "  --cdp-endpoint URL         Browser gateway endpoint for --provider google-flow",
      "  --lease-ms/--retry-delay-ms/--max-attempts  Worker and request tuning",
      "  --json                     Machine-readable output built from the same read models",
      "",
      "Exit codes: 0 ok, 1 error, 2 usage error, 3 durable state legitimately blocks the command.",
      "Flow: project create → scene create → scene version add → generate → queue run → review approve → review select → production ready.",
    ].join("\n"),
  );
  return EXIT_OK;
}

function printCommandHelp(path: string): number {
  const definition = COMMANDS[path];
  if (!definition) return printTopLevelHelp();
  console.log(`${definition.summary}\n\nUsage:\n  flowforge ${definition.usage}`);
  return EXIT_OK;
}
