import {
  AI_PLANNING_SCHEMA_VERSION,
  GENERATION_SPEC_KINDS,
  PROVIDER_CAPABILITY_KEYS,
  type AIPlanner,
  type AIPlanningRequest,
  type AIPlanningResponse,
  type GenerationSpecKind,
  type PlanAiProvenance,
  type PlannerTraceStep,
  type ProviderCapabilityKey,
} from "@flowforge/core";
import type { ServiceDeps } from "./deps.js";
import { isoNow } from "./deps.js";
import { ApplicationError } from "./errors.js";
import { requirePlanning } from "./planning.js";
import { identifier } from "./validation.js";
import type { PlanProductionCommand } from "./commands.js";
import { PlannerService, type PlanProductionResult } from "./planner-service.js";
import { aiProposalFingerprint, aiRequestFingerprint, aiResponseFingerprint } from "./ai-planner/fingerprint.js";
import { AI_PLANNING_ERROR_CODES, AI_PLANNING_NOTICE_CODES } from "./ai-planner/codes.js";
import { validateProposal, type AiPlanningIssue } from "./ai-planner/schema.js";
import { translateProposal } from "./ai-planner/translate.js";
import type {
  AiPlanNotice,
  AiPlanProductionCommand,
  AiPlanProductionResult,
  AiPlanningNotice,
} from "./ai-planner/types.js";

/**
 * AI planning orchestration (Phase 4C): the only place a model answer is allowed to reach FlowForge.
 *
 * The service owns the *route*, never the *content*:
 *
 *   read the reviewed context → build the request → call the adapter → validate the proposal against the
 *   versioned schema → translate it into `PlannerInput` → `PlannerService.plan()` → Phase 4A validation,
 *   lifecycle, provenance, and reuse exactly as a deterministic run gets them.
 *
 * What it deliberately cannot do: it holds no repository write, no queue, no provider mutation, no
 * worker, and no browser. `PlannerService` remains the sole author of plan rows and `mapPlanToJobs`
 * remains uncalled by any command, so an AI proposal can produce a *validated plan* and never a *job*.
 *
 * When the adapter fails, refuses, or answers with something that is not a proposal, the run fails
 * closed: nothing is written, no gap is filled in, and the only way a plan still gets authored is the
 * operator asking for it with `fallback: "deterministic"`.
 *
 * The service is `async` because the adapter port is I/O. That is the whole of the asynchrony — the
 * planner it delegates to stays a pure synchronous function over the data it was handed.
 */
export class AiPlannerService {
  /**
   * `planner` is the same instance the facade exposes: the AI service never constructs a second planning
   * path, it hands the planner a command and reports what came back.
   */
  constructor(
    private readonly deps: ServiceDeps,
    private readonly planner: PlannerService,
  ) {}

