import { beatKey, type NormalizedBeat } from "./normalize.js";
import { idFor, notice, recordTrace, uniqueSceneKey, type PlannerState } from "./state.js";
import type { PlannedScenePlan } from "./types.js";

/**
 * Rule `beat-decomposition`: ordered story beats become ordered scene plans.
 *
 * The planner never invents narrative content. It takes each beat's own title and purpose text, puts
 * them in the fields a `ScenePlan` requires, and numbers the scenes densely from 1 in beat order.
 * Emphasis (establish / develop / resolve) is the only structural judgement, and it is a lookup
 * rather than a heuristic: it comes from the input, or from the movement a derived beat belongs to.
 */
export function decomposeBeats(state: PlannerState): void {
  state.scenes = [];
  const scenes: PlannedScenePlan[] = [];
  state.beats.forEach((beat, index) => {
    const key = beatKey(beat, index);
    // A beat's own key is the most stable thing it has, so it wins over the title when present.
    const seed = beat.explicit && beat.key.length > 0 ? beat.key : beat.title.length > 0 ? beat.title : key;
    // Keys are allocated as scenes are appended, so a collision resolves to the next suffix in beat order.
    const sceneKey = uniqueSceneKey(state, index, seed);
    const scene: PlannedScenePlan = {
      id: idFor(state, "scene-plan", `${key}:${sceneKey}`),
      sceneKey,
      sceneNumber: index + 1,
      title: beat.title.length > 0 ? beat.title : `Scene ${index + 1}`,
      narrativePurpose: beat.purpose.length > 0 ? beat.purpose : `Advance ${state.input.story.premise}`,
      description: `planned from beat ${key} (${beat.emphasis})`,
      durationTargetMs: 0,
      emphasis: beat.emphasis,
      ...(beat.durationMs === undefined ? {} : { fixedDurationMs: beat.durationMs }),
      cast: [],
      continuity: [],
      requiredReferences: [],
      plannedOutputs: [],
      specs: [],
      beatKey: key,
      outputKinds: beat.outputKinds,
      ...(beat.continuityNote === undefined ? {} : { continuityNote: beat.continuityNote }),
    };
    scenes.push(scene);
    state.scenes.push(scene);
  });
  if (scenes.length === 0) {
    notice(
      state,
      "PLANNER_BEATS_EMPTY",
      "ERROR",
      "The story produced no beats, so there is nothing to plan. Provide story.beats or beginning/development/ending text.",
      "story.beats",
    );
    recordTrace(state, "SKIPPED", undefined, "no beats available");
    return;
  }
  void scenes;
  recordTrace(
    state,
    "APPLIED",
    state.scenes.map((scene) => scene.sceneKey),
    `${state.beats.length} beat(s) → ${state.scenes.length} scene plan(s)`,
  );
}

/** Beat lookup by key, the way every later rule finds the beat a scene came from. */
export function beatOf(state: PlannerState, scene: PlannedScenePlan): NormalizedBeat | undefined {
  const index = state.beats.findIndex((beat) => beatKey(beat, state.beats.indexOf(beat)) === scene.beatKey);
  return index === -1 ? undefined : state.beats[index];
}

/**
 * Rule `cast-assignment`: who appears where.
 *
 * Explicit per-beat characters always win. Otherwise a cast member that declared `scenes` appears
 * only in those beats; every other cast member appears in the establishing and resolving beats (where
 * the company is on stage) and rotates through the developing beats, one per beat, offset by the
 * planning seed. Rotation is index arithmetic, so the same input and seed assign the same people.
 */
