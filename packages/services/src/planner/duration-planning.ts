import { BEAT_EMPHASIS_WEIGHT, PLANNER_DEFAULTS } from "./types.js";
import { notice, recordTrace, type PlannerState } from "./state.js";

/**
 * Rule `duration-allocation`: how long each scene should run (and how long its video should be).
 *
 * The total duration budget belongs to the operator — `planningOptions.totalDurationMs` states it, and
 * when it is absent the plan is budgeted by shape instead (`scenes x default scene duration`) rather
 * than by guessing a length for a piece nobody asked for. The planner only *divides* the budget:
 *
 *   1. A beat with an explicit `durationMs` is fixed and receives exactly that value.
 *   2. The rest of the budget is shared by emphasis weight (establish 3, develop 2, resolve 2): each
 *      unfixed scene gets `floor(remaining x weight / totalWeight)` whole milliseconds.
 *   3. The flooring remainder is handed out one millisecond at a time, heaviest scene first and then
 *      in scene order, until it is exhausted — so the unfixed scenes add up to exactly what is left.
 *      No drift, no fractional milliseconds, no dependence on floating point accumulation.
 *   4. A share below `minSceneDurationMs` is raised to that floor and the plan's total grows; that is
 *      reported as a warning rather than hidden, because the plan then costs more than the budget said.
 *
 * Fixed beats that alone exceed a *stated* budget are refused with an ERROR: silently compressing an
 * operator's explicit scene lengths would quietly change the creative decision that produced them. When
 * the budget was only the default, it is raised to fit and reported as an INFO line instead.
 */
export function allocateDurations(state: PlannerState): void {
  const { totalDurationMs, minSceneDurationMs, maxTotalDurationMs } = state.input.options;
  const scenes = state.scenes;
  if (scenes.length === 0) {
    recordTrace(state, "SKIPPED", undefined, "no scene plans to allocate to");
    return;
  }
  const budgetWasExplicit = totalDurationMs !== undefined;
  const requestedBudget = totalDurationMs ?? scenes.length * PLANNER_DEFAULTS.sceneDurationMs;
  const fixedTotal = scenes.reduce((sum, scene) => sum + (scene.fixedDurationMs ?? 0), 0);
  let budget = requestedBudget;
  if (fixedTotal > budget) {
    if (budgetWasExplicit || fixedTotal > maxTotalDurationMs) {
      notice(
        state,
        "PLANNER_DURATION_OVER_BUDGET",
        "ERROR",
        `Fixed beat durations total ${fixedTotal} ms, which exceeds the ${budget} ms plan budget. Lower a beat duration or raise planningOptions.totalDurationMs.`,
        "planningOptions.totalDurationMs",
      );
      recordTrace(state, "SKIPPED", undefined, `fixed durations ${fixedTotal} ms exceed the ${budget} ms budget`);
      return;
    }
    notice(
      state,
      "PLANNER_DURATION_BUDGET_RAISED",
      "INFO",
      `Fixed beat durations total ${fixedTotal} ms, more than the ${budget} ms budget implied by the scene count; the plan budget was raised to fit them.`,
    );
    budget = fixedTotal;
  }

  const flexible = scenes.filter((scene) => scene.fixedDurationMs === undefined);
  const remaining = budget - fixedTotal;
  const weightOf = (scene: { emphasis: keyof typeof BEAT_EMPHASIS_WEIGHT }): number =>
    BEAT_EMPHASIS_WEIGHT[scene.emphasis] ?? 2;
  const totalWeight = flexible.reduce((sum, scene) => sum + weightOf(scene), 0);
  const shares = new Map<string, number>();
  if (totalWeight > 0 && remaining > 0) {
    let handed = 0;
    for (const scene of flexible) {
      const share = Math.floor((remaining * weightOf(scene)) / totalWeight);
      shares.set(scene.sceneKey, share);
      handed += share;
    }
    // Whole-millisecond flooring leaves a remainder; hand it out deterministically, heaviest first.
    let leftover = remaining - handed;
    const order = [...flexible].sort((left, right) => weightOf(right) - weightOf(left) || left.sceneNumber - right.sceneNumber);
    for (let cursor = 0; leftover > 0 && order.length > 0; cursor = (cursor + 1) % order.length) {
      const scene = order[cursor];
      if (!scene) break;
      shares.set(scene.sceneKey, (shares.get(scene.sceneKey) ?? 0) + 1);
      leftover -= 1;
    }
  }

  let total = 0;
  let floored = 0;
  for (const scene of scenes) {
    const share = scene.fixedDurationMs ?? shares.get(scene.sceneKey) ?? 0;
    const duration = Math.max(share, minSceneDurationMs);
    if (duration !== share) floored += 1;
    scene.durationTargetMs = duration;
    if (duration !== share) scene.durationWasFloored = true;
    total += duration;
  }
  if (floored > 0) {
    notice(
      state,
      "PLANNER_DURATION_FLOORED",
      "WARNING",
      `${floored} scene(s) would have received less than the ${minSceneDurationMs} ms floor and were raised to it; the plan now totals ${total} ms against a ${budget} ms budget.`,
      "planningOptions.minSceneDurationMs",
    );
  }
  if (total > maxTotalDurationMs) {
    notice(
      state,
      "PLANNER_DURATION_BUDGET_EXCEEDED",
      "ERROR",
      `The planned durations total ${total} ms, above the ${maxTotalDurationMs} ms ceiling ${state.input.plannerVersion} accepts.`,
      "planningOptions.totalDurationMs",
    );
    recordTrace(state, "SKIPPED", undefined, `total ${total} ms exceeds the ${maxTotalDurationMs} ms ceiling`);
    return;
  }
  recordTrace(
    state,
    "APPLIED",
    scenes.map((scene) => `${scene.sceneKey}=${scene.durationTargetMs}`),
    `budget ${budget} ms → planned total ${total} ms across ${scenes.length} scene(s)`,
  );
}