  async plan(input: AiPlanProductionCommand): Promise<AiPlanProductionResult> {
    const planning = requirePlanning(this.deps);
    const projectId = identifier(input.projectId, "projectId");
    if (!this.deps.repository.getProject(projectId)) {
      throw new ApplicationError("NOT_FOUND", `Project not found: ${projectId}`, { projectId });
    }
    if (input.fallback !== undefined && input.fallback !== "none" && input.fallback !== "deterministic") {
      throw new ApplicationError("VALIDATION_FAILED", 'fallback must be "none" or "deterministic".', {
        field: "fallback",
      });
    }
    const brief =
      input.briefId === undefined
        ? planning.currentBrief(projectId)
        : planning.getBrief(identifier(input.briefId, "briefId"));
    if (!brief) {
      throw new ApplicationError(
        "NOT_FOUND",
        input.briefId === undefined
          ? `Project ${projectId} has no creative brief; AI planning needs an active brief to propose against.`
          : `Creative brief not found: ${String(input.briefId)}`,
        { projectId, briefId: input.briefId ?? null },
      );
    }
    if (brief.status !== "ACTIVE") {
      throw new ApplicationError(
        "VALIDATION_FAILED",
        `Creative brief ${brief.id} is ${brief.status}; propose against the project's active brief.`,
        { briefId: brief.id, status: brief.status },
      );
    }

    const context: RunContext = {
      projectId,
      briefId: brief.id,
      characters: planning.listProjectCharacters(projectId),
      worlds: planning.listWorlds(projectId),
      visualDna: planning.listVisualDna(projectId),
      now: isoNow(this.deps, input.now),
    };
    const envelope = envelopeOf(this.candidates(input.providers));
    const { availableKinds, availableCapabilities } = envelope;

    // `includeTrace` is Phase 4B's switch and it governs the AI stages too: an operator who asked not to
    // record a trace does not get one rebuilt from adapter steps. A run that wrote nothing still reports
    // what it did, because there is no persisted trace there to duplicate.
    const recordTrace = input.options?.includeTrace !== false;
    const adapter = this.deps.aiPlanner;
    if (adapter === undefined) {
      throw new ApplicationError(
        "AI_PLANNER_NOT_CONFIGURED",
        "AI planning needs an AI planner adapter in this process. Configure one (the OpenAI-compatible adapter ships with FlowForge) or plan without an AI using `flowforge planner run`; nothing was written.",
        { projectId },
      );
    }

    const request: AIPlanningRequest = {
      schemaVersion: AI_PLANNING_SCHEMA_VERSION,
      brief: {
        title: brief.title,
        concept: brief.concept,
        objective: brief.objective,
        audience: brief.audience,
        tone: brief.tone,
        style: brief.style,
        constraints: brief.constraints,
      },
      characters: context.characters.map((character) => ({
        name: character.name,
        ...(textOf(character.traits?.role) === undefined ? {} : { role: textOf(character.traits?.role) }),
        ...(textOf(character.traits?.appearance) === undefined
          ? {}
          : { appearance: textOf(character.traits?.appearance) }),
      })),
      worlds: context.worlds.map((world) => ({
        name: world.name,
        ...(textOf(world.environment) === undefined ? {} : { environment: textOf(world.environment) }),
      })),
      visualDna: context.visualDna.map((entry) => ({
        name: entry.name,
        ...(textOf(entry.style) === undefined ? {} : { style: textOf(entry.style) }),
      })),
      availableKinds,
      availableCapabilities,
      ...(input.guidance === undefined ? {} : { guidance: input.guidance }),
    };
    const requestFingerprint = aiRequestFingerprint(request);
    const requestStep = step("AI_REQUEST", "ai-request", "APPLIED", [requestFingerprint], `adapter ${adapter.id} (${adapter.provider}/${adapter.model}) asked under ${AI_PLANNING_SCHEMA_VERSION}: ${String(request.characters.length)} character(s), ${String(request.worlds.length)} world(s), ${String(request.visualDna.length)} DNA snapshot(s), kinds ${availableKinds.join(",") || "none declared"}`);

    let response: AIPlanningResponse;
    try {
      response = await adapter.propose(request);
    } catch (error) {
      response = { status: "FAILED", code: "AI_FAILED", message: sanitize(error), retryable: false };
    }
    const responseStep =
      response.status === "FAILED"
        ? step("AI_RESPONSE", "ai-response", "SKIPPED", [], `${response.code}: ${response.message}`)
        : step(
            "AI_RESPONSE",
            "ai-response",
            "APPLIED",
            [aiResponseFingerprint(response.proposal) ?? "unanswered"],
            `answered${response.meta?.model === undefined ? "" : ` as ${response.meta.model}`}${
              response.meta?.finishReason === undefined ? "" : `, finishReason ${response.meta.finishReason}`
            }${response.meta?.truncated === true ? ", truncated" : ""}`,
          );

    if (response.status === "FAILED") {
      return this.refuse(context, input, adapter, requestFingerprint, [requestStep, responseStep], envelope, {
        errors: [{ code: response.code, message: response.message }],
        notices: [
          aiNotice(response.code, "ERROR", "AI_RESPONSE", response.message, undefined, {
            retryable: response.retryable === true ? "yes" : "no",
          }),
        ],
        issues: [],
        responseFingerprint: null,
        proposalFingerprint: null,
      });
    }

    const responseFingerprint = aiResponseFingerprint(response.proposal);
    const validated = validateProposal(response.proposal);
    if (!validated.ok) {
      return this.refuse(context, input, adapter, requestFingerprint, [
        requestStep,
        responseStep,
        step(
          "AI_SCHEMA_VALIDATION",
          "ai-schema-validation",
          "SKIPPED",
          [],
          `${String(validated.issues.length)} schema issue(s): ${summariseIssues(validated.issues)}`,
        ),
      ], envelope, {
        errors: [{ code: AI_PLANNING_ERROR_CODES.AI_PROPOSAL_INVALID, message: summariseIssues(validated.issues) }],
        notices: [
          aiNotice("AI_PROPOSAL_INVALID", "ERROR", "AI_SCHEMA_VALIDATION", summariseIssues(validated.issues), undefined, {
            issues: String(validated.issues.length),
          }),
        ],
        issues: validated.issues,
        responseFingerprint,
        // A rejected document still gets a digest: "the model answered *this* and we refused it" is the
        // audit fact an operator needs, and it is not a proposal the domain accepted.
        proposalFingerprint: aiProposalFingerprint(response.proposal),
      });
    }

    const schemaStep = step(
      "AI_SCHEMA_VALIDATION",
      "ai-schema-validation",
      "APPLIED",
      [],
      `proposal accepted under ${AI_PLANNING_SCHEMA_VERSION}: ${String(validated.proposal.scenes.length)} scene(s)`,
    );

    const translated = translateProposal(validated.proposal, {
      brief,
      characters: context.characters,
      worlds: context.worlds,
      visualDna: context.visualDna,
      options: input.options,
    });
    if (!translated.ok) {
      return this.refuse(context, input, adapter, requestFingerprint, [
        requestStep,
        responseStep,
        schemaStep,
        step(
          "NORMALIZATION",
          "normalization",
          "SKIPPED",
          [],
          `proposal references refused: ${translated.errors.map((error) => error.code).join(", ")}`,
        ),
      ], envelope, {
        errors: translated.errors.map((error) => ({ code: error.code, message: error.message, field: error.field })),
        notices: translated.errors.map((error) =>
          aiNotice(error.code, "ERROR", "NORMALIZATION", error.message, error.field),
        ),
        issues: [],
        responseFingerprint,
        proposalFingerprint: aiProposalFingerprint(validated.proposal),
      });
    }

    const normalizationStep = step(
      "NORMALIZATION",
      "normalization",
      "APPLIED",
      [],
      `${String(validated.proposal.scenes.length)} proposed scene(s) became ${String(translated.input.story.beats?.length ?? 0)} explicit beat(s); names resolved to ids, operator options kept`,
    );

    const aiSteps: PlannerTraceStep[] = [requestStep, responseStep, schemaStep, normalizationStep];

    const ai: PlanAiProvenance = {
      adapter: adapter.id,
      adapterVersion: adapter.adapterVersion,
      provider: adapter.provider,
      model: adapter.model,
      schemaVersion: adapter.schemaVersion,
      path: "ai-adapter",
      requestFingerprint,
      proposalFingerprint: aiProposalFingerprint(validated.proposal),
      responseFingerprint,
      fallback: false,
    };

    const result = this.planner.plan({
      projectId,
      briefId: brief.id,
      planTitle: input.planTitle,
      story: translated.input.story,
      cast: translated.input.cast,
      worlds: translated.input.worlds,
      visualDnaId: input.visualDnaId ?? translated.input.visualDnaId,
      options: translated.input.options,
      providers: input.providers,
      dryRun: input.dryRun,
      approve: input.approve,
      reviewer: input.reviewer,
      now: input.now,
      ai,
      aiTrace: recordTrace ? aiSteps : [],
    });

    return compose(result, {
      ai,
      adapter,
      fallback: false,
      dryRun: input.dryRun === true,
      proposalFingerprint: ai.proposalFingerprint,
      requestFingerprint,
      responseFingerprint,
      issues: [],
      availableKinds,
      availableCapabilities,
      aiTrace: recordTrace ? aiSteps : [],
      recordTrace,
      notices: [
        aiNotice(
          AI_PLANNING_NOTICE_CODES.PROPOSAL_ACCEPTED,
          "INFO",
          "AI_SCHEMA_VALIDATION",
          `The adapter's proposal was accepted under ${AI_PLANNING_SCHEMA_VERSION} (${String(validated.proposal.scenes.length)} scene(s)) and planned by the deterministic rules.`,
        ),
      ],
    });
  }

