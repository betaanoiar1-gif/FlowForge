import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteJobRepository, SqlitePlanningRepository } from "@flowforge/storage";
import { createApplication, mapPlanToJobs, planner } from "../dist/index.js";

/**
 * Application-layer tests for the deterministic planner (Phase 4B). They run the real durable stack —
 * SQLite repositories, the Phase 4A planning services, the planning validator — because the promise
 * being tested is that a planned version is *ordinary plan state*: same triggers, same evidence, same
 * lifecycle. Nothing here submits work: the mapping test asserts the queue stays empty.
 */

const NOW = "2026-05-01T00:00:00.000Z";
const IMAGE_ONLY = Object.freeze({
  imageGeneration: true,
  videoGeneration: false,
  referenceImages: true,
  startFrame: false,
  endFrame: false,
  batchGeneration: false,
});
const STORY = {
  premise: "A solo developer ships a launch teaser in an afternoon.",
  beginning: "A developer opens a blank project. Nothing works yet.",
  development: "The pipeline comes online. Shots queue in order. The first render lands.",
  ending: "The teaser ships and the signups arrive.",
};
const PLAN_OPTIONS = { totalDurationMs: 15_000, developmentScenes: 2 };

async function createHarness(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-planner-service-"));
  const repository = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
  const planning = new SqlitePlanningRepository(repository);
  const app = createApplication(repository, {
    providers: options.providers ?? [{ id: "mock", capabilities: options.capabilities ?? IMAGE_ONLY }],
    now: () => new Date(NOW),
    planning,
  });
  app.projects.createProject({ projectId: "pilot", name: "Pilot" });
  const { brief } = app.briefs.createBrief({
    projectId: "pilot",
    title: "Launch film",
    concept: "A launch teaser for a planning tool",
    objective: "Get signups",
    audience: "Indie developers",
    tone: "confident",
    style: "clean product film",
    constraints: [{ kind: "MUST_NOT", value: "on-screen text after the hook" }],
  });
  const character = app.definitions.createCharacter({
    projectId: "pilot",
    characterId: "char-aya",
    name: "Aya",
    traits: { role: "protagonist", appearance: "red jacket", personality: "decisive" },
    visualIdentity: { description: "silver watch", distinguishingFeatures: ["watch"], palette: ["#c0392b"] },
  });
  const reviewer = app.definitions.createCharacter({
    projectId: "pilot",
    characterId: "char-qa",
    name: "Rae",
    traits: { role: "supporting", appearance: "short hair", personality: "exact" },
    visualIdentity: { description: "red scarf" },
  });
  const { world } = app.definitions.createWorld({
    projectId: "pilot",
    worldId: "world-loft",
    name: "The loft",
    environment: "Three monitors and a cold brew",
    rules: ["no visible brand logos"],
  });
  const { visualDna } = app.definitions.createVisualDna({
    projectId: "pilot",
    visualDnaId: "dna-grain",
    name: "grain",
    style: "35mm film look",
    palette: ["#0b1020", "#c0392b"],
    lighting: "low key",
    composition: "centred thirds",
    cameraLanguage: "slow dolly",
    renderingStyle: "photoreal",
    atmosphere: "tense",
    consistencyRules: ["keep the horizon level"],
  });
  const plan = (overrides = {}) =>
    app.planner.plan({
      projectId: "pilot",
      story: STORY,
      cast: [
        { characterId: character.id, role: "the developer" },
        { characterId: reviewer.id, role: "the reviewer" },
      ],
      worlds: [{ worldId: world.id }],
      options: PLAN_OPTIONS,
      ...overrides,
    });
  return {
    directory,
    repository,
    planning,
    app,
    brief,
    world,
    visualDna,
    character,
    reviewer,
    plan,
    close: () => {
      repository.close();
      return rm(directory, { recursive: true, force: true });
    },
  };
}

