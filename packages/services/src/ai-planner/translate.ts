import type {
  CreativeBrief,
  PlanningCharacterRecord,
  PlanningProposal,
  VisualDnaDefinition,
  WorldDefinition,
} from "@flowforge/core";
import { slugify } from "../planner/deterministic-ids.js";
import type { PlannerCastInput, PlannerOptionsInput, PlannerStoryInput, PlannerWorldInput, StoryBeatInput } from "../planner/types.js";
import { AI_PLANNING_ERROR_CODES, type AiPlanningErrorCode } from "./codes.js";

/**
 * Proposal → deterministic planner input (Phase 4C).
 *
 * This is the only translation an AI answer ever gets, and it is deliberately narrow: it turns the
 * proposal's *intent* into the fields `PlannerInput` already accepts, and it resolves names against the
 * project's definitions. It does not build scene plans, ids, durations, specs, capabilities, references,
 * continuity records, or fingerprints — those belong to the Phase 4B rules, which is why a model can
 * propose a plan and still not produce one.
 *
 * Rules, and why each one is shaped this way:
 *
 * 1. **Names, never ids.** A proposal says "Aya" and "Rooftops". Resolution is exact after trimming,
 *    case-insensitive, and an id is accepted only when it is the project's real id. Unknown or ambiguous
 *    names are typed failures: the alternative — dropping the reference or picking the first match —
 *    would let a model plan a character the project does not have.
 * 2. **Nothing is invented.** Required fields missing from the proposal were already rejected by the
 *    schema validator; this step never supplies a premise, a title, a duration, or a world.
 * 3. **Explicit beats.** The proposal's scene list becomes the planner's *explicit* beats, so scene count
 *    and order are the proposal's, while duration allocation, key allocation, and spec composition stay
 *    the rules' decisions. Beat keys are deduplicated with the planner's own suffix policy, so two scenes
 *    sharing a title cannot blur a cast or world claim.
 * 4. **Duration intent is per scene, never for the piece.** A stated scene duration is honoured the way
 *    an operator's explicit beat duration is; the total budget stays the operator's option.
 * 5. **Brief constraints are the only constraints.** A proposal may echo brief constraints (and the
 *    echo is checked), but it may not add one. FlowForge's creative rules come from the operator.
 * 6. **Stable plan identity.** The plan title comes from the command, not the model: an adapter that
 *    words a title differently each run must fork a *version*, not spawn a parallel plan.
 */

export interface AiPlanningError {
  code: AiPlanningErrorCode;
  message: string;
  field?: string;
}

export interface TranslatedProposal {
  story: PlannerStoryInput;
  cast: PlannerCastInput[];
  worlds: PlannerWorldInput[];
  visualDnaId?: string;
  options: PlannerOptionsInput;
}

export type TranslationResult = { ok: true; input: TranslatedProposal } | { ok: false; errors: AiPlanningError[] };

export interface TranslationContext {
  brief: CreativeBrief;
  characters: readonly PlanningCharacterRecord[];
  worlds: readonly WorldDefinition[];
  visualDna: readonly VisualDnaDefinition[];
  /** The operator's own options for this run; they win over anything the proposal implies. */
  options?: PlannerOptionsInput;
}

