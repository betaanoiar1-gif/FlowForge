import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_STATUS_TRANSITIONS,
  SCENE_STATUS_TRANSITIONS,
  assertProjectStatusTransition,
  assertSceneStatusTransition,
  canTransitionProjectStatus,
  canTransitionSceneStatus,
} from "../dist/index.js";

test("scene status transitions allow reopening but keep archive terminal", () => {
  assert.deepEqual(SCENE_STATUS_TRANSITIONS.DRAFT, ["READY", "ARCHIVED"]);
  assert.deepEqual(SCENE_STATUS_TRANSITIONS.READY, ["DRAFT", "ARCHIVED"]);
  assert.deepEqual(SCENE_STATUS_TRANSITIONS.ARCHIVED, []);
  assert.equal(canTransitionSceneStatus("DRAFT", "READY"), true);
  assert.equal(canTransitionSceneStatus("ARCHIVED", "DRAFT"), false);
  assert.throws(() => assertSceneStatusTransition("ARCHIVED", "READY"), /Invalid scene status transition: ARCHIVED -> READY/);
  assert.equal(assertSceneStatusTransition("READY", "DRAFT"), undefined);
});

test("project status transitions are one-way", () => {
  assert.deepEqual(PROJECT_STATUS_TRANSITIONS.ACTIVE, ["ARCHIVED"]);
  assert.deepEqual(PROJECT_STATUS_TRANSITIONS.ARCHIVED, []);
  assert.equal(canTransitionProjectStatus("ACTIVE", "ARCHIVED"), true);
  assert.equal(canTransitionProjectStatus("ARCHIVED", "ACTIVE"), false);
  assert.throws(() => assertProjectStatusTransition("ARCHIVED", "ACTIVE"), /Invalid project status transition/);
});