test("a successful run authors the plan through the Phase 4A services, then validates what it wrote", async () => {
  const harness = await createHarness();
  try {
    const run = harness.plan();
    assert.equal(run.outcome, "SUCCESS");
    assert.equal(run.created, true);
    assert.equal(run.reused, false);
    assert.equal(run.version.status, "VALIDATED");
    assert.equal(run.validation.status, "PASSED");
    assert.equal(run.validation.errorCount, 0);
    assert.equal(run.scenePlans, 4);
    assert.equal(run.specs, 4);
    assert.equal(run.planner.plannerVersion, "deterministic-planner-v1");
    assert.equal(run.planner.rulesVersion, "planning-rules-v1");
    assert.deepEqual(run.rulesApplied, planner.PLANNER_RULES.map((rule) => rule.id));

    const snapshot = harness.app.planReads.snapshot(run.version.id);
    assert.equal(snapshot.scenePlans.length, 4);
    assert.equal(snapshot.specs.length, 4);
    const drafted = run.findings; // findings are the engine's own self-check; only warnings remain
    assert.deepEqual(drafted.filter((finding) => finding.severity === "ERROR"), []);
    // The stored content is the drafted content: same keys, same order, same durations, same instructions.
    const engine = planner.runPlanner(engineInput(harness));
    assert.deepEqual(
      snapshot.scenePlans.map((node) => node.scenePlan.sceneKey),
      engine.draft.scenePlans.map((scene) => scene.sceneKey),
    );
    assert.deepEqual(
      snapshot.scenePlans.map((node) => node.scenePlan.durationTargetMs),
      engine.draft.scenePlans.map((scene) => scene.durationTargetMs),
    );
    // Compare per scene, not by flat order: the stored spec list is ordered by its own keys, and the
    // identity that matters is "this scene's shot text", which must be byte-identical.
    for (const node of snapshot.scenePlans) {
      const scene = engine.draft.scenePlans.find((candidate) => candidate.sceneKey === node.scenePlan.sceneKey);
      assert.ok(scene, `no drafted scene for ${node.scenePlan.sceneKey}`);
      assert.deepEqual(node.specs.map((spec) => spec.instructions), scene.specs.map((spec) => spec.instructions));
      assert.deepEqual(node.specs.map((spec) => spec.outputCount), scene.specs.map((spec) => spec.outputCount));
      assert.deepEqual(
        node.cast.map((link) => [link.characterId, link.position]),
        scene.cast.map((link) => [link.characterId, link.position]),
      );
    }
    // Story and cast came from the plan's own definitions, and the version defaults to the project's DNA.
    assert.equal(snapshot.story.premise, STORY.premise);
    assert.match(snapshot.story.structure, /4 beat\(s\)/u);
    assert.equal(snapshot.version.visualDnaId, harness.visualDna.id);
    assert.deepEqual(snapshot.cast.map((link) => link.characterId), engine.draft.cast.map((entry) => entry.characterId));
    // Continuity references were re-pointed at the rows that exist, so nothing dangles.
    const second = snapshot.scenePlans[1].scenePlan;
    const inherited = second.requiredReferences.find((reference) => reference.kind === "scenePlan");
    assert.equal(inherited.id, snapshot.scenePlans[0].scenePlan.id);
    assert.ok(second.continuity[0].statement.includes(snapshot.scenePlans[0].scenePlan.sceneKey));
    // Spec capabilities describe the spec's own shape, which is what the validator insists on.
    const spec = snapshot.scenePlans[0].specs[0];
    assert.deepEqual([...spec.providerRequirements.capabilities].sort(), ["imageGeneration", "referenceImages"]);
    assert.deepEqual(spec.constraints, ["MUST_NOT: on-screen text after the hook"]);
    assert.equal(spec.aspectRatio, "16:9");

    // Provenance is recorded against the content the planner left, and the read model says so.
    assert.equal(run.version.plannerVersion, "deterministic-planner-v1");
    assert.equal(run.version.plannerInputFingerprint, run.planner.inputFingerprint);
    assert.equal(run.version.plannerOutputFingerprint, run.planner.outputFingerprint);
    assert.equal(run.version.plannerContentHash, harness.planning.planVersionContentHash(run.version.id));
    assert.equal(run.version.plannerTrace.length, planner.PLANNER_RULES.length);
    const [row] = harness.app.planReads.versions(run.plan.id);
    assert.equal(row.planned, true);
    assert.equal(row.unchangedSincePlanning, true);
    assert.equal(harness.app.planReads.inspect({ planId: run.plan.id }).planner.detail, "planned by deterministic-planner-v1 and unchanged since");
  } finally {
    await harness.close();
  }
});

