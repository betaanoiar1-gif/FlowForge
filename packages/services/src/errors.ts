/**
 * Operator-facing error contract for the application layer. Every rejection a service raises
 * on purpose carries a stable machine-readable code plus structured details, so a CLI run,
 * a script, or a future UI can branch on `code` without matching message text.
 *
 * These codes never replace the durable state rules: the repository and queue remain the
 * enforcement point. A service error only means "this command was rejected before it changed
 * anything" or "the state you asked about blocks this command".
 */
export const APPLICATION_ERROR_CODES = Object.freeze({
  /** The command was malformed (missing, empty, or out-of-range field). */
  VALIDATION_FAILED: "VALIDATION_FAILED",
  /** A referenced project, scene, scene version, job, or asset version does not exist. */
  NOT_FOUND: "NOT_FOUND",
  /** The requested status change is not allowed from the current state. */
  INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION",
  /** The durable idempotency key already stores a different request identity. */
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  /** No provider with that ID is registered in this process. */
  PROVIDER_NOT_CONFIGURED: "PROVIDER_NOT_CONFIGURED",
  /** The request exceeds the selected provider's declared capabilities. */
  PROVIDER_UNSUPPORTED_REQUEST: "PROVIDER_UNSUPPORTED_REQUEST",
  /** Queued work exists for a provider this worker cannot serve; running would fail it. */
  PROVIDER_COVERAGE_INCOMPLETE: "PROVIDER_COVERAGE_INCOMPLETE",
  /** The command needs a durable worker (execution, cancellation with provider cleanup). */
  WORKER_NOT_CONFIGURED: "WORKER_NOT_CONFIGURED",
  /** A live provider session could not be attached (for example no browser on the CDP endpoint). */
  PROVIDER_SESSION_UNAVAILABLE: "PROVIDER_SESSION_UNAVAILABLE",
  /** The scene does not satisfy every derived production-readiness condition. */
  READINESS_NOT_SATISFIED: "READINESS_NOT_SATISFIED",
  /** Work is still queued or running, so the archive command was refused. */
  ACTIVE_WORK_PRESENT: "ACTIVE_WORK_PRESENT",
  /** A review already holds a different final decision. */
  REVIEW_ALREADY_DECIDED: "REVIEW_ALREADY_DECIDED",
  /** No deterministic QC result exists for the asset version yet. */
  QC_NOT_RECORDED: "QC_NOT_RECORDED",
  /** Deterministic QC recorded a failure, which blocks selection and readiness. */
  QC_NOT_PASSED: "QC_NOT_PASSED",
  /** Selection rules (ownership, approval, QC) were not met. */
  SELECTION_NOT_ALLOWED: "SELECTION_NOT_ALLOWED",
  /** The job is not in a state retry accepts. */
  RETRY_NOT_ALLOWED: "RETRY_NOT_ALLOWED",
  /** A prior attempt may already have produced provider-side work; needs a new version. */
  RETRY_BLOCKED_UNSAFE_STATE: "RETRY_BLOCKED_UNSAFE_STATE",
  /** Planning state was requested but this application has no planning repository wired. */
  PLANNING_NOT_CONFIGURED: "PLANNING_NOT_CONFIGURED",
  /** The plan version is frozen (approved, executable, or archived) and cannot be edited in place. */
  PLAN_NOT_EDITABLE: "PLAN_NOT_EDITABLE",
  /** Approval or execution requires current passing validation evidence that does not exist yet. */
  PLAN_VALIDATION_REQUIRED: "PLAN_VALIDATION_REQUIRED",
  /** The plan version has not been approved. */
  PLAN_NOT_APPROVED: "PLAN_NOT_APPROVED",
  /** The plan version is not marked executable, so no work may be derived from it. */
  PLAN_NOT_EXECUTABLE: "PLAN_NOT_EXECUTABLE",
  /** A configured provider cannot satisfy a generation spec's declared capability requirements. */
  PLAN_CAPABILITY_UNMET: "PLAN_CAPABILITY_UNMET",
  /** The repository rejected the write for a reason the operator must see verbatim. */
  PERSISTENCE_REJECTED: "PERSISTENCE_REJECTED",
  /** AI planning was requested, but this application has no AI planner adapter wired. */
  AI_PLANNER_NOT_CONFIGURED: "AI_PLANNER_NOT_CONFIGURED",
  /** A plan version's own state blocks materialization (lifecycle, evidence, ordering, or scene conflict). */
  EXECUTION_NOT_READY: "EXECUTION_NOT_READY",
  /** No selected provider can satisfy a generation spec, so no work may be queued for it (Phase 5). */
  EXECUTION_CAPABILITY_UNAVAILABLE: "EXECUTION_CAPABILITY_UNAVAILABLE",
  /** Durable state disagreed with the materialization pre-pass; the whole run is rolled back. */
  EXECUTION_STATE_INCONSISTENT: "EXECUTION_STATE_INCONSISTENT",
} as const);

export type ApplicationErrorCode = (typeof APPLICATION_ERROR_CODES)[keyof typeof APPLICATION_ERROR_CODES];

export interface ApplicationErrorDetails {
  [key: string]: unknown;
}

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly details: Readonly<ApplicationErrorDetails>;

  constructor(code: ApplicationErrorCode, message: string, details: ApplicationErrorDetails = {}) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): { code: ApplicationErrorCode; message: string; details: Readonly<ApplicationErrorDetails> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/** Serialisable projection of any thrown value, used by the CLI's error output. */
export function describeThrown(error: unknown): {
  code: ApplicationErrorCode | "UNEXPECTED_ERROR";
  message: string;
  details: Readonly<ApplicationErrorDetails>;
} {
  if (error instanceof ApplicationError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "UNEXPECTED_ERROR", message, details: {} };
}

/**
 * Maps the known durable-guard rejections thrown by the repository into typed application
 * errors so an operator sees a code rather than a SQL-flavoured message. Unknown errors
 * propagate untouched: the application layer never swallows a persistence failure it does
 * not understand.
 */
export function translateRepositoryError(error: unknown, fallback: ApplicationErrorCode, details: ApplicationErrorDetails = {}): ApplicationError {
  if (error instanceof ApplicationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const classified: { code: ApplicationErrorCode; match: RegExp }[] = [
    { code: "IDEMPOTENCY_CONFLICT", match: /Idempotency key collision/i },
    { code: "NOT_FOUND", match: /not found/i },
    { code: "INVALID_STATE_TRANSITION", match: /Invalid (generation job|scene|project|plan version)( status)? transition/i },
    { code: "PLAN_NOT_EDITABLE", match: /non-draft plan version|cannot be edited in place|approved plan versions cannot be edited/i },
    { code: "RETRY_NOT_ALLOWED", match: /Only failed jobs can be retried|exhausted its retry limit|Legacy jobs lack/i },
    { code: "RETRY_BLOCKED_UNSAFE_STATE", match: /uncertain or known provider result/i },
    { code: "SELECTION_NOT_ALLOWED", match: /Only an explicitly approved|Only an asset version with passing|invalid scene-version link|does not belong to scene/i },
    { code: "REVIEW_ALREADY_DECIDED", match: /already has a final decision/i },
  ];
  for (const { code, match } of classified) {
    if (match.test(message)) {
      return new ApplicationError(code, message, details);
    }
  }
  return new ApplicationError(fallback, message, details);
}
