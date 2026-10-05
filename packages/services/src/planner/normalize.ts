import {
  PLANNING_RULES_VERSION,
  DETERMINISTIC_PLANNER_VERSION,
  GENERATION_SPEC_KINDS,
  isGenerationSpecKind,
  isProviderCapabilityKey,
  PROVIDER_CAPABILITY_KEYS,
  type BriefConstraintKind,
  type GenerationSpecKind,
  type ProviderCapabilityKey,
} from "@flowforge/core";
import { plannerFingerprint } from "./deterministic-ids.js";
import {
  PLANNER_DEFAULTS,
  PLANNER_INPUT_FINGERPRINT_NAMESPACE,
  type PlannerInput,
  type PlannerOptionsInput,
  type PlannerProviderCandidate,
  type StoryBeatEmphasis,
} from "./types.js";

/**
 * Canonical normalization of planner input, run before any rule and before both fingerprints.
 *
 * Rules, in order, and why each is safe:
 *
 * 1. **Text**: leading/trailing whitespace is removed and internal whitespace runs (including newlines
 *    and tabs) collapse to single spaces. This is insignificant to meaning; nothing else about the
 *    prose is touched — no case folding, no punctuation edits, no paraphrase.
 * 2. **Empty optionals**: an empty or whitespace-only string becomes absent, so `""`, `"   "`, and
 *    omitting the field are the same input.
 * 3. **Identifiers**: trimmed only. Ids are opaque, so they are never case-folded or reformatted.
 * 4. **Ordering**: order that carries meaning (beat order, cast order, theme order, constraint order)
 *    is preserved exactly. Order that does not (capability keys, provider candidates, duplicate
 *    references) is sorted or deduplicated, keeping the first occurrence.
 * 5. **Numbers**: durations are floored to whole milliseconds and must be safe integers; counts must be
 *    positive integers. A value that cannot be represented is an input error, never a silent clamp.
 * 6. **Defaults**: option defaults are applied *before* fingerprinting, so an omitted option and an
 *    explicit default are the same plan, and the fingerprint describes the effective input.
 * 7. **Capability vocabulary**: capability keys are validated against `ProviderCapabilities` and
 *    reduced to the keys a candidate actually declares; unknown keys are an input error.
 * 8. **Irrelevance removal**: only fields a rule can read survive into the normalized form (a world's
 *    `rules`, for example, is not plan input for the planner and is dropped), which keeps the
 *    fingerprint about what actually affects the plan.
 */

export class PlannerInputError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "PlannerInputError";
  }
}

export interface NormalizedBeat {
  key: string;
  /** Whether the operator gave this beat explicitly; derived beats are generated, not authored. */
  explicit: boolean;
  title: string;
  purpose: string;
  emphasis: StoryBeatEmphasis;
  characters: readonly string[];
  worldId?: string;
  durationMs?: number;
  outputKinds: readonly GenerationSpecKind[];
  /** Caller-stated continuity intent, carried verbatim (tidied) into the continuity rule. */
  continuityNote?: string;
}

export interface NormalizedOptions {
  /** Only an operator-stated title; the plan-title fallback is a rule decision. */
  planTitle?: string;
  /** The operator-stated budget, if any; when absent the engine budgets scenes x default duration. */
  totalDurationMs?: number;
  minSceneDurationMs: number;
  maxTotalDurationMs: number;
  developmentScenes: number;
  aspectRatio: string;
  outputCountPerSpec: number;
  defaultOutputKinds: readonly GenerationSpecKind[];
  seed: number;
  replan: "new-version" | "in-place" | "fail";
  includeTrace: boolean;
}