/** The exact planner input the service assembles, so a test can compare stored rows with the draft. */
function engineInput(harness, overrides = {}) {
  const { app, planning } = harness;
  const characters = planning.listProjectCharacters("pilot");
  return {
    projectId: "pilot",
    brief: planning.currentBrief("pilot"),
    story: STORY,
    cast: [
      { characterId: characters[0].id, role: "the developer" },
      { characterId: characters[1].id, role: "the reviewer" },
    ],
    worlds: [{ worldId: harness.world.id }],
    definitions: {
      characters,
      worlds: planning.listWorlds("pilot"),
      visualDna: planning.listVisualDna("pilot"),
    },
    providerCandidates: [{ id: "mock", capabilities: IMAGE_ONLY }],
    options: PLAN_OPTIONS,
    asOf: NOW,
    ...overrides,
  };
}

test("an identical re-plan writes nothing and says it reused the version", async () => {
  const harness = await createHarness();
  try {
    const first = harness.plan();
    const versionsBefore = harness.planning.listPlanVersions(first.plan.id).length;
    const second = harness.plan();
    assert.equal(second.outcome, "SUCCESS");
    assert.equal(second.reused, true);
    assert.equal(second.created, false);
    assert.equal(second.version.id, first.version.id);
    assert.equal(second.planner.inputFingerprint, first.planner.inputFingerprint);
    assert.equal(second.planner.outputFingerprint, first.planner.outputFingerprint);
    assert.equal(harness.planning.listPlanVersions(first.plan.id).length, versionsBefore);
    assert.match(second.nextAction, /no write was made/u);
    // Reuse is not re-validation: the version's status and evidence are untouched.
    assert.equal(second.version.status, first.version.status);
  } finally {
    await harness.close();
  }
});

test("a different seed is a new version of the same plan, not a new plan", async () => {
  const harness = await createHarness();
  try {
    const first = harness.plan();
    const second = harness.plan({ options: { ...PLAN_OPTIONS, seed: 9 } });
    assert.equal(second.outcome, "SUCCESS");
    assert.equal(second.created, true);
    assert.equal(second.plan.id, first.plan.id);
    assert.equal(second.version.versionNumber, 2);
    assert.equal(second.version.predecessorVersionId, first.version.id);
    assert.equal(second.version.plannerSeed, 9);
    // Same scene identity, rotated cast: the seed moves one thing on purpose.
    assert.deepEqual(
      harness.app.planReads.snapshot(second.version.id).scenePlans.map((node) => node.scenePlan.sceneKey),
      harness.app.planReads.snapshot(first.version.id).scenePlans.map((node) => node.scenePlan.sceneKey),
    );
    const developCast = (versionId) =>
      harness.app.planReads.snapshot(versionId).scenePlans[1].cast.map((link) => link.characterId);
    assert.notDeepEqual(developCast(second.version.id), developCast(first.version.id));
    assert.notEqual(second.planner.inputFingerprint, first.planner.inputFingerprint);
  } finally {
    await harness.close();
  }
});

test("a dry run reports the plan it would write without creating it", async () => {
  const harness = await createHarness();
  try {
    const run = harness.plan({ dryRun: true });
    assert.equal(run.outcome, "SUCCESS");
    assert.equal(run.scenePlans, 4);
    assert.equal(run.plan, null);
    assert.equal(run.version, null);
    const targetId = planner.planIdentityId({
      projectId: "pilot",
      briefId: harness.brief.id,
      title: `${harness.brief.title} plan`,
    });
    assert.equal(harness.planning.getPlan(targetId), null);
    assert.equal(run.planner.outputFingerprint, harness.plan().planner.outputFingerprint);
    assert.equal(harness.planning.listPlanVersions(targetId).length, 1);
  } finally {
    await harness.close();
  }
});

