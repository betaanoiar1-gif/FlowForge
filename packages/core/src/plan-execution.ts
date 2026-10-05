/**
 * Plan execution contracts (Phase 5).
 *
 * Planning says what a piece needs; execution says what work exists. Phase 5 is the bridge and nothing
 * more: an `EXECUTABLE` plan version is *materialized* into durable execution rows — scenes, scene
 * versions, generation jobs, and their queue items — through the primitives Phases 1 and 3 already own.
 * The types here describe that bridge so both sides can share one vocabulary:
 *
 *   - a **plan execution** row is the record that one specific plan version was materialized once, under
 *     one `executionFingerprint`. It is the idempotency anchor: re-materializing the same fingerprint
 *     reuses it instead of forking a second execution of the same plan.
 *   - a **scene version link** ties an execution-side scene version back to the plan-side scene plan and
 *     generation spec it came from, plus the execution that created it. A `ScenePlan` is a planning
 *     artifact and never becomes a `Scene` implicitly; this link is what records the explicit step.
 *   - a **job link** (`GenerationJob.planExecutionId`) says which materialization submitted the job, and
 *     it deliberately sits *outside* the job's idempotency identity: which plan asked for work is
 *     provenance, not part of what the work is.
 *
 * No provider, queue, browser, or credential concept belongs here. Nothing in this file can execute work:
 * there is no submit, no run, and no retry knob, because the worker and the durable queue already own those.
 */

/** Bumped only when materialization *decisions* change, exactly like `PLANNING_RULES_VERSION`. */
export const EXECUTION_RULES_VERSION = "plan-execution-v1";

/** Namespace of the durable execution fingerprint, kept in one place so digests are self-describing. */
export const EXECUTION_FINGERPRINT_NAMESPACE = "flowforge:execution:v1";

/** Namespace for ids derived from an execution fingerprint — derived identity, never random. */
export const EXECUTION_ID_NAMESPACE = "flowforge:execution-id:v1";

/**
 * A materialization row is written once per (plan version, execution fingerprint) and never amended: the
 * fingerprint is what a later operator compares against, and an editable record could be quietly retargeted
 * at different content. `MATERIALIZED` is the only status today; the field exists so a later phase can add
 * an explicit supersede/cancel transition instead of inventing one in a trigger.
 */
export const PLAN_EXECUTION_STATUSES = Object.freeze(["MATERIALIZED"] as const);

export type PlanExecutionStatus = (typeof PLAN_EXECUTION_STATUSES)[number];

export function isPlanExecutionStatus(value: unknown): value is PlanExecutionStatus {
  return typeof value === "string" && (PLAN_EXECUTION_STATUSES as readonly string[]).includes(value);
}

/** The durable record that a plan version was materialized into execution work. */
export interface PlanExecutionRecord {
  id: string;
  projectId: string;
  planId: string;
  planVersionId: string;
  /** Canonical digest of the execution inputs; see `EXECUTION_FINGERPRINT_NAMESPACE`. */
  executionFingerprint: string;
  rulesVersion: string;
  /** What the deterministic ids were scoped by (the planner output fingerprint, else content hash). */
  mappingScope: string;
  status: PlanExecutionStatus;
  sceneCount: number;
  sceneVersionCount: number;
  jobCount: number;
  /** How many of this run's jobs already existed, i.e. how much work was *not* duplicated. */
  reusedJobCount: number;
  /** Provider this materialization targeted, so an operator can see whose queue the work landed in. */
  providerId: string;
  createdAt: string;
}

/** The plan-side origin of an execution scene version, recorded when Phase 5 creates it. */
export interface SceneVersionPlanLink {
  planExecutionId: string;
  planVersionId: string;
  scenePlanId: string;
  generationSpecId: string;
}

/** How one generation spec's materialization went, reported per unit so nothing is silently skipped. */
export interface ExecutionUnitOutcome {
  scenePlanId: string;
  sceneKey: string;
  sceneNumber: number;
  specId: string;
  specNumber: number;
  kind: string;
  providerId: string;
  sceneId: string;
  /** `REUSED` means the durable row already existed with the same identity — not a failed write. */
  scene: "CREATED" | "REUSED";
  sceneVersionId: string;
  sceneVersion: "CREATED" | "REUSED";
  jobId: string;
  jobKey: string;
  job: "CREATED" | "REUSED";
  jobStatus: string;
  queueItemId?: string;
  queueStatus?: string;
  /** Deterministic queue ordering derived from the plan's own scene order; see `EXECUTION_RULES_VERSION`. */
  priority: number;
  /** Scene-plan keys this unit follows in the plan. Reporting only: the durable queue has no DAG. */
  dependsOn: string[];
}

/** Why a plan version may not be materialized, or what an operator should look at before trying. */
export interface ExecutionBlocker {
  code: string;
  detail: string;
  subject?: string;
}

/** Informational, never blocking: an adapter's identity does not gate execution. */
export interface ExecutionNotice {
  code: string;
  detail: string;
  severity: "INFO" | "WARNING";
}