export interface NormalizedPlannerInput {
  plannerVersion: string;
  rulesVersion: string;
  projectId: string;
  brief: {
    id: string;
    title: string;
    concept: string;
    objective: string;
    audience: string;
    tone: string;
    style: string;
    constraints: readonly { kind: BriefConstraintKind; value: string }[];
  };
  story: {
    premise: string;
    structure: string;
    themes: readonly string[];
    beginning: string;
    development: string;
    ending: string;
  };
  /** Beats the operator wrote out. Empty means the story-foundation rule derives them from the prose. */
  explicitBeats: readonly NormalizedBeat[];
  cast: readonly { characterId: string; role: string; scenes: readonly string[] }[];
  worlds: readonly { worldId: string; name: string; environment: string; scenes: readonly string[] }[];
  visualDnaId?: string;
  /** Every visual DNA snapshot of the project, sorted by id; the binding rule picks the one to use. */
  dna: readonly {
    id: string;
    name: string;
    style: string;
    palette: readonly string[];
    lighting: string;
    composition: string;
    cameraLanguage: string;
    renderingStyle: string;
    atmosphere: string;
  }[];
  characters: readonly { id: string; name: string; hasTraits: boolean; hasVisualIdentity: boolean }[];
  providers: readonly { id: string; declares: readonly ProviderCapabilityKey[] }[];
  options: NormalizedOptions;
  asOf: string;
}

/** Collapse whitespace without touching the words themselves. */
export function tidyText(value: unknown, field: string, maxLength = 4_000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new PlannerInputError(`${field} must be a string.`, field);
  }
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return undefined;
  if (collapsed.length > maxLength) {
    throw new PlannerInputError(`${field} must be at most ${maxLength} characters.`, field);
  }
  return collapsed;
}

function requireText(value: unknown, field: string, maxLength?: number): string {
  const text = tidyText(value, field, maxLength);
  if (text === undefined) throw new PlannerInputError(`${field} is required.`, field);
  return text;
}

function positiveInteger(value: unknown, field: string, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlannerInputError(`${field} must be an integer number of milliseconds or items.`, field);
  }
  if (value < 1 || value > max) {
    throw new PlannerInputError(`${field} must be between 1 and ${max}.`, field);
  }
  return value;
}

/** Floor to whole milliseconds: a fractional duration is never silently rounded up. */
function durationMs(value: unknown, field: string, max = 3_600_000): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PlannerInputError(`${field} must be a finite number of milliseconds.`, field);
  }
  const floored = Math.floor(value);
  if (floored < 1) throw new PlannerInputError(`${field} must be at least 1 millisecond.`, field);
  if (floored > max) {
    throw new PlannerInputError(`${field} must not exceed ${max} milliseconds.`, field);
  }
  return floored;
}

function identifierList(value: unknown, field: string, max = 64): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PlannerInputError(`${field} must be an array.`, field);
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    const id = requireText(entry, `${field}[${index}]`, 200);
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > max) throw new PlannerInputError(`${field} must not exceed ${max} entries.`, field);
  return out;
}

function textList(value: unknown, field: string, max = 64): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PlannerInputError(`${field} must be an array.`, field);
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    const text = requireText(entry, `${field}[${index}]`, 500);
    if (!out.includes(text)) out.push(text);
  }
  if (out.length > max) throw new PlannerInputError(`${field} must not exceed ${max} entries.`, field);
  return out;
}

