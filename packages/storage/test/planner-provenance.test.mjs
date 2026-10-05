import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteJobRepository, SqlitePlanningRepository } from "../dist/index.js";

const NOW = "2026-04-01T00:00:00.000Z";

/**
 * Persistence tests for planning provenance (Phase 4B): the v5 columns on `production_plan_versions`,
 * the fresh-version write the planner authors into, and the two triggers that make provenance
 * write-once and all-or-nothing. These run against raw SQL as well as through the repository, because a
 * provenance record that a `UPDATE` could overwrite or half-write would not be evidence at all.
 */
async function createRepository() {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-planner-storage-"));
  const jobs = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
  const planning = new SqlitePlanningRepository(jobs);
  jobs.createProject({ id: "proj-1", name: "Planner", now: NOW });
  const brief = planning
    .createBrief({
      projectId: "proj-1",
      title: "Launch film",
      concept: "A rooftop chase at dawn",
      objective: "Feel momentum",
      audience: "Operators",
      tone: "Urgent",
      style: "Cinematic",
      constraints: [{ kind: "MUST", value: "no on-screen text" }],
      now: NOW,
    })
    .brief;
  return {
    directory,
    jobs,
    planning,
    db: jobs.database,
    brief,
    close: () => {
      jobs.close();
      return rm(directory, { recursive: true, force: true });
    },
  };
}

function seedPlan(planning, { planId = "plan-1", withDna = true } = {}) {
  const visualDnaId = withDna
    ? planning.createVisualDna({
        id: `dna-${planId}`,
        projectId: "proj-1",
        name: "dawn-grain",
        style: "35mm film look",
        palette: ["#0b1020"],
        lighting: "low key",
        composition: "centered thirds",
        cameraLanguage: "slow dolly",
        renderingStyle: "photoreal",
        atmosphere: "tense",
        now: NOW,
      }).visualDna.id
    : undefined;
  const created = planning.createPlanWithInitialVersion({
    id: planId,
    projectId: "proj-1",
    briefId: planning.listBriefs("proj-1")[0].id,
    title: `${planId} plan`,
    visualDnaId,
    now: NOW,
  });
  return { ...created, visualDnaId };
}

const PROVENANCE = Object.freeze({
  plannerVersion: "deterministic-planner-v1",
  rulesVersion: "planning-rules-v1",
  seed: 7,
  inputFingerprint: "a".repeat(64),
  outputFingerprint: "b".repeat(64),
  contentHash: "c".repeat(64),
  trace: [{ rule: "beat-decomposition", outcome: "APPLIED", subjects: ["01-open"], detail: "2 beat(s)" }],
});

test("v5 exposes the nullable provenance columns and keeps them outside the content hash", async () => {
  const harness = await createRepository();
  try {
    assert.equal(harness.jobs.getSchemaVersion(), 5);
    const columns = harness.db
      .prepare("PRAGMA table_info(production_plan_versions)")
      .all()
      .map((row) => ({ name: row.name, notNull: row.notnull === 1 }));
    const expected = [
      "planner_version",
      "planner_rules_version",
      "planner_seed",
      "planner_input_fingerprint",
      "planner_output_fingerprint",
      "planner_content_hash",
      "planner_trace_json",
    ];
    for (const name of expected) {
      const column = columns.find((entry) => entry.name === name);
      assert.ok(column, `expected column ${name}`);
      // Nullable: a version that was never planned must be representable without a placeholder.
      assert.equal(column.notNull, false, `${name} must stay nullable`);
    }
    const { version } = seedPlan(harness.planning);
    assert.equal(version.plannerVersion, undefined);
    const before = harness.planning.planVersionContentHash(version.id);
    const recorded = harness.planning.setPlanVersionProvenance({ planVersionId: version.id, provenance: PROVENANCE, now: NOW });
    assert.equal(recorded.created, true);
    // Provenance describes how content was produced; it is not content. Recording it must not invalidate
    // validation evidence or make a plan look edited.
    assert.equal(harness.planning.planVersionContentHash(version.id), before);
    const stored = harness.planning.getPlanVersion(version.id);
    assert.equal(stored.plannerVersion, PROVENANCE.plannerVersion);
    assert.equal(stored.plannerSeed, 7);
    assert.deepEqual(stored.plannerTrace, PROVENANCE.trace);
    assert.equal(stored.plannerContentHash, PROVENANCE.contentHash);
  } finally {
    await harness.close();
  }
});

