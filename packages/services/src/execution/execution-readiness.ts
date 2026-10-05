import type { ExecutionBlocker, ExecutionNotice, PlanVersionSnapshot, ProviderCapabilities,
  ProviderCapabilityKey,
} from "@flowforge/core";
import type { ExecutionUnit } from "./execution-mapping.js";

/**
 * Execution readiness (Phase 5): the one gate that decides whether a plan version may become durable work.
 *
 * The gate exists because a plan is *approved content*, not a runnable program, and the state that made it
 * runnable can move underneath it: a validation record goes stale when the version is edited, a provider
 * registration disappears, a scene row is archived, a capability stops being declared. Rather than let those
 * surface as half-written execution state, `assessExecutionReadiness` reads the same facts the executor would
 * act on and returns an ordered, code-tagged blocker list.
 *
 * Two rules make this list trustworthy:
 *
 * 1. **It is pure and shared.** The throwing path (`materialize`) and the read-only path (`status`) call the
 *    same function, so "why is this blocked?" is answered with the same facts that block the write — no
 *    second, softer opinion in the read model.
 * 2. **Only lifecycle and capability block.** Provenance staleness, unbound entity references, AI proposal
 *    metadata, and scene-plan counts beyond the approved ones are reported as *notices*. 4A's validator owns
 *    plan content and the transition table owns executability; a materialization gate that re-litigates
 *    either would be a second authority, and one that can disagree with the approval.
 */

/** Durations are whole milliseconds; the ceiling is a generous operator guard, not a provider limit. */
const MIN_DURATION_MS = 200;
const MAX_DURATION_MS = 600_000;

export interface ExecutionReadinessContext {
  snapshot: PlanVersionSnapshot;
  units: readonly ExecutionUnit[];
  /** Units the mapping refused, each with the preview's reason. */
  skipped: readonly { specId: string; sceneKey: string; reason: string }[];
  /** Capabilities of the providers materialization may use, already narrowed to the selected set. */
  providers: ReadonlyMap<string, ProviderCapabilities>;
  /** Whether a provider is registered in *this process* at all; distinct from "capable". */
  registeredProviderIds: readonly string[];
  /** The version's validation view, or `null` when there is no evidence. */
  validation: { present: boolean; isCurrent: boolean; status: string; errorCount: number } | null;
  /** Execution-side scenes already present, keyed by the id materialization would use. */
  existingScenes: ReadonlyMap<string, { projectId: string; status: string }>;
  /** Whether this call writes or only reports. A dry run still refuses to *lie*: blockers are blockers. */
  dryRun: boolean;
}

export interface ExecutionReadiness {
  ready: boolean;
  blockers: ExecutionBlocker[];
  notices: ExecutionNotice[];
  /** True when every blocker is a capability problem, which the service reports as its own error code. */
  capabilityBlocked: boolean;
}

/**
 * Ordered assessment. Blockers are emitted in a stable order (code, then subject) so the same state always
 * produces the same report, and an operator diffing two runs can tell what changed.
 */
