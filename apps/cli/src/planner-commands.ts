import { DETERMINISTIC_PLANNER_VERSION, PLANNING_RULES_VERSION } from "@flowforge/core";
import {
  planner,
  type PlanProductionResult,
  type PlannerCastInput,
  type PlannerOptionsInput,
  type PlannerStoryInput,
  type PlannerWorldInput,
} from "@flowforge/services";
import {
  isSet,
  optionalNumber,
  optionalString,
  parseJsonOption,
  requireString,
  UsageError,
  type ParsedArgs,
} from "./args.js";
import { emit, EXIT_BLOCKED, type CommandDefinition } from "./command-context.js";
import type { AiPlanProductionResult, AiPlanningGuidance } from "@flowforge/services";

/**
 * Operator commands for the deterministic planner (Phase 4B).
 *
 * The planner's own surface is two commands: run a planning pass, and read the rule registry it applies.
 * The phase deliberately stops there — `planner run` authors a plan version and validates it, but nothing
 * here creates a scene, a job, or a queue entry. Mapping an approved plan to execution remains an
 * application-service concern (`mapPlanToJobs`), proven by deterministic tests rather than exposed as a
 * CLI path, so no operator can accidentally generate work from a plan they only meant to review.
 */
export const PLANNER_COMMANDS: Record<string, CommandDefinition> = {
  "planner run": {
    usage:
      "planner run --project-id ID [--brief-id ID] [--plan-title TEXT] [--story-json JSON] [--cast-json JSON] [--worlds-json JSON] [--visual-dna-id ID] [--options-json JSON] [--seed N] [--scenes N] [--duration-ms N] [--providers CSV] [--dry-run] [--approve] [--reviewer NAME]",
    summary:
      "Plan a production plan deterministically from the project's brief, then validate what was written.",
    flags: [
      "project-id",
      "brief-id",
      "plan-title",
      "story-json",
      "cast-json",
      "worlds-json",
      "visual-dna-id",
      "options-json",
      "providers",
      "seed",
      "scenes",
      "duration-ms",
      "dry-run",
      "approve",
      "reviewer",
    ],
    execution: false,
    run({ options, globals, app }) {
      const optionsJson = parseJsonOption<Record<string, unknown>>(options, "options-json");
      if (optionsJson !== undefined && (typeof optionsJson !== "object" || Array.isArray(optionsJson))) {
        throw new UsageError(
          "--options-json must be a JSON object.",
          'Example: {"replan":"new-version","aspectRatio":"9:16"}',
        );
      }
      // The flat flags win over the JSON blob, so one knob can be overridden without rewriting them all.
      const seed = optionalNumber(options, "seed");
      const scenes = optionalNumber(options, "scenes");
      const durationMs = optionalNumber(options, "duration-ms");
      const merged: PlannerOptionsInput = {
        ...(optionsJson ?? {}),
        ...(seed === undefined ? {} : { seed }),
        ...(scenes === undefined ? {} : { developmentScenes: scenes }),
        ...(durationMs === undefined ? {} : { totalDurationMs: durationMs }),
      };
      const result = app.planner.plan({
        projectId: requireString(options, "project-id"),
        briefId: optionalString(options, "brief-id"),
        planTitle: optionalString(options, "plan-title"),
        story: parseJsonOption<PlannerStoryInput>(options, "story-json"),
        cast: parseJsonOption<readonly PlannerCastInput[]>(options, "cast-json"),
        worlds: parseJsonOption<readonly PlannerWorldInput[]>(options, "worlds-json"),
        visualDnaId: optionalString(options, "visual-dna-id"),
        options: Object.keys(merged).length > 0 ? merged : undefined,
        providers: csv(options, "providers"),
        dryRun: isSet(options, "dry-run"),
        approve: isSet(options, "approve"),
        reviewer: optionalString(options, "reviewer"),
      });
      emit(globals, result, (value) => renderRun(value));
      if (result.outcome !== "SUCCESS") process.exitCode = EXIT_BLOCKED;
    },
  },
  /**
   * AI-assisted planning (Phase 4C). One verb, planning-only: it asks the configured adapter for a
   * proposal, refuses anything that is not a valid proposal, and hands the accepted one to the same
   * deterministic planner `planner run` uses. It creates no job, enqueues nothing, and there is
   * deliberately no `planner execute` to add one to: execution remains outside this phase.
   */
  "planner ai-run": {
    usage:
      "planner ai-run --project-id ID [--brief-id ID] [--plan-title TEXT] [--ai-adapter openai-chat] [--ai-model NAME] [--ai-base-url URL] [--ai-key-env NAME] [--guidance-json JSON] [--story-json JSON] [--cast-json JSON] [--worlds-json JSON] [--visual-dna-id ID] [--options-json JSON] [--providers CSV] [--seed N] [--scenes N] [--duration-ms N] [--fallback deterministic] [--dry-run] [--trace] [--approve] [--reviewer NAME]",
    summary:
      "Ask the configured AI planner for a proposal, then plan it deterministically and validate it. Planning only: nothing is generated or executed.",
    ai: true,
    flags: [
      "project-id",
      "brief-id",
      "plan-title",
      "ai-adapter",
      "ai-model",
      "ai-base-url",
      "ai-key-env",
      "guidance-json",
      "story-json",
      "cast-json",
      "worlds-json",
      "visual-dna-id",
      "options-json",
      "providers",
      "seed",
      "scenes",
      "duration-ms",
      "fallback",
      "dry-run",
      "trace",
      "approve",
      "reviewer",
    ],
    execution: false,
    async run({ options, globals, app }) {
      const optionsJson = parseJsonOption<Record<string, unknown>>(options, "options-json");
      if (optionsJson !== undefined && (typeof optionsJson !== "object" || Array.isArray(optionsJson))) {
        throw new UsageError(
          "--options-json must be a JSON object.",
          'Example: {"replan":"new-version","aspectRatio":"9:16"}',
        );
      }
      const guidance = parseJsonOption<Record<string, unknown>>(options, "guidance-json");
      if (guidance !== undefined && (typeof guidance !== "object" || Array.isArray(guidance))) {
        throw new UsageError("--guidance-json must be a JSON object.", 'Example: {"sceneCount":4,"notes":"no dialogue"}');
      }
      const fallback = optionalString(options, "fallback");
      if (fallback !== undefined && fallback !== "none" && fallback !== "deterministic") {
        throw new UsageError('--fallback must be "none" or "deterministic".', "AI output is never patched into a plan on its own.");
      }
      const seed = optionalNumber(options, "seed");
      const scenes = optionalNumber(options, "scenes");
      const durationMs = optionalNumber(options, "duration-ms");
      const merged: PlannerOptionsInput = {
        ...(optionsJson ?? {}),
        ...(seed === undefined ? {} : { seed }),
        ...(scenes === undefined ? {} : { developmentScenes: scenes }),
        ...(durationMs === undefined ? {} : { totalDurationMs: durationMs }),
      };
      const result = await app.aiPlanning.plan({
        projectId: requireString(options, "project-id"),
        briefId: optionalString(options, "brief-id"),
        planTitle: optionalString(options, "plan-title"),
        ...(guidance === undefined ? {} : { guidance: guidance as AiPlanningGuidance }),
        story: parseJsonOption<PlannerStoryInput>(options, "story-json"),
        cast: parseJsonOption<PlannerCastInput[]>(options, "cast-json"),
        worlds: parseJsonOption<PlannerWorldInput[]>(options, "worlds-json"),
        visualDnaId: optionalString(options, "visual-dna-id"),
        options: Object.keys(merged).length > 0 ? merged : undefined,
        providers: csv(options, "providers"),
        dryRun: isSet(options, "dry-run"),
        approve: isSet(options, "approve"),
        reviewer: optionalString(options, "reviewer"),
        ...(fallback === undefined ? {} : { fallback: fallback as "none" | "deterministic" }),
      });
      emit(globals, result, (value) => renderAiRun(value, isSet(options, "trace")));
      if (result.outcome !== "SUCCESS") process.exitCode = EXIT_BLOCKED;
    },
  },
  "planner rules": {
    usage: "planner rules",
    summary: "Print the planner version, its rules in execution order, and the defaults each knob uses.",
    flags: [],
    execution: false,
    run({ globals }) {
      const rules = planner.PLANNER_RULES.map((rule, index) => ({
        index: index + 1,
        id: rule.id,
        summary: rule.summary,
        reads: rule.reads,
      }));
      emit(
        globals,
        {
          plannerVersion: DETERMINISTIC_PLANNER_VERSION,
          rulesVersion: PLANNING_RULES_VERSION,
          defaults: planner.PLANNER_DEFAULTS,
          rules,
        },
        () => [
          `planner ${DETERMINISTIC_PLANNER_VERSION}  rules ${PLANNING_RULES_VERSION}`,
          "  guarantees: no LLM, no randomness, no clock, no I/O — ids derive from the input fingerprint",
          ...rules.map(
            (rule) =>
              `  ${String(rule.index).padStart(2, "0")}. ${rule.id} — ${rule.summary}\n      reads: ${rule.reads.join(", ")}`,
          ),
          `  defaults: ${Object.entries(planner.PLANNER_DEFAULTS)
            .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
            .join(", ")}`,
          "  notices: PLANNER_* codes are the planner's own; validator findings keep their Phase 4A codes.",
        ],
      );
    },
  },
};