  /**
   * The fail-closed half. Nothing is written and nothing is patched in; the only way a plan still gets
   * authored is the operator's explicit deterministic fallback, which carries the *attempt* in its
   * provenance — including the digest of what was refused — so an audited plan never hides that an AI
   * route was tried first.
   */
  private async refuse(
    context: RunContext,
    input: AiPlanProductionCommand,
    adapter: AIPlanner,
    requestFingerprint: string,
    trace: readonly PlannerTraceStep[],
    envelope: { availableKinds: readonly GenerationSpecKind[]; availableCapabilities: readonly ProviderCapabilityKey[] },
    failure: {
      errors: { code: string; message: string; field?: string }[];
      notices: AiPlanningNotice[];
      issues: readonly AiPlanningIssue[];
      responseFingerprint: string | null;
      proposalFingerprint: string | null;
    },
  ): Promise<AiPlanProductionResult> {
    const codes = failure.errors.map((error) => error.code).sort();
    if (input.fallback !== "deterministic") {
      return {
        outcome: "AI_FAILURE",
        ai: {
          adapter: adapter.id,
          adapterVersion: adapter.adapterVersion,
          provider: adapter.provider,
          model: adapter.model,
          schemaVersion: adapter.schemaVersion,
          path: "ai-adapter",
          fallback: false,
          requestFingerprint,
          proposalFingerprint: failure.proposalFingerprint,
          responseFingerprint: failure.responseFingerprint,
          provenanceRecorded: false,
          provenanceReason: "Nothing was written: the run never reached the deterministic planner.",
          issues: failure.issues,
        },
        plan: null,
        version: null,
        created: false,
        reused: false,
        validation: null,
        notices: [
          ...failure.notices,
          aiNotice(
            AI_PLANNING_ERROR_CODES.AI_FALLBACK_NOT_REQUESTED,
            "INFO",
            "AI_REQUEST",
            'No plan was authored. Correct the inputs and re-run, or re-run with fallback "deterministic" to plan your own story; an adapter answer is never patched into a plan.',
            "fallback",
          ),
        ],
        findings: [],
        trace,
        rulesApplied: [],
        errors: failure.errors,
        scenePlans: 0,
        specs: 0,
        planner: null,
        availableKinds: envelope.availableKinds,
        availableCapabilities: envelope.availableCapabilities,
        nextAction: "Nothing was written: the AI proposal could not be used. Read the errors, then plan again.",
      };
    }

    const ai: PlanAiProvenance = {
      adapter: adapter.id,
      adapterVersion: adapter.adapterVersion,
      provider: adapter.provider,
      model: adapter.model,
      schemaVersion: adapter.schemaVersion,
      path: "deterministic-fallback",
      requestFingerprint,
      // A fallback run has no accepted proposal. What it has is the refusal, and the digest is over that:
      // an equivalent refusal re-plans identically, a different one does not.
      proposalFingerprint:
        failure.proposalFingerprint ?? aiProposalFingerprint({ refused: true, codes }),
      responseFingerprint: failure.responseFingerprint,
      fallback: true,
    };
    const recordTrace = input.options?.includeTrace !== false;
    const fallbackTrace: PlannerTraceStep[] = [
      ...trace,
      step(
        "DETERMINISTIC_PLANNING",
        "deterministic-fallback",
        "APPLIED",
        [ai.proposalFingerprint],
        `the deterministic planner ran on the operator's own input because the adapter produced nothing usable (${codes.join(", ") || AI_PLANNING_ERROR_CODES.AI_PROPOSAL_EMPTY})`,
      ),
    ];
    const result = this.planner.plan({
      projectId: context.projectId,
      briefId: context.briefId,
      planTitle: input.planTitle,
      story: input.story,
      cast: input.cast,
      worlds: input.worlds,
      visualDnaId: input.visualDnaId,
      options: input.options,
      providers: input.providers,
      dryRun: input.dryRun,
      approve: input.approve,
      reviewer: input.reviewer,
      now: input.now,
      ai,
      aiTrace: recordTrace ? fallbackTrace : [],
    });
    return compose(result, {
      ai,
      adapter,
      fallback: true,
      dryRun: input.dryRun === true,
      proposalFingerprint: ai.proposalFingerprint,
      requestFingerprint,
      responseFingerprint: ai.responseFingerprint,
      issues: failure.issues,
      availableKinds: envelope.availableKinds,
      availableCapabilities: envelope.availableCapabilities,
      recordTrace,
      aiTrace: recordTrace ? fallbackTrace : [],
      notices: [
        ...failure.notices,
        aiNotice(
          AI_PLANNING_NOTICE_CODES.FALLBACK_USED,
          "WARNING",
          "DETERMINISTIC_PLANNING",
          `The adapter produced no usable proposal (${codes.join(", ") || "unknown"}), so this run was planned deterministically because the command asked for that fallback.`,
          "fallback",
        ),
      ],
    });
  }

