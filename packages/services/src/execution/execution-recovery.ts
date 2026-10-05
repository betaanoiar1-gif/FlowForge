import type {
  GenerationJob,
  PlanExecutionRecord,
  PlanVersionSnapshot,
  QueueItemRecord,
  SceneRecord,
  SceneVersionRecord,
} from "@flowforge/core";
import type { ExecutionBlocker } from "@flowforge/core";
import type { PlanExecutionState, PlanExecutionUnitState } from "./execution-types.js";
import type { JobRepository } from "../ports.js";

/**
 * Durable state of one materialization (Phase 5), read-only.
 *
 * This is the file an operator uses to answer "where did my planned work get to, and is it safe to run this
 * again?" — after a restart, after a crash, or in the middle of a lease. It composes existing reads
 * (`scene_versions` links, jobs, queue items, attempts, asset versions, QC, review, selection) into one view.
 *
 * It owns no recovery. That is deliberate and it is the whole point of Phase 5: lease expiry, expired-lease
 * recovery, retry classification, and attempt history already exist in `SqliteJobRepository` and
 * `LocalQueueWorker`, they are provider-neutral, and they are tested. A second implementation of any of that
 * here would be a second execution engine wearing a read model. So this module *reports* state and names the
 * existing command that changes it, and writes nothing.
 */

export interface ExecutionStateDeps {
  repository: JobRepository;
}

/**
 * Reads the durable side of one execution. `units` come from the snapshot (scene order is the plan's order,
 * and the same ordering the materialization used), so a unit with no job yet still appears — a materialization
 * that was interrupted must never look like a plan that asked for nothing.
 */
export function describeExecutionState(
  deps: ExecutionStateDeps,
  execution: PlanExecutionRecord,
  snapshot: PlanVersionSnapshot,
  unitLinks: readonly { sceneKey: string; sceneNumber: number; specId: string; kind: string; sceneId: string; sceneVersionId: string; dependsOn: readonly string[] }[],
): PlanExecutionState {
  const sceneVersions = deps.repository.listSceneVersionsByPlanExecution(execution.id);
  const versionById = new Map(sceneVersions.map((version) => [version.id, version]));
  const blockers: ExecutionBlocker[] = [];

  // Any scene version this execution created that has no job is an interrupted materialization. Inside the
  // real path that cannot happen (one transaction), but a database written by hand, or a future phase that
  // splits the steps, must be visible rather than assumed away.
  for (const version of sceneVersions) {
    const jobs = deps.repository.listGenerationJobs({ sceneVersionId: version.id });
    if (jobs.length === 0) {
      blockers.push({
        code: "EXECUTION_UNIT_WITHOUT_WORK",
        detail: `Scene version ${version.id} exists with no generation job, so this execution is incomplete.`,
        subject: version.id,
      });
    }
  }

  const units: PlanExecutionUnitState[] = [];
  const totals = {
    units: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    qcPassed: 0,
    qcFailed: 0,
    approved: 0,
    selected: 0,
  };

  for (const link of unitLinks) {
    const scene = deps.repository.getScene(link.sceneId);
    const sceneVersion = versionById.get(link.sceneVersionId) ?? null;
    const jobs = sceneVersion ? deps.repository.listGenerationJobs({ sceneVersionId: sceneVersion.id }) : [];
    // Deterministic pick: the newest job for this exact scene version by creation time then id. Reuse means
    // there is one; if there are several, an operator must see the most recent rather than a Map order.
    const job = newestJob(jobs);
    totals.units += 1;
    if (!sceneVersion) {
      blockers.push({
        code: "EXECUTION_UNIT_MISSING",
        detail: `Scene version ${link.sceneVersionId} for ${link.sceneKey}/${link.specId} is not linked to this execution.`,
        subject: link.sceneVersionId,
      });
    }
    if (!job) {
      units.push({
        sceneKey: link.sceneKey,
        sceneNumber: link.sceneNumber,
        specId: link.specId,
        kind: link.kind,
        sceneId: link.sceneId,
        sceneStatus: scene?.status ?? "MISSING",
        sceneVersionId: link.sceneVersionId,
        sceneVersionNumber: sceneVersion?.versionNumber ?? 0,
        isCurrentSceneVersion: scene?.currentVersionId === link.sceneVersionId,
        jobId: "",
        jobStatus: sceneVersion ? "NOT_ENQUEUED" : "MISSING",
        provider: execution.providerId,
        attemptCount: 0,
        maxAttempts: 0,
        attempts: [],
        selected: false,
        dependsOn: [...link.dependsOn],
      });
      continue;
    }
    const row = readUnitState(deps.repository, scene, sceneVersion, link, job);
    totals[jobStatusTally(job.status)] += 1;
    if (row.qcStatus === "PASSED") totals.qcPassed += 1;
    if (row.qcStatus === "FAILED") totals.qcFailed += 1;
    if (row.reviewStatus === "APPROVED") totals.approved += 1;
    if (row.selected) totals.selected += 1;
    units.push(row);
  }

  return {
    planId: execution.planId,
    planVersionId: execution.planVersionId,
    versionNumber: snapshot.version.versionNumber,
    executionId: execution.id,
    executionFingerprint: execution.executionFingerprint,
    rulesVersion: execution.rulesVersion,
    mappingScope: execution.mappingScope,
    providerId: execution.providerId,
    materializedAt: execution.createdAt,
    blockers: blockers.sort((left, right) =>
      left.code === right.code ? left.detail.localeCompare(right.detail) : left.code.localeCompare(right.code),
    ),
    units,
    totals,
    hints: recoveryHints(totals, units, execution),
  };
}

