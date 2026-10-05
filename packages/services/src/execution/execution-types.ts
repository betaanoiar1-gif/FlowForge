import type { ExecutionBlocker, ExecutionNotice, ExecutionUnitOutcome } from "@flowforge/core";

/**
 * Command and result shapes for Phase 5 plan materialization.
 *
 * Conventions match the Phase 3/4 commands: plain JSON-safe input, explicit ids, an optional `now` for
 * deterministic tests, and a result that is itself the read model the CLI renders (human and `--json`
 * output are projections of the same object).
 */

export interface MaterializePlanCommand {
  planId: string;
  /** Absent means the plan's current version pointer. */
  versionNumber?: number;
  /**
   * Restrict materialization to these provider IDs. Defaults to the providers the version was marked
   * executable for — the same selection rule `markExecutable` used, because work must not silently land in
   * a queue the approved plan was never gated against.
   */
  providers?: readonly string[];
  /** Assess readiness, map every unit, and report — while writing nothing at all. */
  dryRun?: boolean;
  maxAttempts?: number;
  now?: string;
}

export interface PlanExecutionVersionTarget {
  planId: string;
  versionNumber?: number;
  /**
   * Narrow the provider pool for the assessment, exactly as `materialize` does. A read model that ignored it
   * would report a plan as executable against a provider the operator never approved.
   */
  providers?: readonly string[];
  /** Inspect one specific materialization; absent means the most recent for that version. */
  executionId?: string;
}

/** How much durable work a materialization touched, split so "reused" is never mistaken for "created". */
export interface PlanExecutionCounts {
  scenePlans: number;
  generationSpecs: number;
  /** Specs that became an execution unit. */
  units: number;
  scenesCreated: number;
  scenesReused: number;
  sceneVersionsCreated: number;
  sceneVersionsReused: number;
  jobsCreated: number;
  jobsReused: number;
  /** Queue items this call inserted. Zero on every repeat run — that is the duplicate-protection result. */
  queueItemsCreated: number;
}

/** The report `materialize()` returns, and the object `--json` prints. */
export interface PlanExecutionReport {
  planId: string;
  planVersionId: string;
  versionNumber: number;
  /** The plan version's status at materialization time, echoed so a report cannot be read out of context. */
  planVersionStatus: string;
  projectId: string;
  /** `null` on a dry run, because nothing exists to name. */
  executionId: string | null;
  executionFingerprint: string;
  rulesVersion: string;
  /** What the deterministic ids were scoped by (planner output fingerprint, else version content hash). */
  mappingScope: string;
  providerId: string;
  dryRun: boolean;
  /** Whether this call inserted the `plan_executions` row; `false` means the materialization already existed. */
  created: boolean;
  /** When the work was written (`null` on a dry run, which writes nothing). */
  materializedAt: string | null;
  units: ExecutionUnitOutcome[];
  /** Specs the mapping refused to turn into work, each with its reason — never a silently dropped shot. */
  skipped: { specId: string; sceneKey: string; reason: string }[];
  blockers: ExecutionBlocker[];
  notices: ExecutionNotice[];
  counts: PlanExecutionCounts;
  /** What the operator does next, stated as a command rather than implied by a status. */
  nextAction: string;
}

/** One unit of materialized work seen from the durable side: job, queue, attempt, asset, QC, review. */
export interface PlanExecutionUnitState {
  sceneKey: string;
  sceneNumber: number;
  specId: string;
  kind: string;
  sceneId: string;
  sceneStatus: string;
  sceneVersionId: string;
  sceneVersionNumber: number;
  isCurrentSceneVersion: boolean;
  jobId: string;
  jobStatus: string;
  provider: string;
  attemptCount: number;
  maxAttempts: number;
  attempts: Array<{ number: number; status: string; errorClass?: string }>;
  queueItemId?: string;
  queueStatus?: string;
  leaseUntil?: string;
  workerId?: string;
  assetVersionId?: string;
  qcStatus?: string;
  reviewStatus?: string;
  selected: boolean;
  dependsOn: string[];
}

/** Read-only view of one materialization, used for restart and recovery questions. */
export interface PlanExecutionState {
  planId: string;
  planVersionId: string;
  versionNumber: number;
  executionId: string;
  executionFingerprint: string;
  rulesVersion: string;
  mappingScope: string;
  providerId: string;
  materializedAt: string;
  /** Derived, never stored: what the plan version's own state now says about this execution. */
  blockers: ExecutionBlocker[];
  units: PlanExecutionUnitState[];
  totals: {
    units: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    qcPassed: number;
    qcFailed: number;
    approved: number;
    selected: number;
  };
  /** Deterministic guidance for the state above; recovery itself stays with the queue and the worker. */
  hints: string[];
}

export type { ExecutionBlocker, ExecutionNotice, ExecutionUnitOutcome };
