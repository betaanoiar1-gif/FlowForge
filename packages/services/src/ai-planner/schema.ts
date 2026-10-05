import {
  AI_PLANNING_SCHEMA_VERSION,
  AI_PROPOSAL_LIMITS,
  GENERATION_SPEC_KINDS,
  type BriefConstraintKind,
  type GenerationSpecKind,
  type PlanningProposal,
  type PlanningProposalScene,
} from "@flowforge/core";
import { tidyText } from "../planner/normalize.js";
import { BRIEF_CONSTRAINT_KINDS } from "../plan-validation.js";

/**
 * Schema validation for an AI planning proposal (Phase 4C).
 *
 * This is the gate that makes the adapter safe to have: a response is only a proposal if it is a
 * well-formed document of the versioned schema, and anything else is a typed failure. The rules, in
 * the order they are applied to each value:
 *
 * 1. **Strict shape.** Every object is checked against the exact set of fields the schema declares. An
 *    unknown key is an error rather than something to ignore, because a model that invented a field is
 *    telling us it did not understand the contract — and silently dropping the field would make the
 *    resulting plan look like it honoured a request it never carried.
 * 2. **No invention.** A required string that is missing or blank is an issue. The validator never fills
 *    in a premise, a title, or a scene order "helpfully": if the model omitted it, the run fails.
 * 3. **Same limits as the planner.** Text bounds come from the planner's own `tidyText`, so the schema
 *    and the engine cannot drift into disagreeing about what a 200-character title means.
 * 4. **Order preserved exactly.** `scenes` is the proposed order; nothing here sorts it.
 * 5. **Deterministic reporting.** Issues are sorted by path, so the same malformed response always
 *    produces the same report, and the report is small enough to show an operator in full.
 *
 * `maxScenes` bounds the document, not the piece: a longer proposal is refused rather than truncated.
 */

// The bounds themselves live in core (`AI_PROPOSAL_LIMITS`), so this validator and a provider-side wire
// schema are rendered from one table instead of two that can drift apart.
export { AI_PROPOSAL_LIMITS };

export type AiPlanningIssueCode =
  | "SCHEMA_VERSION"
  | "MISSING"
  | "EMPTY"
  | "TYPE"
  | "RANGE"
  | "UNKNOWN_FIELD"
  | "DUPLICATE"
  | "TOO_MANY";

export interface AiPlanningIssue {
  path: string;
  code: AiPlanningIssueCode;
  message: string;
}

export type ProposalValidation =
  | { ok: true; proposal: PlanningProposal }
  | { ok: false; issues: AiPlanningIssue[] };

const SCENE_FIELDS = [
  "key",
  "title",
  "intent",
  "emphasis",
  "characters",
  "world",
  "durationMs",
  "kinds",
  "continuity",
  "constraints",
] as const;
const STORY_FIELDS = ["premise", "structure", "themes", "beginning", "development", "ending"] as const;
const PROPOSAL_FIELDS = ["schemaVersion", "title", "logline", "story", "scenes", "visualDna", "constraints"] as const;
const CONSTRAINT_FIELDS = ["kind", "value"] as const;
const EMPHASIS_VALUES = ["establish", "develop", "resolve"] as const;

class Collector {
  readonly issues: AiPlanningIssue[] = [];

  issue(path: string, code: AiPlanningIssueCode, message: string): void {
    this.issues.push({ path, code, message });
  }

  /** Rejects any key the schema does not declare; the strict half of "fail closed". */
  unknownFields(path: string, value: Record<string, unknown>, allowed: readonly string[]): void {
    for (const key of Object.keys(value).sort()) {
      if (!allowed.includes(key)) {
        this.issue(`${path}.${key}`, "UNKNOWN_FIELD", `${path}.${key} is not part of ${AI_PLANNING_SCHEMA_VERSION}.`);
      }
    }
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }

