import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteJobRepository, SqlitePlanningRepository } from "@flowforge/storage";
import {
  createApplication,
  sortFindings,
  validatePlanVersion,
} from "../dist/index.js";

const NOW = "2026-03-01T00:00:00.000Z";
const LATER = "2026-03-02T00:00:00.000Z";

/**
 * Application-layer tests for the creative planning domain. They run against the real durable stack
 * (SQLite repository for both execution and planning state) so every assertion is about orchestration
 * and invariants rather than a mocked approximation.
 */
const FULL_CAPABILITIES = Object.freeze({
  imageGeneration: true,
  videoGeneration: true,
  referenceImages: true,
  startFrame: true,
  endFrame: true,
  batchGeneration: true,
});
/** A deterministic provider that cannot batch, reference, or render video — used by gate tests. */
const IMAGE_ONLY_CAPABILITIES = Object.freeze({
  imageGeneration: true,
  videoGeneration: false,
  referenceImages: false,
  startFrame: false,
  endFrame: false,
  batchGeneration: false,
});

async function createHarness(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-planning-services-"));
  const repository = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
  const planning = new SqlitePlanningRepository(repository);
  const providers = options.providers ?? [
    { id: "mock", capabilities: options.capabilities ?? FULL_CAPABILITIES },
  ];
  const app = createApplication(repository, {
    providers,
    now: () => new Date(options.now ?? NOW),
    planning: options.planning === false ? undefined : planning,
  });
  return {
    directory,
    repository,
    planning,
    app,
    close: () => {
      repository.close();
      return rm(directory, { recursive: true, force: true });
    },
  };
}

/** A complete, valid authored plan: brief → plan → story → cast → scene plans → specs. */
async function createAuthoringHarness(options = {}) {
  const harness = await createHarness(options);
  const { app } = harness;
  app.projects.createProject({ projectId: "pilot", name: "Pilot" });
  const { brief } = app.briefs.createBrief({
    projectId: "pilot",
    title: "Launch film",
    concept: "A rooftop chase at dawn",
    objective: "Feel momentum",
    audience: "Operators",
    tone: "Urgent",
    style: "Cinematic",
    constraints: [{ kind: "MUST", value: "no on-screen text" }],
  });
  if (options.briefOnly) return { ...harness, brief };
  const character = app.definitions.createCharacter({
    projectId: "pilot",
    name: "Aya",
    traits: { role: "protagonist", appearance: "red jacket", personality: "decisive" },
    visualIdentity: { description: "silver watch", distinguishingFeatures: ["watch"], palette: ["#c0392b"] },
  });
  const { world } = app.definitions.createWorld({
    projectId: "pilot",
    name: "Rooftops",
    environment: "Dense rooftop grid at dawn",
    rules: ["no vehicles"],
  });
  const { visualDna } = app.definitions.createVisualDna({
    projectId: "pilot",
    name: "dawn-grain",
    style: "35mm film look",
    palette: ["#0b1020", "#c0392b"],
    lighting: "low key",
    composition: "centered thirds",
    cameraLanguage: "slow dolly",
    renderingStyle: "photoreal",
    atmosphere: "tense",
    consistencyRules: ["keep the horizon level"],
  });
  // The version's default Visual DNA is what lets its scene plans inherit an aesthetic contract.
  const created = app.plans.createPlan({
    projectId: "pilot",
    briefId: brief.id,
    title: "Launch film plan",
    visualDnaId: visualDna.id,
  });
  const planId = created.plan.id;
  app.plans.setStory({
    planId,
    premise: "A courier carries one package across the rooftops",
    structure: "three-act",
    themes: ["momentum", "trust"],
    beginning: "arrival",
    development: "pursuit",
    ending: "handoff",
  });
  app.plans.setCast({ planId, cast: [{ characterId: character.id, role: "lead" }] });
  const first = app.plans.addScenePlan({
    planId,
    sceneKey: "open-01",
    sceneNumber: 1,
    title: "Arrival",
    narrativePurpose: "Establish the grid and the package",
    worldId: world.id,
    durationTargetMs: 6_000,
    continuity: [{ statement: "streets are wet" }],
    cast: [{ characterId: character.id, role: "lead" }],
  });
  const firstSpec = app.plans.addGenerationSpec({
    scenePlanId: first.id,
    kind: "image",
    instructions: "Wide rooftop establishing shot, courier entering frame",
    outputCount: 1,
    aspectRatio: "16:9",
    requiredCapabilities: ["imageGeneration"],
  });
  const second = app.plans.addScenePlan({
    planId,
    sceneKey: "open-02",
    sceneNumber: 2,
    title: "The gap",
    narrativePurpose: "The jump raises the stakes",
    worldId: world.id,
    continuity: [{ statement: "same red jacket" }],
    cast: [{ characterId: character.id, role: "lead" }],
  });
  const secondSpec = app.plans.addGenerationSpec({
    scenePlanId: second.id,
    kind: "image",
    instructions: "Courier leaps between rooftops, 35mm grain",
    outputCount: 2,
    aspectRatio: "16:9",
    references: [{ kind: "character", id: character.id }],
    requiredCapabilities: ["imageGeneration", "batchGeneration", "referenceImages"],
  });
  return {
    ...harness,
    brief,
    character,
    world,
    visualDna,
    planId,
    first,
    firstSpec,
    second,
    secondSpec,
  };
}