/** One unit's durable picture, assembled from the reads the services already have. */
function readUnitState(
  repository: JobRepository,
  scene: SceneRecord | null,
  sceneVersion: SceneVersionRecord | null,
  link: {
    sceneKey: string;
    sceneNumber: number;
    specId: string;
    kind: string;
    sceneId: string;
    sceneVersionId: string;
    dependsOn: readonly string[];
  },
  job: GenerationJob,
): PlanExecutionUnitState {
  const queueItem: QueueItemRecord | null = repository.getQueueItemByJob(job.id);
  const attempts = repository.listGenerationAttempts(job.id).map((attempt) => ({
    number: attempt.attemptNumber,
    status: attempt.status,
    errorClass: attempt.errorClass ?? undefined,
  }));
  const assetVersions = sceneVersion ? repository.listAssetVersionsForSceneVersion(sceneVersion.id) : [];
  const assetVersion = assetVersions.length > 0 ? assetVersions[assetVersions.length - 1] : null;
  const qc = assetVersion ? repository.getQCResult(assetVersion.id) : null;
  const review = assetVersion ? repository.getReviewByAssetVersion(assetVersion.id) : null;
  return {
    sceneKey: link.sceneKey,
    sceneNumber: link.sceneNumber,
    specId: link.specId,
    kind: link.kind,
    sceneId: link.sceneId,
    sceneStatus: scene?.status ?? "MISSING",
    sceneVersionId: link.sceneVersionId,
    sceneVersionNumber: sceneVersion?.versionNumber ?? 0,
    isCurrentSceneVersion: scene !== null && scene.currentVersionId === (sceneVersion?.id ?? ""),
    jobId: job.id,
    jobStatus: job.status,
    provider: job.request.provider,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    attempts,
    queueItemId: queueItem?.id,
    queueStatus: queueItem?.status,
    leaseUntil: queueItem?.leaseUntil ?? undefined,
    workerId: queueItem?.workerId ?? undefined,
    assetVersionId: assetVersion?.id,
    qcStatus: qc?.status,
    reviewStatus: review?.status,
    selected: scene !== null && assetVersion !== null && scene.selectedAssetVersionId === assetVersion.id,
    dependsOn: [...link.dependsOn],
  };
}

function jobStatusTally(status: GenerationJob["status"]): "queued" | "running" | "succeeded" | "failed" | "cancelled" {
  switch (status) {
    case "QUEUED":
      return "queued";
    case "CLAIMED":
    case "RUNNING":
      return "running";
    case "SUCCEEDED":
      return "succeeded";
    case "CANCELLED":
      return "cancelled";
    default:
      return "failed";
  }
}

function newestJob(jobs: readonly GenerationJob[]): GenerationJob | null {
  if (jobs.length === 0) return null;
  return [...jobs].sort((left, right) =>
    left.createdAt === right.createdAt ? left.id.localeCompare(right.id) : left.createdAt.localeCompare(right.createdAt),
  )[jobs.length - 1];
}

/**
 * What to do next, in the order an operator would do it. Every hint names an existing command; none of them
 * is executed here, and none of them is a new capability.
 */
function recoveryHints(
  totals: PlanExecutionState["totals"],
  units: readonly PlanExecutionUnitState[],
  execution: PlanExecutionRecord,
): string[] {
  const hints: string[] = [];
  const unenqueued = units.filter((unit) => unit.jobStatus === "NOT_ENQUEUED" || unit.jobStatus === "MISSING").length;
  if (unenqueued > 0) {
    hints.push(
      `${unenqueued} unit(s) have no durable work yet. Re-run plan execute: the same fingerprint reuses what exists and fills only what is missing.`,
    );
  }
  if (totals.queued > 0) {
    hints.push(`flowforge queue run --max-jobs ${totals.queued} executes the ${totals.queued} queued item(s) with provider ${execution.providerId}.`);
  }
  const leased = units.filter((unit) => unit.jobStatus === "CLAIMED" || unit.jobStatus === "RUNNING").length;
  if (leased > 0) {
    hints.push(`${leased} unit(s) are claimed or running. If a worker died, flowforge queue recover returns expired leases to the queue; nothing here reclaims or cancels them.`);
  }
  if (totals.failed > 0) {
    hints.push(`flowforge retry --job-id ID re-queues a failed job only where the durable evidence allows it (uncertain submissions are refused).`);
  }
  if (totals.succeeded > 0 && totals.qcFailed > 0) {
    hints.push("Deterministic QC failed on at least one output: selection and readiness stay blocked until an accepted output exists for the current scene version.");
  }
  if (totals.qcPassed > totals.approved) {
    hints.push("Review stays an explicit operator decision: flowforge review approve --asset-version-id ID, then flowforge review select --scene-id ID --asset-version-id ID.");
  }
  if (totals.units > 0 && totals.selected === totals.units) {
    hints.push("Every unit has a selected asset version; flowforge production scene --scene-id ID reports readiness from that evidence.");
  }
  return hints;
}