function renderAiRun(result: AiPlanProductionResult, showTrace: boolean): string[] {
  const lines: string[] = [
    `ai planning  adapter ${result.ai.adapter}@${result.ai.adapterVersion}  ${result.ai.provider}/${result.ai.model}`,
    `  schema ${result.ai.schemaVersion}  path ${result.ai.path}  fallback ${result.ai.fallback ? "yes" : "no"}`,
    `  provenance: ${result.ai.provenanceRecorded ? "recorded with the version" : "not recorded"}${
      result.ai.provenanceReason === undefined ? "" : ` — ${result.ai.provenanceReason}`
    }`,
    `  request ${short(result.ai.requestFingerprint)}  proposal ${short(result.ai.proposalFingerprint ?? "none")}  response ${short(
      result.ai.responseFingerprint ?? "none",
    )}`,
    `  outcome: ${result.outcome}${result.created ? "  (version created)" : ""}${
      result.reused ? "  (unchanged content reused — nothing written)" : ""
    }`,
  ];
  if (result.plan) lines.push(`  plan: ${result.plan.id}  "${result.plan.title}"`);
  if (result.version) {
    lines.push(`  version: v${result.version.versionNumber} ${result.version.status}  id ${result.version.id}`);
  }
  if (result.planner) {
    lines.push(
      `  planner ${result.planner.plannerVersion}  rules ${result.planner.rulesVersion}  seed ${result.planner.seed}`,
      `  input: ${short(result.planner.inputFingerprint)}  output: ${short(result.planner.outputFingerprint ?? "none")}`,
      `  scene plans: ${result.scenePlans}  generation specs: ${result.specs}`,
    );
  }
  if (result.validation) {
    lines.push(
      `  validation: ${result.validation.status}  ${result.validation.errorCount} error(s), ${result.validation.warningCount} warning(s)`,
    );
  }
  for (const issue of result.ai.issues.slice(0, 8)) {
    lines.push(`  schema ${issue.code} [${issue.path}]: ${issue.message}`);
  }
  if (result.ai.issues.length > 8) lines.push(`  schema: and ${String(result.ai.issues.length - 8)} more issue(s)`);
  for (const notice of result.notices) {
    const origin = "rule" in notice ? notice.rule : notice.stage;
    lines.push(`  ${notice.severity} ${notice.code}${origin === undefined ? "" : ` (${origin})`}: ${notice.message}`);
  }
  for (const finding of result.findings.filter((entry) => entry.severity === "ERROR")) {
    lines.push(`  ! ${finding.code} (${finding.subject.kind} ${short(finding.subject.id)}): ${finding.message}`);
  }
  for (const error of result.errors) {
    lines.push(`  ! ${error.code}${error.field === undefined ? "" : ` [${error.field}]`}: ${error.message}`);
  }
  if (showTrace) {
    lines.push(`  trace (${String(result.trace.length)} step(s)):`);
    for (const entry of result.trace) {
      lines.push(
        `    ${(entry.stage ?? "RULE").padEnd(22)} ${entry.outcome.padEnd(7)} ${entry.rule}${
          entry.subjects === undefined || entry.subjects.length === 0 ? "" : `  [${entry.subjects.map(short).join(", ")}]`
        }  ${entry.detail}`,
      );
    }
  } else if (result.trace.length > 0) {
    lines.push(`  trace: ${String(result.trace.length)} step(s) recorded — add --trace to print them`);
  }
  lines.push("  boundary: planning only. No generation job was created, nothing was enqueued, and nothing was executed.");
  lines.push(`  next: ${result.nextAction}`);
  return lines;
}