test("a draft that fails the planning rules persists nothing at all", async () => {
  const harness = await createHarness();
  try {
    // Two visual DNA snapshots and no explicit choice: the plan cannot resolve an aesthetic contract.
    harness.app.definitions.createVisualDna({
      projectId: "pilot",
      visualDnaId: "dna-other",
      name: "other",
      style: "video",
      palette: ["#fff"],
      lighting: "flat",
      composition: "rule of thirds",
      cameraLanguage: "handheld",
      renderingStyle: "cel",
      atmosphere: "cool",
    });
    const run = harness.plan();
    assert.equal(run.outcome, "VALIDATION_FAILURE");
    assert.ok(run.findings.some((finding) => finding.code === "VISUAL_DNA_MISSING" && finding.severity === "ERROR"));
    assert.ok(run.notices.some((notice) => notice.code === "PLANNER_DNA_AMBIGUOUS"));
    const targetId = planner.planIdentityId({ projectId: "pilot", briefId: harness.brief.id, title: `${harness.brief.title} plan` });
    assert.equal(harness.planning.getPlan(targetId), null);
    assert.equal(harness.planning.listPlans("pilot").length, 0);
    // Choosing one makes the same story plan cleanly; the refusal was about the missing decision, not the story.
    const chosen = harness.plan({ visualDnaId: "dna-grain" });
    assert.equal(chosen.outcome, "SUCCESS");
    assert.equal(chosen.version.visualDnaId, "dna-grain");
  } finally {
    await harness.close();
  }
});

test("planning stays inside the capability envelope and approval reuses the Phase 4A gate", async () => {
  const harness = await createHarness();
  try {
    const refused = harness.plan({ options: { ...PLAN_OPTIONS, defaultOutputKinds: ["video"] } });
    assert.equal(refused.outcome, "PLANNING_FAILURE");
    assert.equal(refused.notices[0].code, "PLANNER_KIND_UNAVAILABLE");
    assert.equal(harness.planning.listPlans("pilot").length, 0);

    const run = harness.plan({ approve: true, reviewer: "ops", providers: ["mock"] });
    assert.equal(run.outcome, "SUCCESS");
    assert.equal(run.version.status, "EXECUTABLE");
    assert.deepEqual(run.version.executableProviders, ["mock"]);
    assert.equal(run.version.approvedBy, "ops");
    assert.match(run.nextAction, /EXECUTABLE/u);
    // An unknown provider id is a wiring mistake, refused before anything is planned.
    assert.throws(
      () => harness.plan({ options: { ...PLAN_OPTIONS, seed: 3 }, providers: ["nope"] }),
      (error) => error.code === "PROVIDER_NOT_CONFIGURED",
    );
  } finally {
    await harness.close();
  }
});