/* -------------------------------------------------------------------------- *
 * Lifecycle                                                                  *
 * -------------------------------------------------------------------------- */

test("a plan walks DRAFT → VALIDATED → APPROVED → EXECUTABLE with derived read models", async () => {
  const harness = await createAuthoringHarness();
  try {
    const { app, planId } = harness;
    let summary = app.planReads.planSummary(planId);
    assert.equal(summary.status, "DRAFT");
    assert.equal(summary.counts.scenePlans, 2);
    assert.equal(summary.counts.generationSpecs, 2);
    assert.equal(summary.counts.cast, 1);
    assert.equal(summary.validation, null, "nothing is validated before the operator asks");
    assert.equal(summary.nextAction, "VALIDATE_PLAN");
    assert.deepEqual(summary.blockers, ["VALIDATION_MISSING"]);

    const validated = app.planValidation.validate({ planId });
    assert.equal(validated.report.status, "PASSED");
    assert.equal(validated.report.errorCount, 0);
    assert.equal(validated.transitioned, true);
    assert.equal(validated.version.status, "VALIDATED");
    assert.equal(validated.report.isCurrent, true);
    assert.equal(app.planReads.planSummary(planId).nextAction, "APPROVE_PLAN");

    const approved = app.plans.approve({ planId, reviewer: "ops-bot" });
    assert.equal(approved.version.status, "APPROVED");
    assert.equal(approved.version.approvedBy, "ops-bot");
    assert.equal(approved.version.approvedValidationId, approved.validation.validationId);
    assert.equal(approved.idempotent, false);
    assert.equal(app.planReads.planSummary(planId).nextAction, "MARK_EXECUTABLE");

    const executable = app.plans.markExecutable({ planId, providers: ["mock"] });
    assert.equal(executable.version.status, "EXECUTABLE");
    assert.deepEqual(executable.version.executableProviders, ["mock"]);
    assert.deepEqual(
      executable.capabilityCoverage.map((row) => row.candidateProviders),
      [["mock"], ["mock"]],
    );
    const status = app.planReads.planSummary(planId);
    assert.equal(status.nextAction, "EXECUTE_VIA_PHASE_3");
    assert.deepEqual(status.blockers, []);
    assert.equal(app.planReads.inspect({ planId }).executability.executable, true);

    // Approval and executability are explicit and idempotent, never re-derived silently.
    assert.equal(app.plans.approve({ planId, reviewer: "someone-else" }).idempotent, true);
    assert.equal(app.plans.approve({ planId, reviewer: "someone-else" }).version.approvedBy, "ops-bot");
    assert.equal(app.plans.markExecutable({ planId, providers: ["mock"] }).idempotent, true);
  } finally {
    await harness.close();
  }
});

test("impossible transitions and missing preconditions fail with typed codes", async () => {
  const harness = await createAuthoringHarness();
  try {
    const { app, planId } = harness;
    assert.throws(
      () => app.plans.approve({ planId, reviewer: "ops" }),
      (error) => error.code === "PLAN_VALIDATION_REQUIRED" && /validate it before approval/.test(error.message),
    );
    assert.throws(
      () => app.plans.markExecutable({ planId, providers: ["mock"] }),
      (error) => error.code === "PLAN_NOT_APPROVED",
    );
    assert.throws(
      () => app.plans.markExecutable({ planId, providers: ["unknown-provider"] }),
      (error) => error.code === "PROVIDER_NOT_CONFIGURED",
      "an unknown provider id is refused before plan state is even consulted",
    );

    app.planValidation.validate({ planId });
    assert.equal(app.planReads.planSummary(planId).status, "VALIDATED");
    // Reopening is the documented VALIDATED -> DRAFT edge.
    assert.equal(app.plans.reopen({ planId }).status, "DRAFT");
    app.planValidation.validate({ planId });
    const approved = app.plans.approve({ planId, reviewer: "ops" });
    assert.equal(approved.version.status, "APPROVED");
    // An approved version cannot be reopened in place — only archived or revised.
    assert.throws(
      () => app.plans.reopen({ planId }),
      (error) => error.code === "INVALID_STATE_TRANSITION" && /plan revise to fork/.test(error.message),
    );
    assert.throws(
      () => app.plans.addScenePlan({ planId, sceneKey: "late-03", title: "Late" }),
      (error) => error.code === "PLAN_NOT_EDITABLE",
    );

    const archived = app.plans.archive({ planId });
    assert.equal(archived.status, "ARCHIVED");
    assert.equal(app.plans.archive({ planId, now: LATER }).status, "ARCHIVED", "archiving again is a no-op");
    assert.equal(app.planReads.planSummary(planId).nextAction, "PLAN_ARCHIVED");
    assert.throws(
      () => app.plans.setStory({ planId, premise: "rewritten" }),
      (error) => error.code === "PLAN_NOT_EDITABLE",
    );
  } finally {
    await harness.close();
  }
});

