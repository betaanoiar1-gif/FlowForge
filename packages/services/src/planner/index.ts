/**
 * The deterministic planner engine (Phase 4B), as a module boundary.
 *
 * `runPlanner` is the whole engine and the only thing an application service needs. The rest of these
 * exports are the contracts around it — the input, the result, the rule registry, the namespaces — plus
 * `authoringId`, which a *service* uses to turn drafted identities into rows. Nothing here touches the
 * database, the queue, a provider, or the clock it was not given.
 */
export { runPlanner, planIdentityId } from "./planner.js";
export { PLANNER_RULES, type PlannerRule } from "./rules.js";
export { applyPlannerRules } from "./rules.js";
export { PlannerInputError, normalizePlannerInput, type NormalizedPlannerInput } from "./normalize.js";
export { plannerId, plannerFingerprint, authoringId, slugify } from "./deterministic-ids.js";
export * from "./types.js";