function renderRun(result: PlanProductionResult): string[] {
  const lines: string[] = [
    `planner ${result.planner.plannerVersion}  rules ${result.planner.rulesVersion}  seed ${result.planner.seed}`,
    `  outcome: ${result.outcome}${result.created ? "  (version created)" : ""}${
      result.reused ? "  (unchanged content reused — nothing written)" : ""
    }`,
  ];
  if (result.plan) lines.push(`  plan: ${result.plan.id}  "${result.plan.title}"`);
  if (result.version) {
    lines.push(`  version: v${result.version.versionNumber} ${result.version.status}  id ${result.version.id}`);
  }
  lines.push(
    `  input: ${short(result.planner.inputFingerprint)}  output: ${short(result.planner.outputFingerprint ?? "none")}`,
    `  provider declarations read: ${result.planner.providerCandidates}`,
    `  scene plans: ${result.scenePlans}  generation specs: ${result.specs}`,
  );
  if (result.rulesApplied.length > 0) {
    lines.push(`  rules applied: ${result.rulesApplied.join(" > ")}`);
  }
  if (result.validation) {
    lines.push(
      `  validation: ${result.validation.status}  ${result.validation.errorCount} error(s), ${result.validation.warningCount} warning(s)`,
    );
  }
  for (const notice of result.notices) {
    lines.push(`  ${notice.severity} ${notice.code} (${notice.rule}): ${notice.message}`);
  }
  for (const finding of result.findings.filter((entry) => entry.severity === "ERROR")) {
    lines.push(`  ! ${finding.code} (${finding.subject.kind} ${short(finding.subject.id)}): ${finding.message}`);
  }
  for (const error of result.errors) {
    lines.push(`  ! ${error.code}${error.field === undefined ? "" : ` [${error.field}]`}: ${error.message}`);
  }
  lines.push(`  next: ${result.nextAction}`);
  return lines;
}

function short(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}

function csv(options: ParsedArgs["options"], name: string): string[] | undefined {
  const value = optionalString(options, name);
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