test("approval refuses content that changed after validation", async () => {
  const harness = await createAuthoringHarness();
  try {
    const { app, planId } = harness;
    const before = app.planValidation.validate({ planId });
    assert.equal(before.report.status, "PASSED");

    // Editing a validated-but-unapproved version is allowed, and makes the evidence stale.
    app.plans.setStory({ planId, premise: "A courier carries two packages", structure: "three-act", beginning: "a", development: "b", ending: "c" });
    const stale = app.planReads.planSummary(planId);
    assert.equal(stale.validation.isCurrent, false);
    assert.equal(stale.nextAction, "REVALIDATE_PLAN");
    assert.ok(stale.blockers.includes("VALIDATION_STALE"));
    assert.throws(
      () => app.plans.approve({ planId, reviewer: "ops" }),
      (error) =>
        error.code === "PLAN_VALIDATION_REQUIRED" &&
        error.details.validatedContentHash !== error.details.currentContentHash,
    );

    const again = app.planValidation.validate({ planId });
    assert.equal(again.report.isCurrent, true);
    assert.equal(again.transitioned, false, "already VALIDATED; only the evidence is refreshed");
    assert.equal(again.evidenceReused, false, "changed content records new evidence rather than reusing it");
    assert.equal(app.plans.approve({ planId, reviewer: "ops" }).version.status, "APPROVED");
  } finally {
    await harness.close();
  }
});

