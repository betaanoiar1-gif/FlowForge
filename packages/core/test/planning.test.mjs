import assert from "node:assert/strict";
import test from "node:test";
import {
  GENERATION_SPEC_KINDS,
  PLAN_EDITABLE_STATUSES,
  PLAN_VERSION_STATUS_TRANSITIONS,
  PLANNING_VALIDATOR_VERSION,
  PROVIDER_CAPABILITY_KEYS,
  assertPlanVersionStatusTransition,
  canEditPlanVersion,
  canTransitionPlanVersionStatus,
  isGenerationSpecKind,
  isProviderCapabilityKey,
} from "../dist/index.js";

/**
 * Domain rules of the creative planning aggregate (Phase 4A). These are the invariants every layer
 * above relies on, asserted once at the source instead of re-implemented per caller.
 */
test("plan version lifecycle is explicit and every other edge is impossible", () => {
  assert.deepEqual(PLAN_VERSION_STATUS_TRANSITIONS, {
    DRAFT: ["VALIDATED", "ARCHIVED"],
    VALIDATED: ["APPROVED", "DRAFT", "ARCHIVED"],
    APPROVED: ["EXECUTABLE", "DRAFT", "ARCHIVED"],
    EXECUTABLE: ["DRAFT", "ARCHIVED"],
    ARCHIVED: [],
  });
  assert.equal(canTransitionPlanVersionStatus("DRAFT", "APPROVED"), false);
  assert.equal(canTransitionPlanVersionStatus("DRAFT", "EXECUTABLE"), false);
  assert.equal(canTransitionPlanVersionStatus("VALIDATED", "EXECUTABLE"), false, "approval cannot be skipped");
  assert.equal(canTransitionPlanVersionStatus("APPROVED", "VALIDATED"), false, "approval is not undone by demotion");
  assert.equal(canTransitionPlanVersionStatus("ARCHIVED", "DRAFT"), false, "archive is terminal");
  assert.equal(canTransitionPlanVersionStatus("EXECUTABLE", "APPROVED"), false);

  assert.doesNotThrow(() => assertPlanVersionStatusTransition("DRAFT", "VALIDATED"));
  assert.throws(
    () => assertPlanVersionStatusTransition("DRAFT", "APPROVED", "plan-version-9"),
    /Invalid plan version status transition: DRAFT -> APPROVED \(plan version plan-version-9\)/,
  );
});

test("only authored and validated content accepts edits", () => {
  assert.deepEqual([...PLAN_EDITABLE_STATUSES], ["DRAFT", "VALIDATED"]);
  assert.equal(canEditPlanVersion("DRAFT"), true);
  assert.equal(canEditPlanVersion("VALIDATED"), true);
  for (const status of ["APPROVED", "EXECUTABLE", "ARCHIVED"]) {
    assert.equal(canEditPlanVersion(status), false, `${status} must be frozen`);
  }
});

test("capability requirements reuse the provider capability model and nothing else", () => {
  const capabilities = {
    imageGeneration: true,
    videoGeneration: false,
    referenceImages: true,
    startFrame: false,
    endFrame: false,
    batchGeneration: false,
  };
  // Every key the planning domain may require exists on the provider contract …
  for (const key of PROVIDER_CAPABILITY_KEYS) {
    assert.ok(key in capabilities, `${key} is not a ProviderCapabilities key`);
    assert.equal(typeof capabilities[key], "boolean");
  }
  // … and every provider key is representable, so no capability is unreachable from a plan.
  for (const key of Object.keys(capabilities)) {
    assert.ok(PROVIDER_CAPABILITY_KEYS.includes(key), `${key} missing from PROVIDER_CAPABILITY_KEYS`);
  }
  assert.equal(isProviderCapabilityKey("batchGeneration"), true);
  assert.equal(isProviderCapabilityKey("supportsCinematicLighting"), false);
  assert.equal(isProviderCapabilityKey(undefined), false);
  assert.equal(Object.isFrozen(PROVIDER_CAPABILITY_KEYS), true);
});

test("generation spec kinds are a closed, provider-neutral set", () => {
  assert.deepEqual([...GENERATION_SPEC_KINDS], ["image", "video", "audio", "text"]);
  assert.equal(isGenerationSpecKind("video"), true);
  assert.equal(isGenerationSpecKind("flow-render"), false);
  assert.equal(isGenerationSpecKind(42), false);
});

test("the validator is versioned so evidence can be attributed", () => {
  assert.equal(typeof PLANNING_VALIDATOR_VERSION, "string");
  assert.match(PLANNING_VALIDATOR_VERSION, /^[a-z0-9-]+-v\d+$/);
});
