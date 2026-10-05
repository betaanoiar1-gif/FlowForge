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
