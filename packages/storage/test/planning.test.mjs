import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { SqliteJobRepository, SqlitePlanningRepository } from "../dist/index.js";

const NOW = "2026-02-01T00:00:00.000Z";
const LATER = "2026-02-02T00:00:00.000Z";

/**
 * Persistence tests for the creative planning domain (Phase 4A). These exercise the storage layer
 * directly — schema, uniqueness, foreign keys, idempotency, version copies, and the immutability
 * triggers — because those guarantees must hold even if a future caller bypasses the services.
 */
async function createRepository() {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-planning-storage-"));
  const jobs = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
  const planning = new SqlitePlanningRepository(jobs);
  const projectId = "proj-1";
  jobs.createProject({ id: projectId, name: "Planning", now: NOW });
  const otherProjectId = "proj-2";
  jobs.createProject({ id: otherProjectId, name: "Other", now: NOW });
  const db = jobs.database;
  return {
    directory,
    jobs,
    planning,
    db,
    projectId,
    otherProjectId,
    close: () => {
      jobs.close();
      return rm(directory, { recursive: true, force: true });
    },
  };
}

function seedBrief(planning, projectId, overrides = {}) {
  return planning.createBrief({
    projectId,
    title: "Launch film",
    concept: "A rooftop chase at dawn",
    objective: "Feel momentum",
    audience: "Operators",
    tone: "Urgent",
    style: "Cinematic",
    constraints: [{ kind: "MUST", value: "no on-screen text" }],
    now: NOW,
    ...overrides,
  }).brief;
}

function seedAuthoring(planning, { projectId, briefId, planId = "plan-1", planTitle = "Launch film plan" }) {
  const dna = planning.createVisualDna({
    id: "dna-1",
    projectId,
    name: "dawn-grain",
    style: "35mm film look",
    palette: ["#0b1020"],
    lighting: "low key",
    composition: "centered thirds",
    cameraLanguage: "slow dolly",
    renderingStyle: "photoreal",
    atmosphere: "tense",
    consistencyRules: ["keep the horizon level"],
    now: NOW,
  }).visualDna;
  const world = planning.createWorld({
    id: "world-1",
    projectId,
    name: "Rooftops",
    environment: "Dense rooftop grid",
    rules: ["no vehicles"],
    now: NOW,
  }).world;
  // A plan's identity is (project, brief, title); distinct titles keep seeded plans separate.
  const created = planning.createPlanWithInitialVersion({
    id: planId,
    projectId,
    briefId,
    title: planTitle,
    visualDnaId: dna.id,
    now: NOW,
  });
  return { dna, world, ...created };
}

