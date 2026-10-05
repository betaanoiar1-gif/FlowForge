/**
 * Plan materialization (Phase 5), as a module boundary.
 *
 * Everything exported here except `PlanExecutionService` is a pure function over data the caller already has:
 * identity derivation, the mapping, and the readiness assessment. That is deliberate — the same three answers
 * a materialization computes are the answers a dry run, a status read, and a test need, and exposing them
 * without a database keeps them provably identical instead of duplicating them in a read model.
 *
 * The namespace exists so `import { execution } from "@flowforge/services"` reads as the phase boundary it is:
 * `execution.buildExecutionMapping`, `execution.assessExecutionReadiness`, `execution.executionIdentity`.
 *
 * `execution/plan-execution-service.ts` is intentionally NOT re-exported here: the service needs the wired
 * application (its siblings' write methods), and a bare import of it should not suggest otherwise.
 */
export {
  executionIdentity,
  priorityForSceneNumber,
  sceneVersionIdFor,
  type ExecutionIdentity,
  type ExecutionIdentityInput,
  type ExecutionIdentityUnit,
} from "./execution-idempotency.js";
export { buildExecutionMapping, capabilityMapFor, type ExecutionMapping, type ExecutionMappingOptions, type ExecutionUnit } from "./execution-mapping.js";
export {
  assessExecutionReadiness,
  describeBlocker,
  type ExecutionReadiness,
  type ExecutionReadinessContext,
} from "./execution-readiness.js";
export { describeExecutionState, type ExecutionStateDeps } from "./execution-recovery.js";
export type {
  MaterializePlanCommand,
  PlanExecutionCounts,
  PlanExecutionReport,
  PlanExecutionState,
  PlanExecutionUnitState,
  PlanExecutionVersionTarget,
} from "./execution-types.js";
