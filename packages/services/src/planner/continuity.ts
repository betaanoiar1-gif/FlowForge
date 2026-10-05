import { notice, recordTrace, shortId, type PlannerState } from "./state.js";

/**
 * Rules `continuity-linking` and `planned-output-manifest`.
 *
 * Continuity is the seam between scenes: what the next shot must inherit. A generator cannot see the
 * story, so the planner states it in the scene plan — one statement for the opening beat (what the piece
 * must establish) and one per later beat naming the scene it continues from, plus the forward seam for
 * every scene that is not last. `requiredReferences` then names the *artefacts* that carry it: the
 * previous scene plan, the world, the visual DNA, and the cast.
 *
 * These references are always authored, even when no declared provider supports `referenceImages`.
 * A reference in a scene plan is a statement of intent about the story's continuity; a reference on a
 * generation spec is a request to a provider. Capability limits may therefore shrink what a spec asks
 * for, but they never rewrite what the plan says the piece needs — otherwise switching providers would
 * quietly change the creative record.
 *
 * Finally the planned-output manifest: per scene, how many outputs of each kind the plan promises,
 * which is what an operator reads to know whether the plan is the piece they asked for.
 */
export function linkContinuity(state: PlannerState): void {
  const scenes = state.scenes;
  for (const [index, scene] of scenes.entries()) {
    scene.continuity = [];
    scene.requiredReferences = [];
    if (index === 0) {
      scene.continuity.push({
        statement: `Opens the piece: ${scene.narrativePurpose.trim() || scene.title}.`,
        source: `${state.currentRule}`,
      });
    } else {
      const previous = scenes[index - 1];
      scene.continuity.push({
        statement: `Continues from scene plan ${previous.sceneKey} ("${previous.title}").`,
        source: state.currentRule,
      });
      scene.requiredReferences.push({
        kind: "scenePlan",
        id: previous.id,
        note: `inherited from ${previous.sceneKey}`,
      });
    }
    if (scene.continuityNote !== undefined && scene.continuityNote.trim().length > 0) {
      // The caller's own words, kept as given: what the scene inherits is their statement, and only the
      // *shape* of a continuity record is the rule's. Placed after the predecessor seam and before the
      // forward seam, so the sequence an operator reads is still past → stated intent → future.
      scene.continuity.push({ statement: scene.continuityNote.trim(), source: state.currentRule });
    }
    if (index < scenes.length - 1) {
      const next = scenes[index + 1];
      scene.continuity.push({
        statement: `Leads into scene plan ${next.sceneKey} ("${next.title}").`,
        source: state.currentRule,
      });
    }
    if (scene.worldId !== undefined) {
      scene.requiredReferences.push({ kind: "world", id: scene.worldId, note: `setting of ${scene.sceneKey}` });
    }
    if (state.versionVisualDnaId !== undefined) {
      scene.requiredReferences.push({
        kind: "visualDna",
        id: state.versionVisualDnaId,
        note: "the plan's aesthetic contract",
      });
    }
    for (const link of scene.cast) {
      scene.requiredReferences.push({
        kind: "character",
        id: link.characterId,
        note: link.role.length > 0 ? `appears as ${link.role}` : "appears",
      });
    }
  }
  const chained = scenes.filter((scene) => scene.continuity.length > 1).length;
  recordTrace(
    state,
    scenes.length > 0 ? "APPLIED" : "SKIPPED",
    scenes.map((scene) => `${scene.sceneKey}:${shortId(scene.id)}`),
    `${scenes.length} scene plan(s), ${chained} linked to a predecessor`,
  );
}

export function planOutputManifest(state: PlannerState): void {
  for (const scene of state.scenes) {
    scene.plannedOutputs = [];
    for (const spec of scene.specs) {
      const existing = scene.plannedOutputs.find((entry) => entry.kind === spec.kind);
      if (existing) {
        existing.count += spec.outputCount;
        continue;
      }
      scene.plannedOutputs.push({ kind: spec.kind, count: spec.outputCount, note: `beat ${scene.beatKey}` });
    }
  }
  const total = state.scenes.reduce((sum, scene) => sum + scene.plannedOutputs.reduce((acc, entry) => acc + entry.count, 0), 0);
  if (total === 0 && state.scenes.length > 0) {
    notice(
      state,
      "PLANNER_NO_OUTPUTS_PLANNED",
      "ERROR",
      "The plan promises no outputs at all, so nothing could be generated from it.",
      "scenePlans",
    );
  }
  recordTrace(
    state,
    total > 0 ? "APPLIED" : "SKIPPED",
    state.scenes.map((scene) => `${scene.sceneKey}=${scene.plannedOutputs.length}`),
    `${total} output(s) promised across ${state.scenes.length} scene plan(s)`,
  );
}