export function assessExecutionReadiness(context: ExecutionReadinessContext): ExecutionReadiness {
  const { snapshot, units, skipped, providers, validation, existingScenes } = context;
  const { version } = snapshot;
  const blockers: ExecutionBlocker[] = [];
  const notices: ExecutionNotice[] = [];
  const block = (code: string, detail: string, subject?: string): void => {
    blockers.push(subject ? { code, detail, subject } : { code, detail });
  };

  if (version.status !== "EXECUTABLE") {
    block(
      version.status === "ARCHIVED" ? "PLAN_ARCHIVED" : "PLAN_NOT_EXECUTABLE",
      version.status === "ARCHIVED"
        ? `Plan version ${version.id} is archived; archived versions never become work.`
        : `Plan version ${version.id} is ${version.status}. Materialization requires EXECUTABLE, which is set by the capability gate.`,
      version.id,
    );
  }

  if (!validation || !validation.present) {
    block("VALIDATION_MISSING", `Plan version ${version.id} has no validation evidence on record.`, version.id);
  } else if (!validation.isCurrent) {
    block(
      "VALIDATION_STALE",
      `Plan version ${version.id} changed after its last validation; revalidate and reapprove before executing.`,
      version.id,
    );
  } else if (validation.status !== "PASSED" || validation.errorCount > 0) {
    block(
      "VALIDATION_FAILED",
      `The current validation report for ${version.id} is ${validation.status} with ${validation.errorCount} error(s).`,
      version.id,
    );
  }

  if (snapshot.specs.length === 0) {
    block("PLAN_HAS_NO_GENERATION_SPECS", `Plan version ${version.id} declares no generation specs.`, version.id);
  }
  // When the version is not EXECUTABLE, every preview item is unacceptable for that one reason, and the
  // mapping consequently skips all of them. Reporting each skip as a separate blocker would bury the cause
  // under per-spec noise and could even dress a lifecycle problem up as a capability one, so the derived
  // blockers are suppressed and the lifecycle blocker stands alone.
  const lifecycleBlocked = version.status !== "EXECUTABLE";

  if (!lifecycleBlocked && units.length === 0 && snapshot.specs.length > 0) {
    block(
      "PLAN_HAS_NO_EXECUTABLE_UNITS",
      `No generation spec of ${version.id} can be executed by the selected providers.`,
      version.id,
    );
  }

  // Scene ordering is the plan's own; a duplicate would mean two units competing for one scene number.
  const bySceneNumber = new Map<number, ExecutionUnit[]>();
  for (const unit of units) {
    const list = bySceneNumber.get(unit.sceneNumber) ?? [];
    list.push(unit);
    bySceneNumber.set(unit.sceneNumber, list);
    if (!Number.isSafeInteger(unit.sceneNumber) || unit.sceneNumber < 1) {
      block("SCENE_ORDER_INVALID", `Scene plan ${unit.sceneKey} has scene number ${String(unit.sceneNumber)}.`, unit.scenePlanId);
    }
    if (!unit.prompt.trim()) {
      block("SCENE_PROMPT_EMPTY", `Spec ${unit.specId} of scene plan ${unit.sceneKey} has no instruction text.`, unit.specId);
    }
    if (unit.durationMs !== undefined) {
      if (!Number.isInteger(unit.durationMs)) {
        block("SCENE_DURATION_INVALID", `Spec ${unit.specId} requests a fractional duration (${String(unit.durationMs)} ms).`, unit.specId);
      } else if (unit.durationMs < MIN_DURATION_MS || unit.durationMs > MAX_DURATION_MS) {
        block(
          "SCENE_DURATION_INVALID",
          `Spec ${unit.specId} requests ${unit.durationMs} ms, outside ${MIN_DURATION_MS}..${MAX_DURATION_MS}.`,
          unit.specId,
        );
      }
    }
    if (unit.outputCount < 1) {
      block("SCENE_OUTPUT_COUNT_INVALID", `Spec ${unit.specId} requests ${unit.outputCount} output(s).`, unit.specId);
    }
  }

  for (const [sceneNumber, group] of bySceneNumber) {
    if (group.length > 1 && new Set(group.map((unit) => unit.sceneKey)).size > 1) {
      block(
        "SCENE_ORDER_CONFLICT",
        `Scene number ${sceneNumber} is claimed by ${group.map((unit) => unit.sceneKey).join(", ")}; one execution scene per scene plan.`,
        group[0].scenePlanId,
      );
    }
  }

  // Capability: the same declaration the 4A gate read, checked again because registrations can change
  // between approval and materialization. `EXECUTION_CAPABILITY_UNAVAILABLE` is the named Phase 5 refusal.
  const registered = new Set(context.registeredProviderIds);
  for (const unit of units) {
    if (!registered.has(unit.providerId)) {
      block(
        "EXECUTION_CAPABILITY_UNAVAILABLE",
        `Provider ${unit.providerId} is not registered in this process, so spec ${unit.specId} cannot be executed here.`,
        unit.specId,
      );
      continue;
    }
    const capabilities = providers.get(unit.providerId);
    if (!capabilities) {
      block(
        "EXECUTION_CAPABILITY_UNAVAILABLE",
        `Provider ${unit.providerId} declared no capabilities for spec ${unit.specId}.`,
        unit.specId,
      );
      continue;
    }
    const unsatisfied = unit.requiredCapabilities.filter((key) => capabilities[key] !== true);
    if (unsatisfied.length > 0) {
      block(
        "EXECUTION_CAPABILITY_UNAVAILABLE",
        `Provider ${unit.providerId} cannot satisfy ${unsatisfied.join(", ")} required by spec ${unit.specId}.`,
        unit.specId,
      );
    }
  }

  // A skipped spec is a capability problem when the *plan's own* requirements cannot be met by anything in
  // the selected set. That is decided by reading the spec's declared requirements against the narrowed
  // registry — never by matching the mapping's prose, so a reason-wording change upstream cannot quietly
  // downgrade an explicit capability refusal into a generic unmapped one.
  const selectable = [...providers.keys()];
  for (const skip of lifecycleBlocked ? [] : skipped) {
    const spec = snapshot.specs.find((item) => item.id === skip.specId);
    const requirements: readonly ProviderCapabilityKey[] = spec?.providerRequirements.capabilities ?? [];
    const satisfiable =
      skip.reason === "NO_CAPABLE_PROVIDER" ||
      (spec !== undefined &&
        selectable.length > 0 &&
        selectable.some((id) => requirements.every((key) => providers.get(id)?.[key] === true)));
    if (!satisfiable) {
      block(
        "EXECUTION_CAPABILITY_UNAVAILABLE",
        `Spec ${skip.specId} of scene plan ${skip.sceneKey} requires ${requirements.join(", ") || "no capabilities"}, ` +
          `and none of ${selectable.length === 0 ? "the selected providers" : selectable.join(", ")} satisfies them.`,
        skip.specId,
      );
    } else if (skip.reason === "NO_CAPABLE_PROVIDER") {
      block(
        "EXECUTION_CAPABILITY_UNAVAILABLE",
        `Spec ${skip.specId} of scene plan ${skip.sceneKey} has no capable provider in the selected set.`,
        skip.specId,
      );
    } else {
      block("EXECUTION_UNIT_UNMAPPED", `Spec ${skip.specId} of ${skip.sceneKey} was not mapped: ${skip.reason}.`, skip.specId);
    }
  }

  for (const unit of units) {
    const existing = existingScenes.get(unit.sceneId);
    if (!existing) continue;
    if (existing.projectId !== snapshot.projectId) {
      block(
        "EXECUTION_SCENE_CONFLICT",
        `Execution scene ${unit.sceneId} already exists in another project; materialization refuses to move it.`,
        unit.sceneId,
      );
    } else if (existing.status === "ARCHIVED") {
      block(
        "EXECUTION_SCENE_ARCHIVED",
        `Execution scene ${unit.sceneId} is archived; unarchive it or revise the plan before materializing.`,
        unit.sceneId,
      );
    }
  }

  if (version.plannerContentHash && version.plannerContentHash !== version.contentHash) {
    notices.push({
      code: "PLANNER_PROVENANCE_STALE",
      detail:
        "The plan version's content changed after the planner recorded it, so its provenance describes an earlier draft. Lifecycle and validation, not provenance, decide executability.",
      severity: "WARNING",
    });
  }
  if (version.ai?.adapter) {
    notices.push({
      code: "AI_PROPOSED_PLAN",
      detail: `Plan content was proposed via ${version.ai.adapter}/${version.ai.model ?? "unknown model"}; the deterministic planner and validator produced and approved what is being executed.`,
      severity: "INFO",
    });
  }
  if (context.dryRun) {
    notices.push({ code: "DRY_RUN", detail: "Nothing was written; a later call may see different state.", severity: "INFO" });
  }

  const ordered = [...blockers].sort((left, right) =>
    left.code === right.code
      ? `${left.subject ?? ""}|${left.detail}`.localeCompare(`${right.subject ?? ""}|${right.detail}`)
      : left.code.localeCompare(right.code),
  );
  // The named Phase 5 refusal is reserved for a version that is otherwise sound but cannot be served by the
  // providers in scope: an unmapped spec and an empty executable set are what a capability miss looks like
  // downstream, so they count as capability blockers *only* alongside an explicit one. A plan with no specs
  // at all, or one that failed lifecycle, is `EXECUTION_NOT_READY` — a different fix is required.
  const capabilityCodes = new Set(["EXECUTION_CAPABILITY_UNAVAILABLE", "EXECUTION_UNIT_UNMAPPED", "PLAN_HAS_NO_EXECUTABLE_UNITS"]);
  const capabilityBlocked =
    ordered.length > 0 &&
    ordered.every((item) => capabilityCodes.has(item.code)) &&
    ordered.some((item) => item.code === "EXECUTION_CAPABILITY_UNAVAILABLE");
  return { ready: ordered.length === 0, blockers: ordered, notices, capabilityBlocked };
}

/** A stable, human-readable summary line for one blocker, shared by the CLI and the read model. */
export function describeBlocker(blocker: ExecutionBlocker): string {
  return `${blocker.code}${blocker.subject ? ` (${blocker.subject})` : ""}: ${blocker.detail}`;
}