test('the "fail" replan policy refuses instead of quietly forking', async () => {
  const harness = await createHarness();
  try {
    const first = harness.plan();
    assert.equal(first.outcome, "SUCCESS");
    // Same content: reuse is not a conflict, and the policy is never consulted for a no-op.
    assert.equal(harness.plan({ options: { ...PLAN_OPTIONS, replan: "fail" } }).reused, true);
    // Different content under "fail": refuse, and leave the plan exactly as it was.
    assert.throws(
      () => harness.plan({ options: { ...PLAN_OPTIONS, replan: "fail" }, story: { ...STORY, ending: "A different ending entirely." } }),
      (error) => error.code === "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(harness.planning.listPlanVersions(first.plan.id).length, 1);
    assert.equal(harness.app.planReads.snapshot(first.version.id).scenePlans.length, 4);
  } finally {
    await harness.close();
  }
});

test('the "in-place" policy authors into an unprovenanced version and never rewrites history', async () => {
  const harness = await createHarness();
  try {
    const planned = harness.plan();
    // Same content: in-place is a no-op, whatever the policy, because there is nothing to change.
    const reused = harness.plan({ options: { ...PLAN_OPTIONS, replan: "in-place" } });
    assert.equal(reused.reused, true);
    assert.equal(reused.version.id, planned.version.id);
    // Changed content into a version that already records provenance: refused, and the version untouched.
    assert.throws(
      () => harness.plan({ options: { ...PLAN_OPTIONS, seed: 9, replan: "in-place" } }),
      (error) => error.code === "IDEMPOTENCY_CONFLICT" && /write-once/u.test(error.message),
    );
    const untouched = harness.app.planReads.snapshot(planned.version.id);
    assert.equal(untouched.scenePlans.length, 4);
    assert.equal(untouched.scenePlans[1].cast.map((link) => link.characterId).join(","), harness.app.planReads
      .snapshot(planned.version.id).scenePlans[1].cast.map((link) => link.characterId).join(","));

    // A hand-created, still-empty draft version is fair game: the planner authors into it in place.
    // The plan the operator made by hand is found by the planner because the plan id is deterministic —
    // (project, brief, title), and nothing else.
    const handPlanId = planner.planIdentityId({ projectId: "pilot", briefId: harness.brief.id, title: "Empty draft" });
    const handPlan = harness.app.plans.createPlan({
      planId: handPlanId,
      projectId: "pilot",
      briefId: harness.brief.id,
      title: "Empty draft",
      visualDnaId: harness.visualDna.id,
    });
    const authored = harness.app.planner.plan({
      projectId: "pilot",
      story: STORY,
      cast: [{ characterId: harness.character.id, role: "the developer" }],
      worlds: [{ worldId: harness.world.id }],
      options: { ...PLAN_OPTIONS, planTitle: undefined, replan: "in-place" },
      planTitle: "Empty draft",
    });
    assert.equal(authored.outcome, "SUCCESS");
    assert.equal(authored.plan.id, handPlan.plan.id);
    assert.equal(authored.version.versionNumber, 1, "the empty draft the operator made is the one that was filled");
    assert.equal(authored.created, false);
    assert.equal(harness.app.planReads.snapshot(authored.version.id).scenePlans.length, 4);
  } finally {
    await harness.close();
  }
});

test("in-place planning refuses to overwrite hand-authored scene plans", async () => {
  const harness = await createHarness();
  try {
    const planId = planner.planIdentityId({ projectId: "pilot", briefId: harness.brief.id, title: `${harness.brief.title} plan` });
    const created = harness.app.plans.createPlan({
      planId,
      projectId: "pilot",
      briefId: harness.brief.id,
      title: `${harness.brief.title} plan`,
      visualDnaId: harness.visualDna.id,
    });
    const hand = harness.app.plans.addScenePlan({
      planId,
      sceneKey: "hand-authored",
      sceneNumber: 1,
      title: "Written by a person",
      narrativePurpose: "keep this",
      durationTargetMs: 4_000,
      worldId: harness.world.id,
    });
    harness.app.plans.addGenerationSpec({
      scenePlanId: hand.id,
      kind: "image",
      instructions: "A shot a human wrote",
      requiredCapabilities: ["imageGeneration"],
    });
    assert.throws(
      () => harness.plan({ options: { ...PLAN_OPTIONS, replan: "in-place" } }),
      (error) => error.code === "IDEMPOTENCY_CONFLICT",
    );
    const snapshot = harness.app.planReads.snapshot(created.version.id);
    assert.equal(snapshot.scenePlans.length, 1);
    assert.equal(snapshot.scenePlans[0].scenePlan.title, "Written by a person");
    // The default policy leaves the same rows alone and plans into a new version instead.
    const added = harness.plan();
    assert.equal(added.created, true);
    assert.equal(added.version.versionNumber, 2);
    assert.equal(snapshot.scenePlans.length, 1);
    assert.throws(
      () => harness.app.plans.addScenePlan({ planId, sceneKey: "hand-authored", title: "duplicate", sceneNumber: 2 }),
      /conflicts with an existing scene plan/u,
    );
  } finally {
    await harness.close();
  }
});

test("a planned version that is edited afterwards stops claiming to be the planner's output", async () => {
  const harness = await createHarness();
  try {
    const run = harness.plan();
    const [before] = harness.app.planReads.versions(run.plan.id);
    assert.equal(before.unchangedSincePlanning, true);
    const snapshot = harness.app.planReads.snapshot(run.version.id);
    harness.app.plans.addScenePlan({
      planId: run.plan.id,
      sceneKey: "extra-shot",
      sceneNumber: 9,
      title: "Added by hand",
      narrativePurpose: "because",
      durationTargetMs: 3_000,
      worldId: harness.world.id,
    });
    const [after] = harness.app.planReads.versions(run.plan.id);
    assert.equal(after.unchangedSincePlanning, false, `before=${JSON.stringify(before)}`);
    assert.equal(harness.app.planReads.inspect({ planId: run.plan.id }).planner.contentMatchesProvenance, false);
    assert.match(harness.app.planReads.inspect({ planId: run.plan.id }).planner.detail, /then edited/u);
    // The evidence is stale now, which is the point: approval cannot be granted against old content.
    assert.equal(after.validationIsCurrent, false);
    assert.equal(snapshot.scenePlans.length, 4);
  } finally {
    await harness.close();
  }
});

test("planning inputs the project does not have are refused with the codes the CLI already renders", async () => {
  const harness = await createHarness();
  try {
    assert.throws(() => harness.app.planner.plan({ projectId: "ghost" }), (error) => error.code === "NOT_FOUND");
    assert.throws(
      () => harness.app.planner.plan({ projectId: "pilot", briefId: "brief-ghost" }),
      (error) => error.code === "NOT_FOUND",
    );
    // A brief the project has moved past is not a planning input, even when named explicitly.
    const second = harness.app.briefs.createBrief({
      projectId: "pilot",
      title: "Launch film, take two",
      concept: "Same idea, sharper",
      objective: "Get signups",
      audience: "Indie developers",
      tone: "confident",
      style: "clean product film",
    });
    assert.equal(second.brief.status, "ACTIVE");
    const superseded = harness.planning.getBrief(harness.brief.id);
    assert.equal(superseded.status, "SUPERSEDED");
    assert.throws(
      () => harness.app.planner.plan({ projectId: "pilot", briefId: harness.brief.id }),
      (error) => error.code === "VALIDATION_FAILED" && /SUPERSEDED/u.test(error.message),
    );
    // The current brief still plans, and plans against the newer snapshot.
    const run = harness.plan();
    assert.equal(run.outcome, "SUCCESS");
    assert.equal(run.plan.briefId, second.brief.id);
  } finally {
    await harness.close();
  }
});

test("mapping a planned version to execution is deterministic and creates nothing", async () => {
  const harness = await createHarness();
  try {
    const run = harness.plan({ approve: true, reviewer: "ops", providers: ["mock"] });
    const snapshot = harness.app.planReads.snapshot(run.version.id);
    const mapping = mapPlanToJobs(snapshot, { providers: harness.app.providers });
    assert.deepEqual(mapping.blockers, []);
    assert.equal(mapping.intents.length, 4);
    assert.equal(mapping.skipped.length, 0);
    assert.equal(mapping.unboundReferenceCount > 0, true);
    // Prompts arrive from the spec instructions here and nowhere else.
    assert.equal(mapping.intents[0].addSceneVersion.prompt, snapshot.scenePlans[0].specs[0].instructions);
    assert.deepEqual(mapping.intents[0].addSceneVersion.references, []);
    assert.equal(mapping.intents[0].providerId, "mock");
    assert.equal(mapping.intents[0].requestGeneration.parameters.outputCount, 1);
    assert.deepEqual(mapping.intents[0].requires, ["imageGeneration", "referenceImages"]);
    // The keys are stable for the same content...
    const again = mapPlanToJobs(snapshot, { providers: harness.app.providers });
    assert.deepEqual(
      again.intents.map((intent) => [intent.sceneId, intent.jobKey]),
      mapping.intents.map((intent) => [intent.sceneId, intent.jobKey]),
    );
    // ...one execution scene per planned scene, so four specs on four scenes make four scenes, not eight.
    assert.equal(new Set(mapping.intents.map((intent) => intent.sceneId)).size, 4);
    // Nothing was executed: no scene, no version, no job, no queue entry.
    assert.equal(harness.repository.listProjectScenes("pilot").length, 0);
    assert.equal(harness.repository.listQueueItems().length, 0);
    assert.equal(harness.planning.listPlans("pilot").length, 1);

    // A re-plan with different content maps onto the same execution scenes but new job keys.
    const replanned = harness.plan({ options: { ...PLAN_OPTIONS, seed: 9 } });
    const replannedMapping = mapPlanToJobs(harness.app.planReads.snapshot(replanned.version.id), {
      providers: harness.app.providers,
      // A fresh re-plan is VALIDATED, not EXECUTABLE: the mapping itself does not care, and an operator
      // dry-running the seam must be able to see what it would produce.
      allowUnapproved: true,
    });
    assert.deepEqual(
      replannedMapping.intents.map((intent) => intent.sceneId),
      mapping.intents.map((intent) => intent.sceneId),
    );
    assert.notDeepEqual(
      replannedMapping.intents.map((intent) => intent.jobKey),
      mapping.intents.map((intent) => intent.jobKey),
    );
  } finally {
    await harness.close();
  }
});

test("a version that is not approved cannot be mapped, and the reason is stated", async () => {
  const harness = await createHarness();
  try {
    const run = harness.plan();
    const snapshot = harness.app.planReads.snapshot(run.version.id);
    const blocked = mapPlanToJobs(snapshot, { providers: harness.app.providers });
    assert.deepEqual(blocked.blockers, ["PLAN_NOT_APPROVED"]);
    assert.equal(blocked.intents.length, 0);
    const dry = mapPlanToJobs(snapshot, { providers: harness.app.providers, allowUnapproved: true });
    assert.equal(dry.intents.length, 4);
    // No provider registry at all is a refusal, not a guess.
    const unregistered = mapPlanToJobs(snapshot, { providers: new Map(), allowUnapproved: true });
    assert.equal(unregistered.intents.length, 0);
    assert.equal(unregistered.skipped.length, 4);
    assert.equal(unregistered.skipped[0].reason, "NO_CAPABLE_PROVIDER");
  } finally {
    await harness.close();
  }
});

test("write-only knobs do not change what the plan is", async () => {
  const harness = await createHarness();
  try {
    const plain = harness.plan();
    const quiet = harness.plan({ options: { ...PLAN_OPTIONS, includeTrace: false, replan: "in-place" } });
    assert.equal(quiet.outcome, "SUCCESS");
    assert.equal(quiet.reused, true, "a run that changes only *how* it writes is the same plan");
    assert.equal(quiet.planner.inputFingerprint, plain.planner.inputFingerprint);
    assert.equal(quiet.planner.outputFingerprint, plain.planner.outputFingerprint);
    // The seed is not a write knob: it changes the plan, so it changes both fingerprints.
    const seeded = harness.plan({ options: { ...PLAN_OPTIONS, seed: 4 } });
    assert.notEqual(seeded.planner.inputFingerprint, plain.planner.inputFingerprint);
  } finally {
    await harness.close();
  }
});

test("an invalid planner input is reported as a planning failure, not thrown at the caller", async () => {
  const harness = await createHarness();
  try {
    const run = harness.plan({ options: { ...PLAN_OPTIONS, aspectRatio: "cinematic" } });
    assert.equal(run.outcome, "PLANNING_FAILURE");
    assert.equal(run.errors.length, 1);
    assert.equal(run.errors[0].code, "PLANNER_INPUT_INVALID");
    assert.match(run.errors[0].field, /aspectRatio/u);
    assert.equal(run.plan, null);
    assert.equal(run.version, null);
    assert.equal(run.planner.inputFingerprint, "");
    assert.equal(harness.planning.listPlans("pilot").length, 0);
  } finally {
    await harness.close();
  }
});