test("createPlanVersion appends a fresh empty draft and repoints the plan", async () => {
  const harness = await createRepository();
  try {
    const seeded = seedPlan(harness.planning);
    harness.planning.addScenePlan({
      planVersionId: seeded.version.id,
      sceneKey: "open-01",
      sceneNumber: 1,
      title: "Arrival",
      narrativePurpose: "establish",
      now: NOW,
    });
    const next = harness.planning.createPlanVersion({
      planId: seeded.plan.id,
      predecessorVersionId: seeded.version.id,
      note: "re-planned",
      now: NOW,
    });
    assert.equal(next.version.versionNumber, 2);
    assert.equal(next.version.status, "DRAFT");
    assert.equal(next.version.predecessorVersionId, seeded.version.id);
    assert.equal(next.version.revisionNote, "re-planned");
    // A planner-authored version starts empty: it is written from the draft, not copied and edited.
    const snapshot = harness.planning.loadPlanVersionSnapshot(next.version.id);
    assert.equal(snapshot.scenePlans.length, 0);
    assert.equal(snapshot.specs.length, 0);
    assert.equal(snapshot.story, null);
    // It still inherits the aesthetic contract, which the validator requires the version to resolve.
    assert.equal(next.version.visualDnaId, seeded.visualDnaId);
    // The plan's current pointer moved, so a reader sees the new version without a second call.
    assert.equal(harness.planning.getPlan(seeded.plan.id).currentVersionId, next.version.id);
    assert.equal(harness.planning.listPlanVersions(seeded.plan.id).length, 2);
  } finally {
    await harness.close();
  }
});

test("createPlanVersion refuses lineage that is not an earlier version of the same plan", async () => {
  const harness = await createRepository();
  try {
    const first = seedPlan(harness.planning, { planId: "plan-a" });
    const second = seedPlan(harness.planning, { planId: "plan-b" });
    assert.throws(
      () =>
        harness.planning.createPlanVersion({
          planId: second.plan.id,
          predecessorVersionId: first.version.id,
          now: NOW,
        }),
      /not a version of/u,
    );
    // A predecessor that is not a version at all, and a plan that does not exist, are both refusals.
    assert.throws(
      () =>
        harness.planning.createPlanVersion({
          planId: first.plan.id,
          predecessorVersionId: "not-a-version",
          now: NOW,
        }),
      /Plan version not found/u,
    );
    assert.throws(() => harness.planning.createPlanVersion({ planId: "nope", now: NOW }), /nope/u);
    // Lineage to the newest version is exactly what a re-plan means, and it is accepted.
    const newest = harness.planning.listPlanVersions(first.plan.id).at(-1);
    const third = harness.planning.createPlanVersion({
      planId: first.plan.id,
      predecessorVersionId: newest.id,
      now: NOW,
    });
    assert.equal(third.version.versionNumber, newest.versionNumber + 1);
    assert.equal(third.version.predecessorVersionId, newest.id);
  } finally {
    await harness.close();
  }
});