export function assignCastToScenes(state: PlannerState): void {
  const names = new Map(state.input.characters.map((character) => [character.id, character.name]));
  const beats = state.beats;
  if (state.input.cast.length === 0) {
    notice(
      state,
      "PLANNER_CAST_EMPTY",
      "INFO",
      "No cast was given, so the plan declares no characters; scene plans carry no cast either.",
      "cast",
    );
    recordTrace(state, "SKIPPED", undefined, "no cast declared");
    return;
  }
  const developPositions = new Map<string, number>();
  let developCount = 0;
  for (const beat of beats) {
    if (beat.emphasis === "develop") developCount += 1;
    developPositions.set(beatKey(beat, beats.indexOf(beat)), developCount);
  }
  state.scenes.forEach((scene, index) => {
    const beat = beatOf(state, scene);
    if (!beat) return;
    const wanted: string[] = [];
    if (beat.characters.length > 0) {
      wanted.push(...beat.characters);
    } else {
      for (const entry of state.input.cast) {
        if (entry.scenes.length > 0) {
          if (entry.scenes.includes(scene.beatKey)) wanted.push(entry.characterId);
          continue;
        }
        if (beat.emphasis === "develop") {
          const position = developPositions.get(scene.beatKey) ?? index + 1;
          const rotation = (state.input.options.seed + position - 1) % state.input.cast.length;
          const member = state.input.cast[rotation];
          if (member) wanted.push(member.characterId);
        } else {
          wanted.push(entry.characterId);
        }
      }
    }
    const seen = new Set<string>();
    for (const characterId of wanted) {
      if (seen.has(characterId)) continue;
      seen.add(characterId);
      if (!names.has(characterId)) {
        // Normalization rejects a beat that names an unknown character, so reaching this line means a
        // rule wired the cast wrong: report it as a planning failure rather than planning a ghost.
        notice(
          state,
          "PLANNER_CHARACTER_UNKNOWN",
          "ERROR",
          `Beat "${scene.beatKey}" assigns character "${characterId}", which is not a character of this project.`,
          "story.beats[].characters",
        );
        continue;
      }
      const declared = state.input.cast.find((entry) => entry.characterId === characterId);
      scene.cast.push({
        characterId,
        role: declared?.role ?? names.get(characterId) ?? "",
        position: scene.cast.length,
      });
    }
  });
  const unscened = state.input.cast.filter(
    (entry) => !state.scenes.some((scene) => scene.cast.some((link) => link.characterId === entry.characterId)),
  );
  for (const entry of unscened) {
    notice(
      state,
      "PLANNER_CAST_MEMBER_UNSCENED",
      "WARNING",
      `Cast member ${entry.characterId} appears in no beat, so the plan declares them without using them.`,
      "cast",
    );
  }
  recordTrace(
    state,
    "APPLIED",
    state.scenes.map((scene) => `${scene.sceneKey}:${scene.cast.length}`),
    `${state.input.cast.length} cast member(s) across ${state.scenes.length} scene plan(s)`,
  );
}

/**
 * Rule `world-binding`: which world a scene happens in.
 *
 * Precedence is explicit beat world → a world that claimed this beat in `scenes` → the only world
 * given to the plan. Leaving a scene unbound is allowed on purpose: a scene may legitimately have no
 * world, and the Phase 4A validator is the single authority on whether the plan is therefore
 * incomplete.
 */
export function bindWorlds(state: PlannerState): void {
  for (const scene of state.scenes) {
    const beat = beatOf(state, scene);
    if (beat?.worldId !== undefined) {
      scene.worldId = beat.worldId;
      continue;
    }
    const declared = state.input.worlds.find((world) => world.scenes.includes(scene.beatKey));
    if (declared) {
      scene.worldId = declared.worldId;
      continue;
    }
    if (state.input.worlds.length === 1) {
      scene.worldId = state.input.worlds[0].worldId;
      continue;
    }
    if (state.input.worlds.length > 1) {
      notice(
        state,
        "PLANNER_WORLD_AMBIGUOUS",
        "WARNING",
        `Beat "${scene.beatKey}" could use any of ${state.input.worlds.length} worlds and none claimed it, so the scene plan has no world binding.`,
        "worlds",
      );
    }
  }
  const bound = state.scenes.filter((scene) => scene.worldId !== undefined);
  recordTrace(
    state,
    bound.length > 0 ? "APPLIED" : "SKIPPED",
    state.scenes.map((scene) => `${scene.sceneKey}:${scene.worldId ?? "none"}`),
    `${bound.length}/${state.scenes.length} scene plan(s) bound to a world`,
  );
}

/**
 * Rule `visual-dna-binding`: the aesthetic contract every scene inherits.
 *
 * An explicit `visualDnaId` is used as given. Otherwise a project with exactly one visual DNA
 * snapshot gets it — that is unambiguous and it is what the validator will demand — and a project with
 * several is left unresolved with a warning naming the choice, because picking "the first one" would
 * be an arbitrary creative decision dressed up as a rule.
 */
export function bindVisualDna(state: PlannerState): void {
  const explicit = state.input.visualDnaId;
  if (explicit !== undefined) {
    state.versionVisualDnaId = explicit;
    recordTrace(state, "APPLIED", [explicit], "explicit visual DNA from the planner input");
    return;
  }
  if (state.input.dna.length === 1) {
    state.versionVisualDnaId = state.input.dna[0].id;
    recordTrace(state, "APPLIED", [state.input.dna[0].id], "the project's only visual DNA snapshot");
    return;
  }
  if (state.input.dna.length === 0) {
    notice(
      state,
      "PLANNER_DNA_MISSING",
      "WARNING",
      "This project has no visual DNA definition, so the plan cannot carry an aesthetic contract and validation will report VISUAL_DNA_MISSING.",
      "visualDnaId",
    );
    recordTrace(state, "SKIPPED", undefined, "no visual DNA in the project");
    return;
  }
  notice(
    state,
    "PLANNER_DNA_AMBIGUOUS",
    "WARNING",
    `The project has ${state.input.dna.length} visual DNA snapshots and the input named none; set visualDnaId to decide.`,
    "visualDnaId",
  );
  recordTrace(state, "SKIPPED", state.input.dna.map((entry) => entry.id), "ambiguous visual DNA");
}