test("the planning tables are created additively and the schema version advances to the current version", async () => {
  const harness = await createRepository();
  try {
    assert.equal(harness.jobs.getSchemaVersion(), 7);
    const names = harness.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    for (const table of [
      "creative_briefs",
      "production_plans",
      "production_plan_versions",
      "plan_stories",
      "worlds",
      "visual_dna",
      "scene_plans",
      "scene_plan_characters",
      "plan_version_characters",
      "generation_specs",
      "plan_validations",
    ]) {
      assert.ok(names.includes(table), `missing table ${table}`);
    }
    assert.deepEqual(harness.db.pragma("foreign_key_check"), []);
    assert.deepEqual(harness.db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
  } finally {
    await harness.close();
  }
});

test("a v3 database upgrades to the current schema version without touching existing rows", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-planning-upgrade-"));
  const file = path.join(directory, "flowforge.sqlite");
  try {
    const jobs = new SqliteJobRepository(file);
    jobs.createProject({ id: "legacy", name: "Legacy", description: "kept", now: NOW });
    const scene = jobs.createScene({ projectId: "legacy", title: "Opening", sceneNumber: 1, now: NOW });
    const version = jobs.createSceneVersion({
      sceneId: scene.id,
      prompt: "A lantern lights a stairwell.",
      now: NOW,
    });
    jobs.createGenerationJob({
      projectId: "legacy",
      sceneId: scene.id,
      sceneVersionId: version.id,
      provider: "mock",
      prompt: version.prompt,
      now: NOW,
    });
    jobs.close();

    // Pretend the file predates this phase, then let the current build migrate it forward.
    const raw = new Database(file);
    assert.equal(Number(raw.pragma("user_version", { simple: true })), 7);
    raw.pragma("user_version = 3");
    raw.close();

    const reopened = new SqliteJobRepository(file);
    assert.equal(reopened.getSchemaVersion(), 7);
    const project = reopened.getProject("legacy");
    assert.equal(project.description, "kept");
    assert.equal(reopened.listProjectScenes("legacy").length, 1);
    assert.equal(reopened.listSceneVersions(scene.id).length, 1);
    assert.equal(reopened.listGenerationJobs({ projectId: "legacy" }).length, 1);
    const planning = new SqlitePlanningRepository(reopened);
    const brief = seedBrief(planning, "legacy");
    assert.equal(brief.versionNumber, 1);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("brief snapshots are versioned, immutable, and idempotent by content", async () => {
  const harness = await createRepository();
  try {
    const first = seedBrief(harness.planning, harness.projectId);
    assert.equal(first.versionNumber, 1);
    assert.equal(first.status, "ACTIVE");

    const same = harness.planning.createBrief({
      projectId: harness.projectId,
      title: "Launch film",
      concept: "A rooftop chase at dawn",
      objective: "Feel momentum",
      audience: "Operators",
      tone: "Urgent",
      style: "Cinematic",
      constraints: [{ kind: "MUST", value: "no on-screen text" }],
      now: LATER,
    });
    assert.equal(same.created, false);
    assert.equal(same.brief.id, first.id, "identical content must reuse the snapshot");

    const second = seedBrief(harness.planning, harness.projectId, { title: "Launch film v2", now: LATER });
    assert.equal(second.versionNumber, 2);
    assert.equal(second.supersedesBriefId, first.id);
    assert.equal(harness.planning.getBrief(first.id).status, "SUPERSEDED");
    assert.equal(harness.planning.currentBrief(harness.projectId).id, second.id);

    assert.throws(
      () => harness.db.prepare("UPDATE creative_briefs SET title = 'x' WHERE id = ?").run(first.id),
      /creative brief snapshots are immutable/,
    );
    assert.throws(
      () => harness.db.prepare("DELETE FROM creative_briefs WHERE id = ?").run(first.id),
      /cannot be deleted/,
    );
    // Re-activating a superseded snapshot is refused: history is append-only.
    assert.throws(
      () => harness.db.prepare("UPDATE creative_briefs SET status = 'ACTIVE' WHERE id = ?").run(first.id),
      /immutable/,
    );
  } finally {
    await harness.close();
  }
});

test("an aggregate writes atomically and every child keeps project ownership", async () => {
  const harness = await createRepository();
  try {
    const brief = seedBrief(harness.planning, harness.projectId);
    const { planning } = harness;
    const { version } = seedAuthoring(planning, { projectId: harness.projectId, briefId: brief.id });

    planning.upsertStory({ planVersionId: version.id, premise: "A courier crosses the grid", structure: "three-act", beginning: "a", development: "b", ending: "c", now: NOW });
    const character = harness.jobs.createCharacter({ id: "char-1", projectId: harness.projectId, name: "Aya", now: NOW });
    planning.setCharacterIdentity({
      characterId: character.id,
      traits: { appearance: "red jacket", personality: "decisive" },
      visualIdentity: { description: "silver watch", distinguishingFeatures: ["watch"], palette: ["#c0392b"] },
      now: NOW,
    });
    planning.replacePlanCast({ planVersionId: version.id, cast: [{ characterId: character.id, role: "lead" }], now: NOW });

    const scenePlan = planning.addScenePlan({
      planVersionId: version.id,
      sceneKey: "open-01",
      sceneNumber: 1,
      title: "Arrival",
      narrativePurpose: "Establish the grid",
      worldId: "world-1",
      continuity: [{ statement: "streets are wet" }],
      cast: [{ characterId: character.id, role: "lead" }],
      now: NOW,
    }).scenePlan;
    const spec = planning.addGenerationSpec({
      scenePlanId: scenePlan.id,
      kind: "image",
      instructions: "Wide rooftop establishing shot",
      outputCount: 1,
      aspectRatio: "16:9",
      requiredCapabilities: ["imageGeneration"],
      now: NOW,
    }).spec;

    const snapshot = planning.loadPlanVersionSnapshot(version.id);
    assert.equal(snapshot.scenePlans.length, 1);
    assert.equal(snapshot.specs.length, 1);
    assert.equal(snapshot.cast.length, 1);
    assert.deepEqual(snapshot.scenePlans[0].specs.map((entry) => entry.id), [spec.id]);
    assert.equal(snapshot.characters[0].traits.appearance, "red jacket");
    assert.deepEqual(snapshot.worlds.map((world) => world.id), ["world-1"]);
    assert.match(version.contentHash, /^[0-9a-f]{64}$/);
    assert.notEqual(snapshot.version.contentHash, version.contentHash, "edits refresh the content hash");
    assert.equal(snapshot.version.contentHash, planning.planVersionContentHash(version.id));

    // Cross-project references are refused by the database itself.
    const foreignCharacter = harness.jobs.createCharacter({ id: "char-2", projectId: harness.otherProjectId, name: "Stranger", now: NOW });
    assert.throws(
      () => planning.replacePlanCast({ planVersionId: version.id, cast: [{ characterId: foreignCharacter.id, role: "cameo" }], now: NOW }),
      /must belong to the plan project/,
    );
    const foreignWorld = planning.createWorld({ id: "world-2", projectId: harness.otherProjectId, name: "Elsewhere", environment: "x", now: NOW }).world;
    assert.throws(
      () =>
        planning.addScenePlan({
          planVersionId: version.id,
          sceneKey: "open-99",
          sceneNumber: 99,
          title: "Elsewhere",
          worldId: foreignWorld.id,
          now: NOW,
        }),
      /must belong to the plan project/,
    );
    // Cast rows are still intact after the refused write (no partial aggregate).
    assert.deepEqual(
      planning.loadPlanVersionSnapshot(version.id).cast.map((link) => link.characterId),
      [character.id],
    );
  } finally {
    await harness.close();
  }
});

test("duplicate scene identity is refused and content identity is reused", async () => {
  const harness = await createRepository();
  try {
    const brief = seedBrief(harness.planning, harness.projectId);
    const { version } = seedAuthoring(harness.planning, { projectId: harness.projectId, briefId: brief.id });
    const first = harness.planning.addScenePlan({
      planVersionId: version.id,
      sceneKey: "open-01",
      sceneNumber: 1,
      title: "Arrival",
      narrativePurpose: "establish",
      now: NOW,
    });
    assert.equal(first.created, true);

    const repeat = harness.planning.addScenePlan({
      planVersionId: version.id,
      sceneKey: "open-01",
      sceneNumber: 1,
      title: "Arrival",
      narrativePurpose: "establish",
      now: LATER,
    });
    assert.equal(repeat.created, false, "identical content reuses the scene plan row");
    assert.equal(repeat.scenePlan.id, first.scenePlan.id);

    assert.throws(
      () =>
        harness.planning.addScenePlan({
          planVersionId: version.id,
          sceneKey: "open-02",
          sceneNumber: 1,
          title: "Clash",
          now: NOW,
        }),
      /conflicts with an existing scene plan at position 1/,
    );
    assert.throws(
      () =>
        harness.planning.addScenePlan({
          planVersionId: version.id,
          sceneKey: "open-01",
          sceneNumber: 4,
          title: "Key clash",
          now: NOW,
        }),
      /conflicts with an existing scene plan/,
    );

    const spec = harness.planning.addGenerationSpec({
      scenePlanId: first.scenePlan.id,
      kind: "image",
      instructions: "one",
      now: NOW,
    });
    const again = harness.planning.addGenerationSpec({
      scenePlanId: first.scenePlan.id,
      kind: "image",
      instructions: "one",
      now: LATER,
    });
    assert.equal(again.created, false);
    assert.equal(again.spec.id, spec.spec.id);
    const secondSpec = harness.planning.addGenerationSpec({
      scenePlanId: first.scenePlan.id,
      kind: "video",
      instructions: "two",
      now: NOW,
    });
    assert.equal(secondSpec.spec.specNumber, spec.spec.specNumber + 1);
  } finally {
    await harness.close();
  }
});

test("a version copy preserves scene keys, links lineage, and freezes the source", async () => {
  const harness = await createRepository();
  try {
    const brief = seedBrief(harness.planning, harness.projectId);
    const { version } = seedAuthoring(harness.planning, { projectId: harness.projectId, briefId: brief.id });
    harness.planning.upsertStory({ planVersionId: version.id, premise: "crossing", structure: "three-act", now: NOW });
    const scenePlan = harness.planning.addScenePlan({
      planVersionId: version.id,
      sceneKey: "open-01",
      sceneNumber: 1,
      title: "Arrival",
      narrativePurpose: "establish",
      now: NOW,
    }).scenePlan;
    harness.planning.addGenerationSpec({ scenePlanId: scenePlan.id, kind: "image", instructions: "one", now: NOW });
    const frozen = harness.planning.transitionPlanVersionStatus({ planVersionId: version.id, to: "VALIDATED", now: NOW });
    harness.planning.transitionPlanVersionStatus({ planVersionId: frozen.id, to: "APPROVED", approvedBy: "ops", now: NOW });
    const approved = harness.planning.getPlanVersion(frozen.id);
    const approvedSnapshot = harness.planning.loadPlanVersionSnapshot(approved.id);

    const copy = harness.planning.copyPlanVersion({ sourceVersionId: approved.id, revisionNote: "tighten", now: LATER });
    assert.equal(copy.version.versionNumber, 2);
    assert.equal(copy.version.predecessorVersionId, approved.id);
    assert.equal(copy.version.status, "DRAFT");
    assert.equal(copy.copiedScenePlans, 1);
    assert.equal(copy.copiedSpecs, 1);
    const copied = harness.planning.loadPlanVersionSnapshot(copy.version.id);
    assert.equal(copied.scenePlans[0].scenePlan.sceneKey, "open-01");
    assert.notEqual(copied.scenePlans[0].scenePlan.id, scenePlan.id, "children get new ids");
    assert.equal(
      copied.version.contentHash,
      approvedSnapshot.version.contentHash,
      "a faithful copy hashes identically to its source",
    );
    assert.equal(copied.story.premise, "crossing");

    // The approved version is untouched: same hash, same ids, no new children.
    const after = harness.planning.loadPlanVersionSnapshot(approved.id);
    assert.equal(after.version.contentHash, approvedSnapshot.version.contentHash);
    assert.equal(after.scenePlans.length, 1);
    assert.equal(harness.planning.getPlan("plan-1").currentVersionId, copy.version.id);

    // Editing the frozen source is refused at the database level, not just by the service.
    assert.throws(
      () =>
        harness.planning.addScenePlan({
          planVersionId: approved.id,
          sceneKey: "open-02",
          sceneNumber: 2,
          title: "Late",
          now: LATER,
        }),
      /cannot be edited in place|non-draft plan version/,
    );
    assert.throws(
      () => harness.db.prepare("DELETE FROM production_plan_versions WHERE id = ?").run(approved.id),
      /cannot be deleted/,
    );
    assert.throws(
      () =>
        harness.db.prepare("UPDATE production_plan_versions SET content_hash = 'x' WHERE id = ?").run(approved.id),
      /cannot be edited/,
    );
  } finally {
    await harness.close();
  }
});

test("validation evidence is append-only and unique per content state", async () => {
  const harness = await createRepository();
  try {
    const brief = seedBrief(harness.planning, harness.projectId);
    const { version } = seedAuthoring(harness.planning, { projectId: harness.projectId, briefId: brief.id });
    const findings = [
      { code: "SCENE_PLANS_EMPTY", severity: "ERROR", message: "no scene plans", subject: { kind: "planVersion", id: version.id } },
    ];
    const recorded = harness.planning.recordPlanValidation({
      planVersionId: version.id,
      validatorVersion: "planning-deterministic-v1",
      status: "FAILED",
      contentHash: version.contentHash,
      findings,
      now: NOW,
    });
    assert.equal(recorded.created, true);
    assert.equal(recorded.validation.errorCount, 1);
    assert.deepEqual(recorded.validation.findings, findings);

    const repeat = harness.planning.recordPlanValidation({
      planVersionId: version.id,
      validatorVersion: "planning-deterministic-v1",
      status: "FAILED",
      contentHash: version.contentHash,
      findings,
      now: LATER,
    });
    assert.equal(repeat.created, false, "the same content state reuses its evidence row");
    assert.equal(repeat.validation.id, recorded.validation.id);

    assert.throws(
      () => harness.db.prepare("UPDATE plan_validations SET status = 'PASSED' WHERE id = ?").run(recorded.validation.id),
      /immutable/,
    );
    assert.throws(
      () => harness.db.prepare("DELETE FROM plan_validations WHERE id = ?").run(recorded.validation.id),
      /immutable/,
    );
    assert.deepEqual(harness.planning.listPlanValidations(version.id).map((entry) => entry.id), [recorded.validation.id]);
    assert.equal(harness.planning.getLatestPlanValidation(version.id).status, "FAILED");
  } finally {
    await harness.close();
  }
});

test("lifecycle transitions are compare-and-set and clear approval on reopen", async () => {
  const harness = await createRepository();
  try {
    const brief = seedBrief(harness.planning, harness.projectId);
    const { version } = seedAuthoring(harness.planning, { projectId: harness.projectId, briefId: brief.id });
    assert.throws(
      () => harness.planning.transitionPlanVersionStatus({ planVersionId: version.id, to: "APPROVED", now: NOW }),
      /Invalid plan version status transition: DRAFT -> APPROVED/,
    );
    const validated = harness.planning.transitionPlanVersionStatus({ planVersionId: version.id, to: "VALIDATED", now: NOW });
    assert.equal(validated.status, "VALIDATED");
    const approved = harness.planning.transitionPlanVersionStatus({
      planVersionId: validated.id,
      to: "APPROVED",
      approvedBy: "ops",
      approvedValidationId: "validation-1",
      now: NOW,
    });
    assert.equal(approved.approvedBy, "ops");
    assert.equal(approved.approvedValidationId, "validation-1");
    const reopened = harness.planning.transitionPlanVersionStatus({ planVersionId: approved.id, to: "DRAFT", now: LATER });
    assert.equal(reopened.status, "DRAFT");
    assert.equal(reopened.approvedBy, undefined, "approval evidence is cleared when content reopens");
    assert.equal(reopened.approvedValidationId, undefined);
    const archived = harness.planning.transitionPlanVersionStatus({ planVersionId: reopened.id, to: "ARCHIVED", now: LATER });
    assert.equal(archived.status, "ARCHIVED");
    assert.throws(
      () => harness.planning.transitionPlanVersionStatus({ planVersionId: archived.id, to: "DRAFT", now: LATER }),
      /ARCHIVED -> DRAFT/,
    );
  } finally {
    await harness.close();
  }
});

test("the current version pointer can only address a version of the same plan", async () => {
  const harness = await createRepository();
  try {
    const brief = seedBrief(harness.planning, harness.projectId);
    const first = seedAuthoring(harness.planning, {
      projectId: harness.projectId,
      briefId: brief.id,
      planId: "plan-a",
      planTitle: "Plan A",
    });
    const second = seedAuthoring(harness.planning, {
      projectId: harness.projectId,
      briefId: brief.id,
      planId: "plan-b",
      planTitle: "Plan B",
    });
    assert.throws(
      () => harness.planning.setPlanCurrentVersion("plan-a", second.version.id, NOW),
      /is not a version of plan-a/,
    );
    const borrowed = harness.planning.copyPlanVersion({ sourceVersionId: second.version.id, now: LATER });
    assert.throws(
      () =>
        harness.db
          .prepare("UPDATE production_plans SET current_version_id = ? WHERE id = 'plan-a'")
          .run(borrowed.version.id),
      /current version must belong to the plan/,
    );
    const moved = harness.planning.copyPlanVersion({ sourceVersionId: first.version.id, now: LATER });
    assert.equal(harness.planning.getPlan("plan-a").currentVersionId, moved.version.id);
    assert.equal(harness.planning.listPlanVersions("plan-a").length, 2);
  } finally {
    await harness.close();
  }
});

test("plans pin the brief snapshot they were authored against", async () => {
  const harness = await createRepository();
  try {
    const brief = seedBrief(harness.planning, harness.projectId);
    const { plan } = seedAuthoring(harness.planning, { projectId: harness.projectId, briefId: brief.id });
    const revision = seedBrief(harness.planning, harness.projectId, { title: "Launch film v2", now: LATER });
    assert.equal(harness.planning.getBrief(brief.id).status, "SUPERSEDED");
    assert.equal(harness.planning.getPlan(plan.id).briefId, brief.id, "a plan never follows the project's newest brief");

    // A plan cannot be created against another project's brief.
    assert.throws(
      () =>
        harness.planning.createPlanWithInitialVersion({
          projectId: harness.otherProjectId,
          briefId: brief.id,
          title: "Borrowed",
          now: NOW,
        }),
      /brief must belong to the same project|belongs to another project/,
    );
    assert.equal(harness.planning.listPlans(harness.otherProjectId).length, 0);
  } finally {
    await harness.close();
  }
});

test("validation evidence ranks by append order, never by a random id", async () => {
  const harness = await createRepository();
  try {
    const brief = seedBrief(harness.planning, harness.projectId);
    const { version } = seedAuthoring(harness.planning, { projectId: harness.projectId, briefId: brief.id });
    const base = {
      planVersionId: version.id,
      validatorVersion: "planning-deterministic-v1",
      findings: [],
      // Same clock tick on purpose: two rows in one tick must still rank deterministically, because
      // approval and staleness are decided by whichever row the "latest" query returns.
      now: NOW,
    };
    const first = harness.planning.recordPlanValidation({ ...base, status: "PASSED", contentHash: "hash-one" });
    const second = harness.planning.recordPlanValidation({ ...base, status: "FAILED", contentHash: "hash-two" });
    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.notEqual(first.validation.id, second.validation.id);
    assert.equal(harness.planning.getLatestPlanValidation(version.id).id, second.validation.id);
    assert.equal(harness.planning.getLatestPlanValidation(version.id).contentHash, "hash-two");
    assert.deepEqual(
      harness.planning.listPlanValidations(version.id).map((entry) => entry.contentHash),
      ["hash-one", "hash-two"],
      "history is oldest to newest",
    );
  } finally {
    await harness.close();
  }
});

test("world and visual DNA definitions version by name and stay immutable", async () => {
  const harness = await createRepository();
  try {
    const first = harness.planning.createWorld({
      projectId: harness.projectId,
      name: "Rooftops",
      environment: "Dense grid",
      rules: ["no vehicles"],
      now: NOW,
    }).world;
    const second = harness.planning.createWorld({
      projectId: harness.projectId,
      name: "Rooftops",
      environment: "Dense grid at dusk",
      rules: ["no vehicles", "no drones"],
      now: LATER,
    }).world;
    assert.equal(second.versionNumber, 2);
    assert.equal(second.supersedesWorldId, first.id);
    assert.equal(harness.planning.getWorld(first.id).status, "SUPERSEDED");
    assert.throws(
      () => harness.db.prepare("UPDATE worlds SET environment = 'x' WHERE id = ?").run(second.id),
      /world definitions are immutable/,
    );

    const dnaOne = harness.planning.createVisualDna({
      projectId: harness.projectId,
      name: "grain",
      style: "35mm",
      palette: ["#111"],
      lighting: "low",
      composition: "thirds",
      cameraLanguage: "dolly",
      renderingStyle: "photoreal",
      atmosphere: "tense",
      now: NOW,
    }).visualDna;
    const dnaTwo = harness.planning.createVisualDna({
      projectId: harness.projectId,
      name: "grain",
      style: "65mm",
      palette: ["#222"],
      lighting: "low",
      composition: "thirds",
      cameraLanguage: "dolly",
      renderingStyle: "photoreal",
      atmosphere: "tense",
      now: LATER,
    }).visualDna;
    assert.equal(dnaTwo.versionNumber, 2);
    assert.equal(dnaTwo.supersedesDnaId, dnaOne.id);
    assert.throws(
      () => harness.db.prepare("UPDATE visual_dna SET style = 'x' WHERE id = ?").run(dnaTwo.id),
      /visual DNA definitions are immutable/,
    );
  } finally {
    await harness.close();
  }
});

test("story is one-per-version and scene cast positions stay unique", async () => {
  const harness = await createRepository();
  try {
    const brief = seedBrief(harness.planning, harness.projectId);
    const { version } = seedAuthoring(harness.planning, { projectId: harness.projectId, briefId: brief.id });
    const a = harness.planning.upsertStory({ planVersionId: version.id, premise: "first", now: NOW });
    const b = harness.planning.upsertStory({ planVersionId: version.id, premise: "second", now: LATER });
    assert.equal(a.id, b.id, "upsert replaces the single story row instead of adding one");
    assert.equal(b.premise, "second");

    const scenePlan = harness.planning.addScenePlan({
      planVersionId: version.id,
      sceneKey: "s-1",
      sceneNumber: 1,
      title: "One",
      now: NOW,
    }).scenePlan;
    const charA = harness.jobs.createCharacter({ id: "ca", projectId: harness.projectId, name: "A", now: NOW });
    const charB = harness.jobs.createCharacter({ id: "cb", projectId: harness.projectId, name: "B", now: NOW });
    harness.planning.replacePlanCast({
      planVersionId: version.id,
      cast: [
        { characterId: charA.id, role: "lead" },
        { characterId: charB.id, role: "support" },
      ],
      now: NOW,
    });
    const cast = harness.planning.replaceScenePlanCast({
      scenePlanId: scenePlan.id,
      cast: [
        { characterId: charB.id, role: "support", position: 5 },
        { characterId: charA.id, role: "lead", position: 0 },
        { characterId: charA.id, role: "duplicate-ignored" },
      ],
      now: NOW,
    });
    assert.deepEqual(cast.map((link) => link.characterId), [charA.id, charB.id]);
    assert.deepEqual(cast.map((link) => link.position), [0, 1], "positions are renumbered deterministically");
    assert.equal(new Set(cast.map((link) => link.position)).size, cast.length);
  } finally {
    await harness.close();
  }
});