function specKinds(value: unknown, field: string, fallback: readonly GenerationSpecKind[]): GenerationSpecKind[] {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value) || value.length === 0) {
    throw new PlannerInputError(`${field} must be a non-empty array of generation spec kinds.`, field);
  }
  const out: GenerationSpecKind[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isGenerationSpecKind(entry)) {
      throw new PlannerInputError(
        `${field}[${index}] must be one of ${GENERATION_SPEC_KINDS.join(", ")}.`,
        `${field}[${index}]`,
      );
    }
    // audio/text specs need no provider capability and are therefore never *invented* by the planner.
    if (entry !== "image" && entry !== "video") {
      throw new PlannerInputError(
        `${field}[${index}] must be image or video; the planner only authors generatable media, got "${entry}".`,
        `${field}[${index}]`,
      );
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

function capabilityDeclares(candidate: PlannerProviderCandidate, index: number): ProviderCapabilityKey[] {
  const capabilities = candidate?.capabilities;
  if (typeof capabilities !== "object" || capabilities === null) {
    throw new PlannerInputError(
      `providerCandidates[${index}].capabilities must be a ProviderCapabilities record.`,
      `providerCandidates[${index}].capabilities`,
    );
  }
  const declared = PROVIDER_CAPABILITY_KEYS.filter((key) => capabilities[key] === true);
  for (const key of Object.keys(capabilities)) {
    if (!isProviderCapabilityKey(key)) {
      throw new PlannerInputError(
        `providerCandidates[${index}].capabilities contains unknown key "${key}".`,
        `providerCandidates[${index}].capabilities`,
      );
    }
  }
  return declared;
}

const EMPHASIS: readonly StoryBeatEmphasis[] = ["establish", "develop", "resolve"];

function emphasisOf(value: unknown, field: string, fallback: StoryBeatEmphasis): StoryBeatEmphasis {
  const text = tidyText(value, field, 24)?.toLowerCase();
  if (text === undefined) return fallback;
  if (!EMPHASIS.includes(text as StoryBeatEmphasis)) {
    throw new PlannerInputError(`${field} must be establish, develop, or resolve.`, field);
  }
  return text as StoryBeatEmphasis;
}

/** Derive the movement beats a plan is built from when the operator supplied none. */
export function deriveBeats(story: {
  premise: string;
  beginning: string;
  development: string;
  ending: string;
  themes: readonly string[];
  options: NormalizedOptions;
}): NormalizedBeat[] {
  const { developmentScenes, defaultOutputKinds } = story.options;
  const beats: NormalizedBeat[] = [];
  const push = (
    emphasis: StoryBeatEmphasis,
    label: string,
    prose: string,
    ordinal: number,
  ): void => {
    beats.push({
      key: `${emphasis}-${ordinal}`,
      explicit: false,
      title: prose.length > 0 ? firstSentence(prose) : `${emphasis} ${label}`,
      purpose: prose.length > 0 ? prose : story.premise,
      emphasis,
      characters: [],
      outputKinds: [...defaultOutputKinds],
    });
  };
  push("establish", "opening", story.beginning, 1);
  // The development prose is *partitioned*, sentence by sentence, so two scenes never repeat the same
  // line and no sentence is dropped: `slice(i)` cuts at exact index boundaries of the sentence list.
  const sentences = splitSentences(story.development);
  for (let index = 1; index <= developmentScenes; index += 1) {
    const from = Math.floor(((index - 1) * sentences.length) / developmentScenes);
    const to = Math.floor((index * sentences.length) / developmentScenes);
    const prose = sentences.slice(from, to).join(" ");
    const theme = story.themes.length > 0 ? story.themes[(index - 1) % story.themes.length] : undefined;
    beats.push({
      key: `develop-${index}`,
      explicit: false,
      title: prose.length > 0 ? firstSentence(prose) : `development ${index}`,
      // A slice with no sentences of its own still carries the story it belongs to, and its theme.
      purpose: `${prose.length > 0 ? prose : story.premise}${theme === undefined ? "" : ` (theme: ${theme})`}`,
      emphasis: "develop",
      characters: [],
      outputKinds: [...defaultOutputKinds],
    });
  }
  push("resolve", "closing", story.ending, 1);
  // A derived plan must still be a *plan*: renumber the keys so they are stable and unique.
  return beats.map((beat, index) => ({ ...beat, key: `${String(index + 1).padStart(2, "0")}-${beat.key}` }));
}

/** Sentence boundaries, used only to split what the operator wrote; never to rewrite it. */
export function splitSentences(prose: string): string[] {
  if (prose.length === 0) return [];
  return prose
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Quote the first sentence of a passage as a title; long sentences are cut, never reworded. */
export function firstSentence(prose: string): string {
  const sentence = splitSentences(prose)[0] ?? prose;
  return sentence.length > 72 ? `${sentence.slice(0, 71).trimEnd()}…` : sentence;
}

export function normalizePlannerInput(input: PlannerInput): NormalizedPlannerInput {
  if (typeof input !== "object" || input === null) {
    throw new PlannerInputError("Planner input must be an object.", "input");
  }
  const projectId = requireText(input.projectId, "projectId", 200);
  const brief = input.brief;
  if (typeof brief !== "object" || brief === null) {
    throw new PlannerInputError("A creative brief is required to plan a production plan.", "brief");
  }
  if (brief.status !== "ACTIVE") {
    throw new PlannerInputError(
      `The planner authors against the active brief snapshot; brief ${brief.id} is ${brief.status}.`,
      "brief",
    );
  }
  const concept = requireText(brief.concept, "brief.concept");
  const objective = requireText(brief.objective, "brief.objective");
  const constraints: { kind: BriefConstraintKind; value: string }[] = [];
  for (const [index, constraint] of (brief.constraints ?? []).entries()) {
    const kind = constraint?.kind;
    if (kind !== "MUST" && kind !== "MUST_NOT" && kind !== "PREFERENCE") {
      throw new PlannerInputError(
        `brief.constraints[${index}].kind must be MUST, MUST_NOT, or PREFERENCE.`,
        `brief.constraints[${index}].kind`,
      );
    }
    const value = requireText(constraint.value, `brief.constraints[${index}].value`, 500);
    const identity = `${kind}:${value}`;
    if (!constraints.some((entry) => `${entry.kind}:${entry.value}` === identity)) {
      constraints.push({ kind, value });
    }
  }

  const storyInput = input.story ?? {};
  const themes = textList(storyInput.themes, "story.themes");
  const premise = tidyText(storyInput.premise, "story.premise") ?? concept;
  const beginning = tidyText(storyInput.beginning, "story.beginning") ?? "";
  const development = tidyText(storyInput.development, "story.development") ?? "";
  const ending = tidyText(storyInput.ending, "story.ending") ?? "";
  if (premise.length === 0) throw new PlannerInputError("story.premise or brief.concept is required.", "story.premise");

  const options = normalizeOptions(input.options ?? {});

  const characters = new Map<string, NormalizedPlannerInput["characters"][number]>();
  for (const [index, character] of (input.definitions?.characters ?? []).entries()) {
    const id = requireText(character?.id, `definitions.characters[${index}].id`, 200);
    if (characters.has(id)) continue;
    characters.set(id, {
      id,
      name: requireText(character.name, `definitions.characters[${index}].name`, 200),
      // Only presence is part of the plan's identity; the prose of a trait never reaches a spec.
      hasTraits:
        typeof character.traits?.appearance === "string" && character.traits.appearance.trim().length > 0 &&
        typeof character.traits.personality === "string" && character.traits.personality.trim().length > 0,
      hasVisualIdentity:
        typeof character.visualIdentity?.description === "string" &&
        character.visualIdentity.description.trim().length > 0,
    });
  }
  const unknownCharacter = (ids: readonly string[], field: string): void => {
    for (const id of ids) {
      if (!characters.has(id)) {
        throw new PlannerInputError(`${field} references character "${id}", which is not in this project.`, field);
      }
    }
  };

  const cast: { characterId: string; role: string; scenes: string[] }[] = [];
  for (const [index, entry] of (input.cast ?? []).entries()) {
    const characterId = requireText(entry?.characterId, `cast[${index}].characterId`, 200);
    if (cast.some((existing) => existing.characterId === characterId)) continue;
    unknownCharacter([characterId], `cast[${index}].characterId`);
    cast.push({
      characterId,
      role: tidyText(entry.role, `cast[${index}].role`, 120) ?? "",
      scenes: identifierList(entry.scenes, `cast[${index}].scenes`),
    });
  }

  const worlds: { worldId: string; name: string; environment: string; scenes: string[] }[] = [];
  for (const [index, entry] of (input.worlds ?? []).entries()) {
    const worldId = requireText(entry?.worldId, `worlds[${index}].worldId`, 200);
    if (worlds.some((existing) => existing.worldId === worldId)) continue;
    const world = input.definitions?.worlds?.find((candidate) => candidate.id === worldId);
    if (!world) {
      throw new PlannerInputError(`worlds[${index}] references unknown world "${worldId}".`, `worlds[${index}]`);
    }
    worlds.push({
      worldId,
      name: requireText(world.name, `definitions.worlds[${index}].name`, 200),
      // The planner quotes whichever description exists; it never rewrites it.
      environment: tidyText(world.environment, "world.environment") ?? tidyText(world.description, "world.description") ?? "",
      scenes: identifierList(entry.scenes, `worlds[${index}].scenes`),
    });
  }

  const visualDnaId = tidyText(input.visualDnaId, "visualDnaId", 200);
  const dna = (input.definitions?.visualDna ?? []).map((candidate, index) => ({
    id: requireText(candidate?.id, `definitions.visualDna[${index}].id`, 200),
    name: requireText(candidate.name, `definitions.visualDna[${index}].name`, 200),
    style: tidyText(candidate.style, "visualDna.style") ?? "",
    palette: textList(candidate.palette, "visualDna.palette", 32),
    lighting: tidyText(candidate.lighting, "visualDna.lighting") ?? "",
    composition: tidyText(candidate.composition, "visualDna.composition") ?? "",
    cameraLanguage: tidyText(candidate.cameraLanguage, "visualDna.cameraLanguage") ?? "",
    renderingStyle: tidyText(candidate.renderingStyle, "visualDna.renderingStyle") ?? "",
    atmosphere: tidyText(candidate.atmosphere, "visualDna.atmosphere") ?? "",
  }));
  const dnaCandidates = Object.values(dna.reduce<Record<string, (typeof dna)[number]>>((acc, entry) => {
    if (!acc[entry.id]) acc[entry.id] = entry;
    return acc;
  }, {})).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (visualDnaId !== undefined && !dnaCandidates.some((entry) => entry.id === visualDnaId)) {
    throw new PlannerInputError(`visualDnaId "${visualDnaId}" is not a definition of this project.`, "visualDnaId");
  }

  const beats: NormalizedBeat[] = [];
  const explicitBeats = storyInput.beats;
  if (explicitBeats !== undefined && explicitBeats !== null) {
    if (!Array.isArray(explicitBeats) || explicitBeats.length === 0) {
      throw new PlannerInputError("story.beats must be a non-empty array when provided.", "story.beats");
    }
    for (const [index, beat] of explicitBeats.entries()) {
      const title = tidyText(beat?.title, `story.beats[${index}].title`, 200) ?? "";
      const purpose = tidyText(beat.purpose, `story.beats[${index}].purpose`) ?? "";
      if (title.length === 0 && purpose.length === 0) {
        throw new PlannerInputError(
          `story.beats[${index}] needs a title or a purpose; a beat with neither cannot be planned.`,
          `story.beats[${index}]`,
        );
      }
      const key = tidyText(beat.key, `story.beats[${index}].key`, 80) ?? "";
      const charactersInBeat = identifierList(beat.characters, `story.beats[${index}].characters`);
      unknownCharacter(charactersInBeat, `story.beats[${index}].characters`);
      const worldId = tidyText(beat.worldId, `story.beats[${index}].worldId`, 200);
      if (worldId !== undefined && !worlds.some((world) => world.worldId === worldId)) {
        throw new PlannerInputError(
          `story.beats[${index}].worldId "${worldId}" is not one of the worlds given to the planner.`,
          `story.beats[${index}].worldId`,
        );
      }
      beats.push({
        key,
        explicit: true,
        title: title.length > 0 ? title : firstSentence(purpose),
        purpose: purpose.length > 0 ? purpose : title,
        emphasis: emphasisOf(beat.emphasis, `story.beats[${index}].emphasis`, "develop"),
        characters: charactersInBeat,
        worldId,
        durationMs: durationMs(beat.durationMs, `story.beats[${index}].durationMs`),
        outputKinds: specKinds(beat.outputKinds, `story.beats[${index}].outputKinds`, options.defaultOutputKinds),
        continuityNote: tidyText(beat.continuityNote, `story.beats[${index}].continuityNote`, 600),
      });
    }
  }

  // Explicit per-cast/per-world scene lists must name real beats. Only explicit beats carry keys the
  // operator could have written down, so with derived beats this cross-check belongs to the rules
  // instead: they are the ones that know the keys the derivation produced.
  if (beats.length > 0) {
    const beatKeys = beats.map((beat, index) => beatKey(beat, index));
    for (const [index, entry] of cast.entries()) {
      const unknown = entry.scenes.filter((scene) => !beatKeys.includes(scene));
      if (unknown.length > 0) {
        throw new PlannerInputError(
          `cast[${index}].scenes references unknown beat key(s): ${unknown.join(", ")}.`,
          `cast[${index}].scenes`,
        );
      }
    }
    for (const [index, entry] of worlds.entries()) {
      const unknown = entry.scenes.filter((scene) => !beatKeys.includes(scene));
      if (unknown.length > 0) {
        throw new PlannerInputError(
          `worlds[${index}].scenes references unknown beat key(s): ${unknown.join(", ")}.`,
          `worlds[${index}].scenes`,
        );
      }
    }
  }
  for (const [index, entry] of cast.entries()) {
    const scenes = [...entry.scenes].sort();
    cast[index] = { ...entry, scenes };
  }
  for (const [index, entry] of worlds.entries()) {
    const scenes = [...entry.scenes].sort();
    worlds[index] = { ...entry, scenes };
  }

  const providers = (input.providerCandidates ?? [])
    .map((candidate, index) => ({
      id: requireText(candidate?.id, `providerCandidates[${index}].id`, 200),
      declares: capabilityDeclares(candidate, index).sort(),
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  for (const [index, left] of providers.entries()) {
    for (const other of providers.slice(index + 1)) {
      if (other.id === left.id) {
        throw new PlannerInputError(`providerCandidates contains a duplicate id "${left.id}".`, "providerCandidates");
      }
    }
  }

  return {
    plannerVersion: DETERMINISTIC_PLANNER_VERSION,
    rulesVersion: PLANNING_RULES_VERSION,
    projectId,
    brief: {
      id: requireText(brief.id, "brief.id", 200),
      title: requireText(brief.title, "brief.title", 200),
      concept,
      objective,
      audience: tidyText(brief.audience, "brief.audience") ?? "",
      tone: tidyText(brief.tone, "brief.tone") ?? "",
      style: tidyText(brief.style, "brief.style") ?? "",
      constraints,
    },
    story: { premise, structure: tidyText(storyInput.structure, "story.structure") ?? "", themes, beginning, development, ending },
    explicitBeats: beats,
    cast,
    worlds,
    visualDnaId,
    dna: dnaCandidates,
    // Definition sets carry no order meaning, so they are sorted: the fingerprint of the same
    // project state must not depend on the order the rows happened to be created in.
    characters: [...characters.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    providers,
    options,
    asOf: requireText(input.asOf, "asOf", 40),
  };
}

function normalizeOptions(options: PlannerOptionsInput): NormalizedOptions {
  const replan = tidyText(options.replan, "options.replan", 20)?.toLowerCase() ?? PLANNER_DEFAULTS.replan;
  if (replan !== "new-version" && replan !== "in-place" && replan !== "fail") {
    throw new PlannerInputError("options.replan must be new-version, in-place, or fail.", "options.replan");
  }
  const seed = options.seed ?? PLANNER_DEFAULTS.seed;
  if (typeof seed !== "number" || !Number.isSafeInteger(seed) || seed < 0 || seed > 4_294_967_295) {
    throw new PlannerInputError("options.seed must be an integer between 0 and 4294967295.", "options.seed");
  }
  const developmentScenes =
    positiveInteger(options.developmentScenes, "options.developmentScenes", 64) ?? PLANNER_DEFAULTS.developmentScenes;
  const minSceneDurationMs =
    durationMs(options.minSceneDurationMs, "options.minSceneDurationMs") ?? PLANNER_DEFAULTS.minSceneDurationMs;
  if (minSceneDurationMs < 250) {
    throw new PlannerInputError(
      "options.minSceneDurationMs must be at least 250; shorter specs are rejected by validation.",
      "options.minSceneDurationMs",
    );
  }
  const totalDurationMs = durationMs(options.totalDurationMs, "options.totalDurationMs");
  if (totalDurationMs !== undefined && totalDurationMs > PLANNER_DEFAULTS.maxTotalDurationMs) {
    throw new PlannerInputError(
      `options.totalDurationMs may not exceed ${PLANNER_DEFAULTS.maxTotalDurationMs} ms; received ${totalDurationMs}.`,
      "options.totalDurationMs",
    );
  }
  const aspectRatio = tidyText(options.aspectRatio, "options.aspectRatio", 24) ?? PLANNER_DEFAULTS.aspectRatio;
  if (!/^\d{1,3}:\d{1,3}$/u.test(aspectRatio) || aspectRatio.split(":").some((part) => Number(part) < 1)) {
    throw new PlannerInputError(
      `options.aspectRatio must look like 16:9 with positive parts; received "${aspectRatio}".`,
      "options.aspectRatio",
    );
  }
  const outputCountPerSpec =
    positiveInteger(options.outputCountPerSpec, "options.outputCountPerSpec", 32) ?? PLANNER_DEFAULTS.outputCountPerSpec;
  const defaultOutputKinds = specKinds(options.defaultOutputKinds, "options.defaultOutputKinds", PLANNER_DEFAULTS.defaultOutputKinds);
  return {
    // The *fallback* title is the brief-foundation rule's decision, not a normalization detail.
    ...(tidyText(options.planTitle, "options.planTitle", 200) === undefined
      ? {}
      : { planTitle: tidyText(options.planTitle, "options.planTitle", 200) }),
    totalDurationMs,
    minSceneDurationMs,
    maxTotalDurationMs: PLANNER_DEFAULTS.maxTotalDurationMs,
    developmentScenes,
    aspectRatio,
    outputCountPerSpec,
    defaultOutputKinds,
    seed,
    replan,
    includeTrace: options.includeTrace !== false,
  };
}

/** Explicit keys win; derived keys are positional so they stay unique without hashing prose. */
export function beatKey(beat: NormalizedBeat, index: number): string {
  return beat.key.length > 0 ? beat.key : `beat-${index + 1}`;
}

/** Options that decide *what is planned* never here; these decide only *how the run is written*. */
const WRITE_ONLY_OPTIONS: readonly (keyof NormalizedOptions)[] = ["replan", "includeTrace"];

/**
 * The projection the input fingerprint is taken over: everything a rule can read, minus the clock and
 * minus the write policy.
 *
 * `asOf` is excluded because recording a plan at a different time is the same plan — that is what lets an
 * identical re-run be recognised as unchanged. `replan` and `includeTrace` are excluded for the same
 * reason in the other direction: they say which version to write into and whether to keep a trace, and
 * changing them must not make the *creative* input look different. `seed` by contrast does change what is
 * planned, so it stays in.
 */
export function fingerprintableView(normalized: NormalizedPlannerInput): Record<string, unknown> {
  const { asOf: _asOf, options, ...rest } = normalized;
  const writeOnly: Record<string, unknown> = {};
  const planning: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if ((WRITE_ONLY_OPTIONS as readonly string[]).includes(key)) {
      writeOnly[key] = value;
      continue;
    }
    planning[key] = value;
  }
  void writeOnly;
  return { ...rest, options: planning };
}

export function inputFingerprintOf(normalized: NormalizedPlannerInput): string {
  return plannerFingerprint(PLANNER_INPUT_FINGERPRINT_NAMESPACE, {
    plannerVersion: normalized.plannerVersion,
    rulesVersion: normalized.rulesVersion,
    input: fingerprintableView(normalized),
  });
}

