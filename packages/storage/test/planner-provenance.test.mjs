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
    assert.equal(harness.jobs.getSchemaVersion(), 6);
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

/* -------------------------------------------------------------------------- */
/* Phase 4C — AI proposal provenance                                            */
/* -------------------------------------------------------------------------- */

const AI = Object.freeze({
  adapter: "openai-chat",
  adapterVersion: "openai-chat-adapter-v1",
  provider: "openai-compatible",
  model: "some-model",
  schemaVersion: "ai-planning-proposal-v1",
  path: "ai-adapter",
  requestFingerprint: "d".repeat(64),
  proposalFingerprint: "e".repeat(64),
  responseFingerprint: "f".repeat(64),
  fallback: false,
});

test("v6 exposes the nullable AI provenance columns and keeps them outside the content hash", async () => {
  const harness = await createRepository();
  try {
    const columns = harness.db
      .prepare("PRAGMA table_info(production_plan_versions)")
      .all()
      .map((row) => ({ name: row.name, notNull: row.notnull === 1 }));
    const expected = [
      "ai_adapter",
      "ai_adapter_version",
      "ai_provider",
      "ai_model",
      "ai_schema_version",
      "ai_path",
      "ai_request_fingerprint",
      "ai_proposal_fingerprint",
      "ai_response_fingerprint",
      "ai_fallback",
    ];
    for (const name of expected) {
      const column = columns.find((entry) => entry.name === name);
      assert.ok(column, `expected column ${name}`);
      // A version nobody proposed with an AI must be representable without a placeholder row.
      assert.equal(column.notNull, false, `${name} must stay nullable`);
    }

    const { version } = seedPlan(harness.planning);
    assert.equal(version.ai, undefined);
    const before = harness.planning.planVersionContentHash(version.id);
    harness.planning.setPlanVersionProvenance({
      planVersionId: version.id,
      provenance: { ...PROVENANCE, ai: AI },
      now: NOW,
    });
    // How the input was produced is not the content: recording it must not invalidate evidence.
    assert.equal(harness.planning.planVersionContentHash(version.id), before);
    const stored = harness.planning.getPlanVersion(version.id);
    assert.deepEqual(stored.ai, AI);
    // The AI stage steps belong to the version's one trace, never to a second copy inside provenance.
    assert.equal("trace" in stored.ai, false);
    assert.equal(stored.plannerVersion, PROVENANCE.plannerVersion);
  } finally {
    await harness.close();
  }
});

test("AI provenance is all-or-nothing, on insert and on update", async () => {
  const harness = await createRepository();
  try {
    const { version } = seedPlan(harness.planning);
    // The repository refuses an incomplete tuple before it can reach SQL.
    for (const missing of ["model", "schemaVersion", "requestFingerprint", "proposalFingerprint"]) {
      const partial = { ...AI };
      delete partial[missing];
      assert.throws(
        () =>
          harness.planning.setPlanVersionProvenance({
            planVersionId: version.id,
            provenance: { ...PROVENANCE, ai: partial },
            now: NOW,
          }),
        undefined,
        `a tuple without ${missing} must be refused`,
      );
    }
    assert.equal(harness.planning.getPlanVersion(version.id).ai, undefined);
    assert.equal(
      harness.db.prepare("SELECT planner_version FROM production_plan_versions WHERE id = ?").get(version.id)
        .planner_version,
      null,
      "a refused write must not leave half a provenance record behind",
    );

    // Bypassing the repository is what the triggers exist for: half a set is refused either way.
    assert.throws(
      () => harness.db.prepare("UPDATE production_plan_versions SET ai_model = 'x' WHERE id = ?").run(version.id),
      /complete set/u,
    );
    assert.throws(
      () =>
        harness.db
          .prepare(
            `INSERT INTO production_plan_versions (id, plan_id, version_number, status, created_at, ai_adapter)
             VALUES ('tampered-version', 'plan-1', 99, 'DRAFT', ?, 'openai-chat')`,
          )
          .run(NOW),
      /complete set/u,
    );
    // The one field free to be NULL: no response to digest is a real state, not a half-written one.
    harness.planning.setPlanVersionProvenance({
      planVersionId: version.id,
      provenance: { ...PROVENANCE, ai: { ...AI, responseFingerprint: null } },
      now: NOW,
    });
    assert.equal(harness.planning.getPlanVersion(version.id).ai.responseFingerprint, null);
    assert.equal(harness.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    await harness.close();
  }
});

test("AI provenance identity is write-once, and only the response digest may be back-filled", async () => {
  const harness = await createRepository();
  try {
    const { version } = seedPlan(harness.planning);
    harness.planning.setPlanVersionProvenance({
      planVersionId: version.id,
      provenance: { ...PROVENANCE, ai: { ...AI, responseFingerprint: null } },
      now: NOW,
    });
    for (const column of ["ai_model", "ai_adapter", "ai_path", "ai_proposal_fingerprint", "ai_fallback"]) {
      assert.throws(
        () => harness.db.prepare(`UPDATE production_plan_versions SET ${column} = NULL WHERE id = ?`).run(version.id),
        /recorded once and never rewritten|complete set/u,
        `${column} must not be rewritable`,
      );
      assert.throws(
        () =>
          harness.db
            .prepare(`UPDATE production_plan_versions SET ${column} = CASE WHEN ${column} IS NULL THEN 'tampered' ELSE 'tampered' END WHERE id = ?`)
            .run(version.id),
        /recorded once/u,
        `${column} must not be replaceable`,
      );
    }
    // The documented exemption, and nothing else: a response digest may arrive later.
    harness.db
      .prepare("UPDATE production_plan_versions SET ai_response_fingerprint = ? WHERE id = ?")
      .run("a".repeat(64), version.id);
    assert.equal(harness.planning.getPlanVersion(version.id).ai.responseFingerprint, "a".repeat(64));
    // Content columns and planner provenance are untouched by any of the above.
    assert.equal(harness.planning.planVersionContentHash(version.id), harness.planning.getPlanVersion(version.id).contentHash);
    assert.equal(harness.planning.getPlanVersion(version.id).plannerSeed, 7);
  } finally {
    await harness.close();
  }
});