  /**
   * The capability envelope, from the same provider declarations the planner adapts to. Nothing is
   * assumed: an empty selection asks for every configured provider, and *no* provider at all is reported
   * as "nothing declared", which the planner defers to the executability gate exactly as in Phase 4B.
   */
  private candidates(selected: readonly string[] | undefined) {
    const registry = this.deps.providers;
    if (selected === undefined || selected.length === 0) return [...registry.values()];
    return selected.map((id) => {
      const descriptor = registry.get(id);
      if (!descriptor) {
        throw new ApplicationError("PROVIDER_NOT_CONFIGURED", `Provider not configured: ${id}`, { provider: id });
      }
      return descriptor;
    });
  }
}

interface RunContext {
  projectId: string;
  briefId: string;
  characters: ReturnType<NonNullable<ServiceDeps["planning"]>["listProjectCharacters"]>;
  worlds: ReturnType<NonNullable<ServiceDeps["planning"]>["listWorlds"]>;
  visualDna: ReturnType<NonNullable<ServiceDeps["planning"]>["listVisualDna"]>;
  now: string;
}

function envelopeOf(candidates: readonly { capabilities: Record<ProviderCapabilityKey, boolean> }[]) {
  const declared = new Set<ProviderCapabilityKey>();
  for (const candidate of candidates) {
    for (const key of PROVIDER_CAPABILITY_KEYS) {
      if (candidate.capabilities[key]) declared.add(key);
    }
  }
  const unrestricted = candidates.length === 0;
  const kindCapable = (kind: GenerationSpecKind): boolean =>
    unrestricted || (kind === "video" ? declared.has("videoGeneration") : declared.has("imageGeneration"));
  return {
    availableKinds: GENERATION_SPEC_KINDS.filter(kindCapable),
    availableCapabilities: PROVIDER_CAPABILITY_KEYS.filter((key) => unrestricted || declared.has(key)),
  };
}