  sorted(): AiPlanningIssue[] {
    return [...this.issues].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : left.code < right.code ? -1 : left.code > right.code ? 1 : 0,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bounded, trimmed text through the planner's own helper, so the limits have one owner. */
function text(
  collector: Collector,
  path: string,
  value: unknown,
  options: { required: boolean; maxLength: number },
): string | undefined {
  if (value === undefined || value === null) {
    if (options.required) collector.issue(path, "MISSING", `${path} is required.`);
    return undefined;
  }
  if (typeof value !== "string") {
    collector.issue(path, "TYPE", `${path} must be a string.`);
    return undefined;
  }
  try {
    const tidy = tidyText(value, path, options.maxLength);
    if (tidy === undefined && options.required) {
      collector.issue(path, "EMPTY", `${path} must carry text; an empty ${path.split(".").at(-1)} is not a proposal.`);
    }
    return tidy;
  } catch (error) {
    collector.issue(path, "RANGE", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function stringList(
  collector: Collector,
  path: string,
  value: unknown,
  maxLength: number,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    collector.issue(path, "TYPE", `${path} must be an array of strings.`);
    return undefined;
  }
  const out: string[] = [];
  value.forEach((entry, index) => {
    const item = text(collector, `${path}[${index}]`, entry, { required: true, maxLength });
    if (item !== undefined) out.push(item);
  });
  return out;
}

export function validateProposal(raw: unknown): ProposalValidation {
  const collector = new Collector();

  if (!isRecord(raw)) {
    return {
      ok: false,
      issues: [{ path: "$", code: "TYPE", message: "A proposal must be a single JSON object; prose or an array is not a planning result." }],
    };
  }

  collector.unknownFields("$", raw, PROPOSAL_FIELDS);

  if (raw.schemaVersion !== AI_PLANNING_SCHEMA_VERSION) {
    collector.issue(
      "$.schemaVersion",
      "SCHEMA_VERSION",
      `The proposal must declare schemaVersion "${AI_PLANNING_SCHEMA_VERSION}"; ${
        typeof raw.schemaVersion === "string" ? `"${raw.schemaVersion}"` : "nothing verifiable"
      } came back, so it cannot be interpreted.`,
    );
  }

  const title = text(collector, "$.title", raw.title, { required: false, maxLength: AI_PROPOSAL_LIMITS.maxTitle });
  const logline = text(collector, "$.logline", raw.logline, { required: false, maxLength: AI_PROPOSAL_LIMITS.maxText });

  const story = validateStory(collector, raw.story);
  const scenes = validateScenes(collector, raw.scenes);
  const visualDna = text(collector, "$.visualDna", raw.visualDna, { required: false, maxLength: AI_PROPOSAL_LIMITS.maxTitle });
  const constraints = validateConstraints(collector, raw.constraints);

  if (!collector.ok) return { ok: false, issues: collector.sorted() };

  const proposal: PlanningProposal = {
    schemaVersion: AI_PLANNING_SCHEMA_VERSION,
    ...(title === undefined ? {} : { title }),
    ...(logline === undefined ? {} : { logline }),
    story: story!,
    scenes: scenes!,
    ...(visualDna === undefined ? {} : { visualDna }),
    ...(constraints === undefined || constraints.length === 0 ? {} : { constraints }),
  };
  return { ok: true, proposal };
}

function validateStory(collector: Collector, value: unknown): PlanningProposal["story"] | undefined {
  const path = "$.story";
  if (!isRecord(value)) {
    collector.issue(path, "MISSING", "story must be an object with premise, beginning, development, and ending.");
    return undefined;
  }
  collector.unknownFields(path, value, STORY_FIELDS);
  const premise = text(collector, `${path}.premise`, value.premise, {
    required: true,
    maxLength: AI_PROPOSAL_LIMITS.maxText,
  });
  const structure = text(collector, `${path}.structure`, value.structure, {
    required: false,
    maxLength: AI_PROPOSAL_LIMITS.maxText,
  });
  const themes = stringList(collector, `${path}.themes`, value.themes, AI_PROPOSAL_LIMITS.maxText);
  const beginning = text(collector, `${path}.beginning`, value.beginning, {
    required: true,
    maxLength: AI_PROPOSAL_LIMITS.maxText,
  });
  const development = text(collector, `${path}.development`, value.development, {
    required: true,
    maxLength: AI_PROPOSAL_LIMITS.maxText,
  });
  const ending = text(collector, `${path}.ending`, value.ending, {
    required: true,
    maxLength: AI_PROPOSAL_LIMITS.maxText,
  });
  if (
    premise === undefined ||
    beginning === undefined ||
    development === undefined ||
    ending === undefined
  ) {
    return undefined;
  }
  return {
    premise,
    ...(structure === undefined ? {} : { structure }),
    ...(themes === undefined || themes.length === 0 ? {} : { themes }),
    beginning,
    development,
    ending,
  };
}

function validateScenes(collector: Collector, value: unknown): PlanningProposalScene[] | undefined {
  const path = "$.scenes";
  if (value === undefined) {
    collector.issue(path, "MISSING", "scenes is required: a proposal without ordered scenes cannot be planned.");
    return undefined;
  }
  if (!Array.isArray(value)) {
    collector.issue(path, "TYPE", "scenes must be an array of scene objects, in the proposed order.");
    return undefined;
  }
  if (value.length === 0) {
    collector.issue(path, "EMPTY", "scenes is empty, so this proposal contains no plan.");
    return undefined;
  }
  if (value.length > AI_PROPOSAL_LIMITS.maxScenes) {
    collector.issue(
      path,
      "TOO_MANY",
      `scenes has ${value.length} entries; at most ${AI_PROPOSAL_LIMITS.maxScenes} are accepted, and nothing is truncated to fit.`,
    );
    return undefined;
  }

  const scenes: PlanningProposalScene[] = [];
  const keys = new Set<string>();
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(entry)) {
      collector.issue(at, "TYPE", `${at} must be an object describing one scene.`);
      return;
    }
    collector.unknownFields(at, entry, SCENE_FIELDS);
    const title = text(collector, `${at}.title`, entry.title, {
      required: true,
      maxLength: AI_PROPOSAL_LIMITS.maxTitle,
    });
    const intent = text(collector, `${at}.intent`, entry.intent, {
      required: true,
      maxLength: AI_PROPOSAL_LIMITS.maxText,
    });
    const key = text(collector, `${at}.key`, entry.key, {
      required: false,
      maxLength: 80,
    });
    if (key !== undefined) {
      if (keys.has(key)) {
        collector.issue(`${at}.key`, "DUPLICATE", `Two scenes propose the key "${key}"; scene keys must be distinct.`);
      }
      keys.add(key);
    }
    const emphasis = enumValue(collector, `${at}.emphasis`, entry.emphasis, EMPHASIS_VALUES);
    const world = text(collector, `${at}.world`, entry.world, {
      required: false,
      maxLength: AI_PROPOSAL_LIMITS.maxTitle,
    });
    const characters = stringList(collector, `${at}.characters`, entry.characters, AI_PROPOSAL_LIMITS.maxTitle);
    if (characters !== undefined && characters.length > AI_PROPOSAL_LIMITS.maxCharactersPerScene) {
      collector.issue(
        `${at}.characters`,
        "TOO_MANY",
        `A scene may name at most ${AI_PROPOSAL_LIMITS.maxCharactersPerScene} characters; ${characters.length} came back.`,
      );
    }
    const durationMs = wholeNumber(collector, `${at}.durationMs`, entry.durationMs, AI_PROPOSAL_LIMITS.maxDurationMs);
    const kinds = kindsOf(collector, `${at}.kinds`, entry.kinds);
    const continuity = text(collector, `${at}.continuity`, entry.continuity, {
      required: false,
      maxLength: AI_PROPOSAL_LIMITS.maxNote,
    });
    const constraints = stringList(collector, `${at}.constraints`, entry.constraints, AI_PROPOSAL_LIMITS.maxNote);
    if (title === undefined || intent === undefined) return;
    scenes.push({
      ...(key === undefined ? {} : { key }),
      title,
      intent,
      ...(emphasis === undefined ? {} : { emphasis }),
      ...(characters === undefined || characters.length === 0 ? {} : { characters }),
      ...(world === undefined ? {} : { world }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(kinds === undefined || kinds.length === 0 ? {} : { kinds }),
      ...(continuity === undefined ? {} : { continuity }),
      ...(constraints === undefined || constraints.length === 0 ? {} : { constraints }),
    });
  });
  return scenes.length === 0 ? undefined : scenes;
}

function validateConstraints(
  collector: Collector,
  value: unknown,
): PlanningProposal["constraints"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    collector.issue("$.constraints", "TYPE", "constraints must be an array of { kind, value } objects.");
    return undefined;
  }
  const out: NonNullable<PlanningProposal["constraints"]> = [];
  value.forEach((entry, index) => {
    const at = `$.constraints[${index}]`;
    if (!isRecord(entry)) {
      collector.issue(at, "TYPE", `${at} must be an object with kind and value.`);
      return;
    }
    collector.unknownFields(at, entry, CONSTRAINT_FIELDS);
    // The same vocabulary the Phase 4A validator accepts, imported rather than restated here: two lists
    // of constraint kinds would drift, and a proposal the validator could never accept is not a proposal.
    const kind = enumValue(collector, `${at}.kind`, entry.kind, BRIEF_CONSTRAINT_KINDS);
    const constraintValue = text(collector, `${at}.value`, entry.value, {
      required: true,
      maxLength: AI_PROPOSAL_LIMITS.maxNote,
    });
    if (kind === undefined || constraintValue === undefined) return;
    out.push({ kind: kind as BriefConstraintKind, value: constraintValue });
  });
  return out;
}

function enumValue<const T extends readonly string[]>(
  collector: Collector,
  path: string,
  value: unknown,
  allowed: T,
): T[number] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    collector.issue(path, "TYPE", `${path} must be one of ${allowed.join(", ")}.`);
    return undefined;
  }
  return value as T[number];
}

function kindsOf(collector: Collector, path: string, value: unknown): GenerationSpecKind[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    collector.issue(path, "TYPE", `${path} must be an array of ${GENERATION_SPEC_KINDS.join(", ")}.`);
    return undefined;
  }
  const out: GenerationSpecKind[] = [];
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (typeof entry !== "string" || !GENERATION_SPEC_KINDS.includes(entry as GenerationSpecKind)) {
      collector.issue(at, "TYPE", `${at} must be one of ${GENERATION_SPEC_KINDS.join(", ")}.`);
      return;
    }
    out.push(entry as GenerationSpecKind);
  });
  return out;
}

function wholeNumber(collector: Collector, path: string, value: unknown, maximum: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    collector.issue(path, "TYPE", `${path} must be a whole number of milliseconds.`);
    return undefined;
  }
  if (value < 1_000 || value > maximum) {
    collector.issue(path, "RANGE", `${path} must be between 1000 and ${maximum} milliseconds.`);
    return undefined;
  }
  return value;
}