test("a passing validation that later fails moves the version back to DRAFT", async () => {
  const harness = await createAuthoringHarness();
  try {
    const { app, planId, first } = harness;
    assert.equal(app.planValidation.validate({ planId }).version.status, "VALIDATED");
    // Removing a spec leaves a scene plan nothing to execute.
    app.plans.removeGenerationSpec({ specId: harness.firstSpec.id });
    const result = app.planValidation.validate({ planId });
    assert.equal(result.report.status, "FAILED");
    assert.ok(result.report.findings.some((finding) => finding.code === "SCENE_WITHOUT_GENERATION_SPEC"));
    assert.equal(result.version.status, "DRAFT");
    assert.equal(result.transitioned, true);
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------- *
 * Capability boundary                                                        *
 * -------------------------------------------------------------------------- */

test("capability requirements gate executability with structured results, never a silent pass", async () => {
  const harness = await createAuthoringHarness({ capabilities: IMAGE_ONLY_CAPABILITIES });
  try {
    const { app, planId } = harness;
    // The authored plan asks for batchGeneration, which the mock provider does not declare.
    const validated = app.planValidation.validate({ planId });
    assert.equal(validated.report.status, "FAILED");
    const unavailable = validated.report.findings.filter((finding) => finding.code === "CAPABILITY_UNAVAILABLE");
    // One finding per unsatisfied capability of the batch/reference spec; the plain image spec is clean.
    assert.equal(unavailable.length, 2);
    assert.deepEqual(
      [...new Set(unavailable.map((finding) => finding.subject.id))],
      [harness.secondSpec.id],
    );
    assert.match(unavailable.map((finding) => finding.message).join(" "), /batchGeneration/);
    assert.match(unavailable.map((finding) => finding.message).join(" "), /referenceImages/);

    // A provider that declares it makes the same plan pass — the check is about declarations only.
    const video = {
      id: "render-farm",
      capabilities: {
        imageGeneration: true,
        videoGeneration: true,
        referenceImages: true,
        startFrame: true,
        endFrame: true,
        batchGeneration: true,
      },
    };
    const second = await createHarness({ providers: [video] });
    void second;
    try {
      second.app.projects.createProject({ projectId: "pilot", name: "Pilot" });
      const { brief } = second.app.briefs.createBrief({ projectId: "pilot", title: "T", concept: "c", objective: "o" });
      const plan = second.app.plans.createPlan({ projectId: "pilot", briefId: brief.id, title: "Plan" }).plan;
      second.app.plans.setStory({ planId: plan.id, premise: "p", structure: "s", beginning: "a", development: "b", ending: "c" });
      const scenePlan = second.app.plans.addScenePlan({ planId: plan.id, sceneKey: "k", title: "t", narrativePurpose: "np" });
      second.app.plans.addGenerationSpec({
        scenePlanId: scenePlan.id,
        kind: "video",
        instructions: "leap",
        durationMs: 5_000,
        outputCount: 2,
        references: [{ kind: "world", id: "missing" }],
        requiredCapabilities: ["videoGeneration", "batchGeneration", "referenceImages"],
      });
      const report = second.app.planValidation.validate({ planId: plan.id });
      assert.equal(report.report.status, "FAILED", "a dangling reference still blocks, provider or not");
      assert.ok(report.report.findings.some((finding) => finding.code === "DANGLING_PLANNING_REFERENCE"));

      // Unknown capability keys are refused before anything is written.
      assert.throws(
        () =>
          second.app.plans.addGenerationSpec({
            scenePlanId: scenePlan.id,
            kind: "image",
            instructions: "x",
            requiredCapabilities: ["supportsCinematicLighting"],
          }),
        (error) => error.code === "VALIDATION_FAILED" && /ProviderCapabilities key/.test(error.message),
      );
      // And an unknown provider id cannot be used to satisfy the gate.
      assert.throws(
        () => second.app.plans.markExecutable({ planId: plan.id, providers: ["nope"] }),
        (error) =>
          error.code === "PROVIDER_NOT_CONFIGURED" && error.details.configuredProviders.includes("render-farm"),
      );
    } finally {
      await second.close();
    }
  } finally {
    await harness.close();
  }
});

test("capability satisfiability is checked against declarations only — no provider is constructed", async () => {
  const harness = await createAuthoringHarness();
  try {
    const { app, planId } = harness;
    assert.equal(app.planValidation.validate({ planId }).report.status, "PASSED");
    app.plans.approve({ planId, reviewer: "ops" });
    assert.equal(app.plans.markExecutable({ planId, providers: ["mock"] }).version.status, "EXECUTABLE");
    // No provider object exists in this process at all: reads and gating never need one.
    assert.equal(app.providers.size, 1);
    assert.equal(typeof app.providers.get("mock"), "object");
    assert.equal(app.repository.listGenerationJobs({}).length, 0);
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------- *
 * Planning/execution separation                                              *
 * -------------------------------------------------------------------------- */

test("planning never creates scenes, jobs, or queue entries", async () => {
  const harness = await createAuthoringHarness();
  try {
    const { app, planId } = harness;
    app.planValidation.validate({ planId });
    app.plans.approve({ planId, reviewer: "ops" });
    app.plans.markExecutable({ planId, providers: ["mock"] });
    const preview = app.planReads.executionPreview({ planId });

    assert.equal(preview.executable, true);
    assert.deepEqual(preview.blockers, []);
    assert.equal(preview.items.length, 2);
    const item = preview.items.find((entry) => entry.sceneKey === "open-01");
    assert.equal(item.prompt, "Wide rooftop establishing shot, courier entering frame");
    assert.equal(item.outputCount, 1);
    assert.equal(item.aspectRatio, "16:9");
    assert.equal(item.sceneTitle, "01 Arrival");
    assert.deepEqual(item.candidateProviders, ["mock"]);
    assert.equal(item.acceptable, true);
    assert.equal(item.metadata.planVersionId, preview.planVersionId);
    assert.equal(item.metadata.projectId, "pilot");
    assert.match(item.metadata.contentHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      preview.items.map((entry) => entry.sceneKey),
      ["open-01", "open-02"],
      "items follow scene order deterministically",
    );

    // The execution spine is untouched: no scenes, no versions, no jobs, no queue entries.
    assert.equal(app.projects.overview("pilot").scenes.length, 0);
    assert.equal(app.repository.listGenerationJobs({}).length, 0);
    assert.equal(app.repository.listQueueItems({}).length, 0);
    assert.equal(app.repository.listProjectAssets("pilot").length, 0);
  } finally {
    await harness.close();
  }
});

test("a plan that is not executable previews as refused work rather than executable work", async () => {
  const harness = await createAuthoringHarness();
  try {
    const preview = harness.app.planReads.executionPreview({ planId: harness.planId });
    assert.equal(preview.executable, false);
    assert.ok(preview.blockers.includes("PLAN_NOT_VALIDATED"));
    assert.equal(preview.items.every((item) => !item.acceptable), true);
    assert.match(preview.items[0].reason, /not EXECUTABLE/);
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------- *
 * Versioning                                                                 *
 * -------------------------------------------------------------------------- */

test("revising copies an approved version and never mutates it", async () => {
  const harness = await createAuthoringHarness();
  try {
    const { app, planId } = harness;
    // Nothing to fork while the current version is still editable.
    const noop = app.plans.revise({ planId });
    assert.equal(noop.created, false);

    app.planValidation.validate({ planId });
    const approved = app.plans.approve({ planId, reviewer: "ops" });
    const approvedSnapshot = app.planReads.inspect({ planId, versionNumber: 1 });
    app.plans.markExecutable({ planId, providers: ["mock"] });
    const revised = app.plans.revise({ planId, note: "tighten the pursuit" });
    assert.equal(revised.created, true);
    assert.equal(revised.version.versionNumber, 2);
    assert.equal(revised.version.status, "DRAFT");
    assert.equal(revised.version.predecessorVersionId, approved.version.id);
    assert.equal(revised.copiedScenePlans, 2);
    assert.equal(revised.copiedSpecs, 2);

    const versions = app.planReads.versions(planId);
    assert.deepEqual(versions.map((row) => [row.versionNumber, row.status]), [[1, "EXECUTABLE"], [2, "DRAFT"]]);
    assert.deepEqual(versions[1].scenePlans, 2);
    assert.equal(versions[1].validationStatus, null, "the fresh draft has no evidence yet");

    // The approved version keeps its exact content, evidence, and scene keys.
    const frozen = app.planReads.inspect({ planId, versionNumber: 1 });
    assert.equal(frozen.version.contentHash, approvedSnapshot.version.contentHash);
    assert.deepEqual(
      frozen.scenePlans.map((row) => row.sceneKey),
      approvedSnapshot.scenePlans.map((row) => row.sceneKey),
    );
    assert.equal(frozen.validation.status, "PASSED");
    assert.notEqual(
      frozen.scenePlans[0].scenePlanId,
      app.planReads.inspect({ planId, versionNumber: 2 }).scenePlans[0].scenePlanId,
      "copies are new rows, not aliases",
    );

    // Editing the new draft is fine; the copy keeps referential resolution intact.
    app.plans.setStory({ planId, premise: "One package, two rooftops", structure: "three-act", beginning: "a", development: "b", ending: "c" });
    const revalidated = app.planValidation.validate({ planId });
    assert.equal(revalidated.report.status, "PASSED");
    assert.equal(revalidated.version.versionNumber, 2);
    assert.throws(
      () => app.plans.removeScenePlan({ scenePlanId: frozen.scenePlans[0].scenePlanId }),
      (error) => error.code === "PLAN_NOT_EDITABLE",
    );
  } finally {
    await harness.close();
  }
});

test("current-version pointer, brief pinning, and idempotent creation are durable", async () => {
  const harness = await createAuthoringHarness();
  try {
    const { app, planId } = harness;
    const again = app.plans.createPlan({ projectId: "pilot", briefId: harness.brief.id, title: "Launch film plan" });
    assert.equal(again.created, false);
    assert.equal(again.plan.id, planId);

    const revision = app.briefs.createBrief({
      projectId: "pilot",
      title: "Launch film",
      concept: "A rooftop chase at dusk",
      objective: "Feel momentum",
    });
    assert.equal(revision.brief.versionNumber, 2);
    assert.equal(app.briefs.currentBrief("pilot").id, revision.brief.id);
    assert.equal(app.briefs.listBriefs("pilot").length, 2);
    // The plan keeps pointing at the snapshot it was authored against.
    assert.equal(app.planReads.getPlan(planId).briefId, harness.brief.id);
    assert.equal(app.planReads.inspect({ planId }).brief.id, harness.brief.id);
    assert.equal(app.planReads.inspect({ planId }).brief.versionNumber, 1);
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------- *
 * Read models                                                                *
 * -------------------------------------------------------------------------- */

test("operator read models expose version, validity, approval, executability, and structure", async () => {
  const harness = await createAuthoringHarness();
  try {
    const { app, planId } = harness;
    app.planValidation.validate({ planId });
    const detail = app.planReads.inspect({ planId });
    assert.equal(detail.version.status, "VALIDATED");
    assert.equal(detail.counts.scenePlans, 2);
    assert.equal(detail.counts.generationSpecs, 2);
    assert.equal(detail.story.themes.length, 2);
    assert.deepEqual(detail.cast.map((row) => row.name), ["Aya"]);
    assert.equal(detail.cast[0].hasIdentityTraits, true);
    assert.equal(detail.worlds.length, 1);
    assert.equal(detail.visualDna.length, 1);
    assert.equal(detail.scenePlans[0].world.name, "Rooftops");
    assert.equal(detail.scenePlans[0].visualDna.source, "planVersion");
    assert.equal(detail.scenePlans[0].visualDna.resolvedInProject, true);
    assert.deepEqual(detail.scenePlans[0].cast.map((row) => row.name), ["Aya"]);
    assert.equal(detail.scenePlans[0].specs[0].providerRequirements.capabilities.includes("imageGeneration"), true);
    assert.equal(detail.approval.approvedBy, undefined);
    assert.equal(detail.executability.executable, false);
    assert.ok(detail.executability.blockers.includes("PLAN_NOT_APPROVED"));
    assert.equal(detail.lineage.predecessorVersionId, undefined);

    const overview = app.planReads.projectOverview("pilot");
    assert.equal(overview.briefs.length, 1);
    assert.equal(overview.characters.length, 1);
    assert.equal(overview.worlds.length, 1);
    assert.equal(overview.visualDna.length, 1);
    assert.equal(overview.plans.length, 1);

    const report = app.planReads.validationReport({ planId });
    assert.equal(report.validatorVersion, "planning-deterministic-v1");
    assert.equal(report.errorCount, 0);

    assert.throws(() => app.planReads.listPlans("nope"), (error) => error.code === "NOT_FOUND");
    assert.throws(() => app.planReads.getPlan("nope"), (error) => error.code === "NOT_FOUND");
    assert.throws(() => app.planReads.inspect({ planId, versionNumber: 9 }), (error) => error.code === "NOT_FOUND");
  } finally {
    await harness.close();
  }
});

test("planning without a wired repository fails with a typed code, and Phase 3 keeps working", async () => {
  const harness = await createHarness({ planning: false });
  try {
    harness.app.projects.createProject({ projectId: "pilot", name: "Pilot" });
    for (const call of [
      () => harness.app.briefs.createBrief({ projectId: "pilot", title: "T" }),
      () => harness.app.definitions.createWorld({ projectId: "pilot", name: "W" }),
      () => harness.app.plans.createPlan({ projectId: "pilot", briefId: "b", title: "P" }),
      () => harness.app.planValidation.validate({ planId: "p" }),
      () => harness.app.planReads.listPlans("pilot"),
    ]) {
      assert.throws(call, (error) => error.code === "PLANNING_NOT_CONFIGURED");
    }
    // The Phase 3 surface is unaffected.
    const scene = harness.app.scenes.createScene({ projectId: "pilot", sceneId: "s1", title: "Opening", sceneNumber: 1 });
    assert.equal(scene.status, "DRAFT");
    assert.equal(harness.app.projects.overview("pilot").totals.scenes, 1);
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------- *
 * The deterministic validator, exercised without a database                  *
 * -------------------------------------------------------------------------- */

function baseSnapshot() {
  const scenePlan = (id, key, number, overrides = {}) => ({
    scenePlan: {
      id,
      planVersionId: "pv-1",
      sceneKey: key,
      sceneNumber: number,
      title: `Scene ${number}`,
      narrativePurpose: "move the story",
      description: "",
      continuity: [{ statement: "continuity holds" }],
      requiredReferences: [],
      plannedOutputs: [],
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    },
    cast: [{ characterId: "char-1", role: "lead", position: 0 }],
    specs: [
      {
        id: `spec-${id}`,
        scenePlanId: id,
        specNumber: 1,
        kind: "image",
        instructions: "a shot",
        outputCount: 1,
        references: [],
        constraints: [],
        providerRequirements: { capabilities: ["imageGeneration"] },
        createdAt: NOW,
      },
    ],
  });
  const scenePlans = [scenePlan("sp-1", "open-01", 1), scenePlan("sp-2", "open-02", 2)];
  return {
    projectId: "proj-1",
    plan: {
      id: "plan-1",
      projectId: "proj-1",
      title: "Plan",
      briefId: "brief-1",
      idempotencyKey: "key",
      createdAt: NOW,
      updatedAt: NOW,
    },
    version: {
      id: "pv-1",
      planId: "plan-1",
      versionNumber: 1,
      status: "DRAFT",
      contentHash: "hash",
      visualDnaId: "dna-1",
      createdAt: NOW,
      updatedAt: NOW,
    },
    brief: {
      id: "brief-1",
      projectId: "proj-1",
      versionNumber: 1,
      title: "Brief",
      concept: "concept",
      objective: "objective",
      audience: "",
      tone: "",
      style: "",
      constraints: [{ kind: "MUST", value: "keep it short" }],
      status: "ACTIVE",
      contentHash: "hash",
      createdAt: NOW,
    },
    story: {
      id: "story-1",
      planVersionId: "pv-1",
      premise: "premise",
      structure: "three-act",
      themes: [],
      beginning: "a",
      development: "b",
      ending: "c",
      createdAt: NOW,
      updatedAt: NOW,
    },
    cast: [{ characterId: "char-1", role: "lead" }],
    characters: [
      {
        id: "char-1",
        projectId: "proj-1",
        name: "Aya",
        traits: { appearance: "red jacket", personality: "decisive" },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    worlds: [
      {
        id: "world-1",
        projectId: "proj-1",
        name: "Rooftops",
        description: "",
        environment: "rooftop grid",
        rules: [],
        visualIdentity: { description: "", palette: [], lighting: "" },
        versionNumber: 1,
        status: "ACTIVE",
        contentHash: "hash",
        createdAt: NOW,
      },
    ],
    visualDna: [
      {
        id: "dna-1",
        projectId: "proj-1",
        name: "dawn-grain",
        description: "",
        style: "35mm",
        palette: ["#0b1020"],
        lighting: "low",
        composition: "thirds",
        cameraLanguage: "dolly",
        renderingStyle: "photoreal",
        atmosphere: "tense",
        consistencyRules: [],
        versionNumber: 1,
        status: "ACTIVE",
        contentHash: "hash",
        createdAt: NOW,
      },
    ],
    scenePlans,
    specs: scenePlans.flatMap((node) => node.specs),
  };
}

const IMAGE_ONLY = new Map([
  [
    "mock",
    {
      id: "mock",
      capabilities: {
        imageGeneration: true,
        videoGeneration: false,
        referenceImages: false,
        startFrame: false,
        endFrame: false,
        batchGeneration: false,
      },
    },
  ],
]);

function codesFor(snapshot, options = { providers: IMAGE_ONLY }) {
  return sortFindings(validatePlanVersion(snapshot, options)).map((finding) => `${finding.severity}:${finding.code}`);
}

test("a well-formed authored snapshot validates clean and is deterministic", () => {
  const snapshot = baseSnapshot();
  assert.deepEqual(validatePlanVersion(snapshot, { providers: IMAGE_ONLY }), []);
  const repeated = validatePlanVersion(JSON.parse(JSON.stringify({ ...snapshot, scenePlans: [...snapshot.scenePlans].reverse() })), {
    providers: IMAGE_ONLY,
  });
  assert.deepEqual(repeated, [], "finding order follows scene order only for real violations");
});

test("the validator detects every enumerated structural failure", () => {
  const cases = [
    [
      "missing project ownership",
      (snapshot) => {
        snapshot.projectId = "other";
      },
      "ERROR:PROJECT_OWNERSHIP_MISSING",
    ],
    [
      "brief missing",
      (snapshot) => {
        snapshot.brief = null;
      },
      "ERROR:BRIEF_UNUSABLE",
    ],
    [
      "brief superseded",
      (snapshot) => {
        snapshot.brief.status = "SUPERSEDED";
      },
      "ERROR:BRIEF_UNUSABLE",
    ],
    [
      "brief required field empty",
      (snapshot) => {
        snapshot.brief.objective = "  ";
      },
      "ERROR:BRIEF_FIELD_MISSING",
    ],
    [
      "brief constraint malformed",
      (snapshot) => {
        snapshot.brief.constraints = [{ kind: "SHOULD", value: "" }];
      },
      "ERROR:BRIEF_CONSTRAINT_INVALID",
    ],
    [
      "story missing",
      (snapshot) => {
        snapshot.story = null;
      },
      "ERROR:STORY_MISSING",
    ],
    [
      "story fields empty",
      (snapshot) => {
        snapshot.story.ending = "";
      },
      "ERROR:STORY_FIELD_MISSING",
    ],
    [
      "empty executable plan",
      (snapshot) => {
        snapshot.scenePlans = [];
        snapshot.specs = [];
      },
      "ERROR:SCENE_PLANS_EMPTY",
    ],
    [
      "duplicate scene order",
      (snapshot) => {
        snapshot.scenePlans[1].scenePlan.sceneNumber = 1;
      },
      "ERROR:SCENE_ORDER_CONFLICT",
    ],
    [
      "duplicate scene key",
      (snapshot) => {
        snapshot.scenePlans[1].scenePlan.sceneKey = "open-01";
      },
      "ERROR:SCENE_KEY_DUPLICATE",
    ],
    [
      "scene plan required field",
      (snapshot) => {
        snapshot.scenePlans[0].scenePlan.narrativePurpose = "";
      },
      "ERROR:SCENE_REQUIRED_FIELDS_MISSING",
    ],
    [
      "scene duration invalid",
      (snapshot) => {
        snapshot.scenePlans[0].scenePlan.durationTargetMs = 0;
      },
      "ERROR:SCENE_DURATION_INVALID",
    ],
    [
      "unknown character reference",
      (snapshot) => {
        snapshot.cast = [{ characterId: "ghost", role: "lead" }];
        snapshot.scenePlans.forEach((node) => {
          node.cast = [{ characterId: "ghost", role: "lead", position: 0 }];
        });
      },
      "ERROR:CHARACTER_UNKNOWN_REFERENCE",
    ],
    [
      "character used but not in cast",
      (snapshot) => {
        snapshot.cast = [];
      },
      "ERROR:CHARACTER_NOT_IN_CAST",
    ],
    [
      "character profile incomplete",
      (snapshot) => {
        snapshot.characters[0].traits = undefined;
      },
      "ERROR:CHARACTER_PROFILE_INCOMPLETE",
    ],
    [
      "unknown world reference",
      (snapshot) => {
        snapshot.scenePlans[0].scenePlan.worldId = "world-999";
      },
      "ERROR:WORLD_UNKNOWN_REFERENCE",
    ],
    [
      "world profile incomplete",
      (snapshot) => {
        snapshot.scenePlans.forEach((node) => {
          node.scenePlan.worldId = "world-1";
        });
        snapshot.worlds[0].environment = "";
      },
      "ERROR:WORLD_PROFILE_INCOMPLETE",
    ],
    [
      "missing visual DNA",
      (snapshot) => {
        delete snapshot.version.visualDnaId;
      },
      "ERROR:VISUAL_DNA_MISSING",
    ],
    [
      "visual DNA from another project",
      (snapshot) => {
        snapshot.visualDna = [{ ...snapshot.visualDna[0], projectId: "elsewhere" }];
      },
      "ERROR:VISUAL_DNA_NOT_IN_PROJECT",
    ],
    [
      "visual DNA incomplete",
      (snapshot) => {
        snapshot.visualDna[0].palette = [];
        snapshot.visualDna[0].atmosphere = "";
      },
      "ERROR:VISUAL_DNA_INCOMPLETE",
    ],
    [
      "spec without a valid scene plan",
      (snapshot) => {
        snapshot.specs = [
          ...snapshot.specs,
          { ...snapshot.specs[0], id: "spec-orphan", scenePlanId: "sp-missing" },
        ];
      },
      "ERROR:GENERATION_SPEC_WITHOUT_SCENE_PLAN",
    ],
    [
      "scene plan without a spec",
      (snapshot) => {
        snapshot.scenePlans[0].specs = [];
        snapshot.specs = snapshot.specs.filter((spec) => spec.scenePlanId !== "sp-1");
      },
      "ERROR:SCENE_WITHOUT_GENERATION_SPEC",
    ],
    [
      "invalid spec value",
      (snapshot) => {
        snapshot.specs[0].outputCount = 0;
        snapshot.scenePlans[0].specs[0].outputCount = 0;
      },
      "ERROR:GENERATION_SPEC_INVALID_VALUE",
    ],
    [
      "invalid aspect ratio",
      (snapshot) => {
        snapshot.specs[0].aspectRatio = "wide";
        snapshot.scenePlans[0].specs[0].aspectRatio = "wide";
      },
      "ERROR:GENERATION_SPEC_INVALID_VALUE",
    ],
    [
      "duration on a non-video spec",
      (snapshot) => {
        snapshot.specs[0].durationMs = 5_000;
        snapshot.scenePlans[0].specs[0].durationMs = 5_000;
      },
      "ERROR:GENERATION_SPEC_INVALID_VALUE",
    ],
    [
      "empty instructions",
      (snapshot) => {
        snapshot.specs[0].instructions = " ";
        snapshot.scenePlans[0].specs[0].instructions = " ";
      },
      "ERROR:GENERATION_SPEC_INVALID_VALUE",
    ],
    [
      "unknown capability requirement",
      (snapshot) => {
        snapshot.specs[0].providerRequirements.capabilities = ["supportsCinematicLighting"];
        snapshot.scenePlans[0].specs[0].providerRequirements.capabilities = ["supportsCinematicLighting"];
      },
      "ERROR:GENERATION_SPEC_UNKNOWN_CAPABILITY",
    ],
    [
      "capability contradicts the spec kind",
      (snapshot) => {
        snapshot.specs[0].kind = "video";
        snapshot.specs[0].providerRequirements.capabilities = ["imageGeneration"];
        snapshot.scenePlans[0].specs[0].kind = "video";
        snapshot.scenePlans[0].specs[0].durationMs = 5_000;
        snapshot.scenePlans[0].specs[0].providerRequirements.capabilities = ["imageGeneration"];
      },
      "ERROR:GENERATION_SPEC_CAPABILITY_MISMATCH",
    ],
    [
      "capability no provider supports",
      (snapshot) => {
        snapshot.specs.forEach((spec) => {
          spec.providerRequirements.capabilities = ["batchGeneration"];
        });
        snapshot.scenePlans.forEach((node) => {
          node.specs.forEach((spec) => {
            spec.providerRequirements.capabilities = ["batchGeneration"];
          });
        });
      },
      "ERROR:CAPABILITY_UNAVAILABLE",
    ],
    [
      "dangling planning reference",
      (snapshot) => {
        snapshot.scenePlans[0].scenePlan.requiredReferences = [{ kind: "character", id: "ghost" }];
      },
      "ERROR:DANGLING_PLANNING_REFERENCE",
    ],
    [
      "dangling scene plan reference across versions",
      (snapshot) => {
        snapshot.scenePlans[0].scenePlan.requiredReferences = [{ kind: "scenePlan", id: "sp-other-version" }];
      },
      "ERROR:DANGLING_PLANNING_REFERENCE",
    ],
  ];

  for (const [label, mutate, expected] of cases) {
    const snapshot = baseSnapshot();
    mutate(snapshot);
    const codes = codesFor(snapshot);
    assert.ok(codes.includes(expected), `${label}: expected ${expected} in ${JSON.stringify(codes)}`);
  }
});

test("warnings are recorded but never block validation", () => {
  const snapshot = baseSnapshot();
  snapshot.scenePlans.forEach((node) => {
    node.scenePlan.continuity = [];
  });
  const findings = validatePlanVersion(snapshot, { providers: IMAGE_ONLY });
  assert.equal(findings.length, 2, "one advisory finding per scene plan");
  assert.deepEqual(
    findings.map((finding) => [finding.severity, finding.code]),
    [
      ["WARNING", "SCENE_CONTINUITY_EMPTY"],
      ["WARNING", "SCENE_CONTINUITY_EMPTY"],
    ],
  );
  const skipped = validatePlanVersion(baseSnapshot());
  assert.deepEqual(skipped.map((finding) => finding.code), ["PROVIDER_CAPABILITY_CHECK_SKIPPED"]);
  assert.equal(skipped[0].severity, "WARNING", "an empty provider registry warns instead of silently passing");
});

test("findings are sorted deterministically by severity, code, and subject", () => {
  const snapshot = baseSnapshot();
  snapshot.story = null;
  snapshot.scenePlans.forEach((node) => {
    node.specs = [];
  });
  snapshot.specs = [];
  const first = validatePlanVersion(snapshot, { providers: IMAGE_ONLY });
  const second = validatePlanVersion(snapshot, { providers: IMAGE_ONLY });
  assert.deepEqual(first, second);
  const severities = first.map((finding) => finding.severity);
  assert.deepEqual(severities, [...severities].sort(), "ERRORs precede WARNINGs");
  assert.ok(first.every((finding) => finding.severity === "ERROR"));
  const keys = first.map((finding) => `${finding.code}|${finding.subject.kind}|${finding.subject.id}`);
  assert.deepEqual(keys, [...keys].sort());
});