interface AiRun {
  ai: PlanAiProvenance;
  adapter: AIPlanner;
  fallback: boolean;
  dryRun: boolean;
  requestFingerprint: string;
  proposalFingerprint: string | null;
  responseFingerprint: string | null;
  issues: readonly AiPlanningIssue[];
  notices: readonly AiPlanNotice[];
  aiTrace: readonly PlannerTraceStep[];
  recordTrace: boolean;
  availableKinds: readonly GenerationSpecKind[];
  availableCapabilities: readonly ProviderCapabilityKey[];
}

/**
 * The planner's result, with the AI audit wrapped around it. Note what does *not* change: `outcome`,
 * `created`, `reused`, `version`, `validation`, and the fingerprints all come from the planner and the
 * repository — an AI route reports the same facts a deterministic one would.
 */
function compose(result: PlanProductionResult, run: AiRun): AiPlanProductionResult {
  const recorded = result.created && !run.dryRun;
  const provenanceReason = run.dryRun
    ? "A dry run writes nothing, including provenance."
    : result.reused
      ? "The version already holds this content, so it kept the authorship record it was created with."
      : result.outcome === "SUCCESS"
        ? undefined
        : "Nothing was written, so there is no version to attribute.";
  return {
    outcome: result.outcome,
    ai: {
      adapter: run.ai.adapter,
      adapterVersion: run.ai.adapterVersion,
      provider: run.ai.provider,
      model: run.ai.model,
      schemaVersion: run.ai.schemaVersion,
      path: run.ai.path,
      fallback: run.fallback,
      requestFingerprint: run.requestFingerprint,
      proposalFingerprint: run.proposalFingerprint,
      responseFingerprint: run.responseFingerprint,
      provenanceRecorded: recorded,
      ...(provenanceReason === undefined ? {} : { provenanceReason }),
      issues: run.issues,
    },
    plan: result.plan,
    version: result.version,
    created: result.created,
    reused: result.reused,
    validation: result.validation,
    notices: [...run.notices, ...result.notices],
    findings: result.findings,
    // The persisted trace, in order: the AI stages, the rules that ran, and the stored validation verdict.
    trace: run.recordTrace ? [...run.aiTrace, ...result.trace, ...domainValidationSteps(result)] : [],
    rulesApplied: result.rulesApplied,
    errors: result.errors,
    scenePlans: result.scenePlans,
    specs: result.specs,
    planner: result.planner,
    availableKinds: run.availableKinds,
    availableCapabilities: run.availableCapabilities,
    nextAction:
      result.outcome !== "SUCCESS"
        ? result.nextAction
        : recorded
          ? run.fallback
            ? "The version records a deterministic fallback; review whether you want to plan from a proposal instead."
            : `Planned from an AI proposal by ${run.adapter.id}; the version records the adapter, model, and fingerprints.`
          : result.reused
            ? "The plan version already holds exactly this content, so no write was made."
            : result.nextAction,
  };
}