export function translateProposal(proposal: PlanningProposal, context: TranslationContext): TranslationResult {
  const errors: AiPlanningError[] = [];

  const characters = new Map<string, PlanningCharacterRecord>();
  const characterAmbiguity = new Map<string, string[]>();
  for (const character of context.characters) {
    register(characters, characterAmbiguity, character.id, character);
    register(characters, characterAmbiguity, character.name, character);
  }
  const worlds = new Map<string, WorldDefinition>();
  const worldAmbiguity = new Map<string, string[]>();
  for (const world of context.worlds) {
    register(worlds, worldAmbiguity, world.id, world);
    register(worlds, worldAmbiguity, world.name, world);
  }
  const dna = new Map<string, VisualDnaDefinition>();
  const dnaAmbiguity = new Map<string, string[]>();
  for (const entry of context.visualDna) {
    register(dna, dnaAmbiguity, entry.id, entry);
    register(dna, dnaAmbiguity, entry.name, entry);
  }

  const resolve = <T>(
    label: string,
    index: Map<string, T>,
    ambiguous: Map<string, string[]>,
    kind: string,
    field: string,
    code: AiPlanningErrorCode,
  ): T | undefined => {
    const key = label.trim().toLowerCase();
    if (ambiguous.has(key)) {
      errors.push({
        code: "AI_PROPOSAL_INVALID",
        message: `"${label}" matches more than one ${kind} of this project (${ambiguous.get(key)!.join(", ")}); name the ${kind} unambiguously.`,
        field,
      });
      return undefined;
    }
    const found = index.get(key);
    if (found === undefined) {
      errors.push({
        code,
        message: `The proposal names "${label}" as a ${kind}, which this project does not have. Create the ${kind} or correct the proposal; nothing is invented to fill it in.`,
        field,
      });
    }
    return found;
  };

  // Beat keys first, deduplicated the way the planner deduplicates scene keys, so a cast or world claim
  // can name exactly one beat.
  const keys: string[] = [];
  const taken = new Set<string>();
  proposal.scenes.forEach((scene, index) => {
    const base = slugify(scene.key ?? scene.title, `ai-scene-${index + 1}`);
    let candidate = base;
    for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${base}-${suffix}`;
    taken.add(candidate);
    keys.push(candidate);
  });

  const beats: StoryBeatInput[] = [];
  const castRoles = new Map<string, string>();
  const worldClaims = new Map<string, string[]>();

  proposal.scenes.forEach((scene, index) => {
    const at = `scenes[${index}]`;
    const characterIds: string[] = [];
    for (const [position, label] of (scene.characters ?? []).entries()) {
      const found = resolve(
        label,
        characters,
        characterAmbiguity,
        "character",
        `${at}.characters[${position}]`,
        "AI_PROPOSAL_UNKNOWN_CHARACTER",
      );
      if (found) {
        characterIds.push(found.id);
        const role = roleOf(found);
        if (role !== undefined && !castRoles.has(found.id)) castRoles.set(found.id, role);
      }
    }

    let worldId: string | undefined;
    if (scene.world !== undefined) {
      const found = resolve(scene.world, worlds, worldAmbiguity, "world", `${at}.world`, "AI_PROPOSAL_UNKNOWN_WORLD");
      if (found) {
        worldId = found.id;
        worldClaims.set(found.id, [...(worldClaims.get(found.id) ?? []), keys[index]!]);
      }
    }

    checkConstraints((scene.constraints ?? []).map((value, position) => ({ value, field: `${at}.constraints[${position}]` })));

    beats.push({
      key: keys[index],
      title: scene.title,
      purpose: scene.intent,
      ...(scene.emphasis === undefined ? {} : { emphasis: scene.emphasis }),
      ...(characterIds.length === 0 ? {} : { characters: characterIds }),
      ...(worldId === undefined ? {} : { worldId }),
      ...(scene.durationMs === undefined ? {} : { durationMs: scene.durationMs }),
      ...(scene.kinds === undefined || scene.kinds.length === 0 ? {} : { outputKinds: scene.kinds }),
      ...(scene.continuity === undefined ? {} : { continuityNote: scene.continuity }),
    });
  });

  function checkConstraints(entries: Array<{ value: string; field: string }>): void {
    if (entries.length === 0) return;
    const allowed = new Set(context.brief.constraints.map((constraint) => `${constraint.kind}: ${constraint.value}`));
    const rawValues = new Set(context.brief.constraints.map((constraint) => constraint.value));
    for (const entry of entries) {
      const value = entry.value.trim();
      if (allowed.has(value) || rawValues.has(value)) continue;
      errors.push({
        code: "AI_PROPOSAL_CONSTRAINT_UNKNOWN",
        message: `"${value}" is not a constraint of the brief. The brief is the only source of creative rules, so an invented constraint is refused rather than planned.`,
        field: entry.field,
      });
    }
  }

  // The proposal may echo brief constraints so an operator can see which ones the model worked from; the
  // echo is checked exactly once, because an invented one is a refusal and must not be reported per scene.
  checkConstraints(
    (proposal.constraints ?? []).map((entry, position) => ({
      value: `${entry.kind}: ${entry.value}`,
      field: `constraints[${position}]`,
    })),
  );

  let visualDnaId: string | undefined;
  if (proposal.visualDna !== undefined) {
    const found = resolve(
      proposal.visualDna,
      dna,
      dnaAmbiguity,
      "visual DNA definition",
      "visualDna",
      "AI_PROPOSAL_UNKNOWN_VISUAL_DNA",
    );
    if (found) visualDnaId = found.id;
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors: [...errors].sort((left, right) =>
        left.code < right.code ? -1 : left.code > right.code ? 1 : (left.field ?? "") < (right.field ?? "") ? -1 : 1,
      ),
    };
  }

  // Every project character is declared so the planner's cast rotation has the same pool it would have
  // for a hand-authored run; the beats above keep the proposal's explicit assignments, which win.
  const cast: PlannerCastInput[] = context.characters.map((character) => {
    const role = castRoles.get(character.id) ?? roleOf(character);
    return { characterId: character.id, ...(role === undefined ? {} : { role }) };
  });

  const givenWorlds: PlannerWorldInput[] = context.worlds.map((world) => {
    const claimed = worldClaims.get(world.id);
    return { worldId: world.id, ...(claimed === undefined || claimed.length === 0 ? {} : { scenes: claimed }) };
  });

  // The operator's options pass through untouched. Deliberately absent: even when every scene declares a
  // duration, the piece's total budget is not summed from a model answer — that number is a creative
  // budget the brief and the operator own, and an AI-set total would let the route decide how long the
  // piece is. A scene's own stated duration still stands, honoured exactly as an operator's would be.
  const options: PlannerOptionsInput = { ...(context.options ?? {}) };

  return {
    ok: true,
    input: {
      story: {
        premise: proposal.story.premise,
        ...(proposal.story.structure === undefined ? {} : { structure: proposal.story.structure }),
        themes: proposal.story.themes ?? [],
        beginning: proposal.story.beginning,
        development: proposal.story.development,
        ending: proposal.story.ending,
        beats,
      },
      cast,
      worlds: givenWorlds,
      ...(visualDnaId === undefined ? {} : { visualDnaId }),
      options,
    },
  };
}

function roleOf(character: PlanningCharacterRecord): string | undefined {
  const role = character.traits?.role?.trim();
  return role === undefined || role.length === 0 ? undefined : role;
}

function register<T>(index: Map<string, T>, ambiguity: Map<string, string[]>, label: string, value: T): void {
  const key = label.trim().toLowerCase();
  if (key.length === 0) return;
  const existing = index.get(key);
  if (existing !== undefined && existing !== value) {
    const names = new Set([labelOf(existing), labelOf(value)]);
    ambiguity.set(key, [...names].sort());
    return;
  }
  index.set(key, value);
}

function labelOf(value: unknown): string {
  if (typeof value === "object" && value !== null && "id" in value) return String((value as { id: unknown }).id);
  return String(value);
}

/** The failure codes this translation can report. Adapter-level codes live in core's `AIPlannerErrorCode`. */
export { AI_PLANNING_ERROR_CODES };