test("provenance is recorded once, is idempotent when repeated identically, and refuses a different tuple", async () => {
  const harness = await createRepository();
  try {
    const { version } = seedPlan(harness.planning);
    const first = harness.planning.setPlanVersionProvenance({ planVersionId: version.id, provenance: PROVENANCE, now: NOW });
    assert.equal(first.created, true);
    const again = harness.planning.setPlanVersionProvenance({ planVersionId: version.id, provenance: PROVENANCE, now: NOW });
    assert.equal(again.created, false);
    assert.equal(again.version.plannerInputFingerprint, PROVENANCE.inputFingerprint);
    assert.throws(
      () =>
        harness.planning.setPlanVersionProvenance({
          planVersionId: version.id,
          provenance: { ...PROVENANCE, plannerVersion: "deterministic-planner-v2" },
          now: NOW,
        }),
      /already carries provenance/u,
    );
    // A different seed is a different plan, so it must not overwrite the first run's record either.
    assert.throws(
      () => harness.planning.setPlanVersionProvenance({ planVersionId: version.id, provenance: { ...PROVENANCE, seed: 8 }, now: NOW }),
      /already carries provenance/u,
    );
    assert.equal(harness.planning.getPlanVersion(version.id).plannerVersion, PROVENANCE.plannerVersion);
  } finally {
    await harness.close();
  }
});

test("provenance can only be written to an editable version", async () => {
  const harness = await createRepository();
  try {
    const { version } = seedPlan(harness.planning);
    harness.planning.addScenePlan({
      planVersionId: version.id,
      sceneKey: "open-01",
      sceneNumber: 1,
      title: "Arrival",
      now: NOW,
    });
    harness.planning.addGenerationSpec({ scenePlanId: harness.planning.loadPlanVersionSnapshot(version.id).scenePlans[0].scenePlan.id, kind: "image", instructions: "one", now: NOW });
    const validated = harness.planning.transitionPlanVersionStatus({ planVersionId: version.id, to: "VALIDATED", now: NOW });
    harness.planning.transitionPlanVersionStatus({ planVersionId: validated.id, to: "APPROVED", approvedBy: "ops", now: NOW });
    assert.throws(
      () => harness.planning.setPlanVersionProvenance({ planVersionId: validated.id, provenance: PROVENANCE, now: NOW }),
      /editable|APPROVED/u,
    );
    assert.equal(harness.planning.getPlanVersion(validated.id).plannerVersion, undefined);
  } finally {
    await harness.close();
  }
});

test("the database itself refuses to overwrite or half-write provenance", async () => {
  const harness = await createRepository();
  try {
    const { version } = seedPlan(harness.planning);
    harness.planning.setPlanVersionProvenance({ planVersionId: version.id, provenance: PROVENANCE, now: NOW });
    assert.throws(
      () =>
        harness.db
          .prepare("UPDATE production_plan_versions SET planner_seed = 9 WHERE id = ?")
          .run(version.id),
      /recorded once/u,
    );
    // Clearing it is just as forbidden: the record of who produced a plan is not retractable.
    assert.throws(
      () =>
        harness.db
          .prepare("UPDATE production_plan_versions SET planner_version = NULL WHERE id = ?")
          .run(version.id),
      /complete set/u,
    );
    // A partial tuple is rejected too: provenance that cannot name its rules or fingerprint is not evidence.
    const other = seedPlan(harness.planning, { planId: "plan-partial" }).version;
    assert.throws(
      () =>
        harness.db
          .prepare("UPDATE production_plan_versions SET planner_version = 'x' WHERE id = ?")
          .run(other.id),
      /complete set/u,
    );
    assert.equal(harness.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    await harness.close();
  }
});

test("a copied version carries no provenance, because a copy is not a planner run", async () => {
  const harness = await createRepository();
  try {
    const seeded = seedPlan(harness.planning);
    harness.planning.addScenePlan({
      planVersionId: seeded.version.id,
      sceneKey: "open-01",
      sceneNumber: 1,
      title: "Arrival",
      now: NOW,
    });
    harness.planning.setPlanVersionProvenance({ planVersionId: seeded.version.id, provenance: PROVENANCE, now: NOW });
    const copy = harness.planning.copyPlanVersion({ sourceVersionId: seeded.version.id, now: NOW });
    assert.equal(copy.version.plannerVersion, undefined);
    assert.equal(copy.version.plannerInputFingerprint, undefined);
    assert.equal(copy.version.plannerTrace, undefined);
    // The copy does carry the copied content, which is the point of `plan revise`.
    assert.equal(copy.copiedScenePlans, 1);
  } finally {
    await harness.close();
  }
});