/** The stored verdict as its own step: what validation said about the rows, not what the draft claimed. */
function domainValidationSteps(result: PlanProductionResult): PlannerTraceStep[] {
  const version = result.version;
  if (version === null) return [];
  const status = result.validation?.status ?? "NOT_RECORDED";
  return [
    step(
      "DOMAIN_VALIDATION",
      "domain-validation",
      status === "PASSED" ? "APPLIED" : "SKIPPED",
      [version.id],
      `stored version ${String(version.versionNumber)} validates as ${status}${
        result.validation === null
          ? ""
          : ` (${String(result.validation.errorCount)} error(s), ${String(result.validation.warningCount)} warning(s))`
      }`,
    ),
  ];
}

function step(
  stage: PlannerTraceStep["stage"],
  rule: string,
  outcome: PlannerTraceStep["outcome"],
  subjects: readonly string[],
  detail: string,
): PlannerTraceStep {
  return {
    rule,
    outcome,
    ...(stage === undefined ? {} : { stage }),
    ...(subjects.length === 0 ? {} : { subjects: [...subjects] }),
    detail,
  };
}

function aiNotice(
  code: string,
  severity: AiPlanningNotice["severity"],
  stage: string,
  message: string,
  field?: string,
  details: Record<string, string> = {},
): AiPlanningNotice {
  const suffix = Object.entries(details)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  return {
    code,
    severity,
    stage,
    message: suffix.length === 0 ? message : `${message} (${suffix})`,
    ...(field === undefined || field.length === 0 ? {} : { field }),
  };
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Turns a thrown adapter error into something safe to persist and print: one short line, with the shapes
 * a credential can hide in removed (authorization fragments, URL authorities, long opaque tokens). An
 * adapter's message is never stored verbatim, because providers echo request details back at them.
 */
function sanitize(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  const redacted = collapsed
    .replace(/(authorization|bearer|api[-_ ]?key|token|secret|password)[\s=:]*\S*/giu, "[redacted]")
    .replace(/https?:\/\/\S+/giu, "[url-redacted]")
    .replace(/[A-Za-z0-9_-]{28,}/gu, "[redacted]");
  const trimmed = redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted;
  return trimmed.length === 0 ? "The AI planner adapter failed without a message." : trimmed;
}

function summariseIssues(issues: readonly AiPlanningIssue[]): string {
  if (issues.length === 0) return "the response proposed nothing";
  const head = issues.slice(0, 5).map((issue) => `${issue.path}: ${issue.message}`).join(" | ");
  return issues.length > 5 ? `${head} | and ${String(issues.length - 5)} more` : head;
}
