import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteJobRepository, SqlitePlanningRepository } from "../dist/index.js";

const NOW = "2026-06-01T00:00:00.000Z";

/**
 * Persistence tests for plan materialization (Phase 5): the v7 `plan_executions` table, the nullable link
 * columns on `scene_versions` and `generation_jobs`, and `transaction()` — the one primitive that lets a
 * service group several reviewed writes into a single all-or-nothing unit.
 *
 * Several cases run raw SQL as well as the repository, on purpose. A link that a caller could half-write,
 * overwrite, or delete around is not a durable record of what was materialized, and the guarantee that
 * matters here is the one the database enforces regardless of who is holding the handle.
 */
async function createHarness() {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-plan-execution-"));
  const jobs = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
  const planning = new SqlitePlanningRepository(jobs);
  jobs.createProject({ id: "proj-1", name: "Execution", now: NOW });
  const brief = planning
    .createBrief({
      projectId: "proj-1",
      title: "Launch film",
      concept: "A rooftop chase at dawn",
      objective: "Feel momentum",
      audience: "Operators",
      tone: "Urgent",
      style: "Cinematic",
      now: NOW,
    })
    .brief;
  const dna = planning
    .createVisualDna({
      id: "dna-1",
      projectId: "proj-1",
      name: "dawn-grain",
      style: "35mm film look",
      palette: ["#0b1020"],
      lighting: "low key",
      composition: "centered thirds",
      cameraLanguage: "slow dolly",
      renderingStyle: "photoreal",
      now: NOW,
    })
    .visualDna;
  const { plan, version } = planning.createPlanWithInitialVersion({
    id: "plan-1",
    projectId: "proj-1",
    briefId: brief.id,
    title: "Launch film plan",
    visualDnaId: dna.id,
    now: NOW,
  });
  const scenePlan = planning
    .addScenePlan({
      id: "scene-plan-1",
      planVersionId: version.id,
      sceneKey: "rooftop",
      sceneNumber: 1,
      title: "Rooftop",
      narrativePurpose: "Open the piece",
      description: "A figure reaches the roof",
      visualDnaId: dna.id,
      now: NOW,
    })
    .scenePlan;
  const spec = planning
    .addGenerationSpec({
      id: "spec-1",
      scenePlanId: scenePlan.id,
      kind: "image",
      instructions: "Wide shot of a rooftop at dawn",
      outputCount: 1,
      aspectRatio: "16:9",
      now: NOW,
    })
    .spec;
  return {
    directory,
    jobs,
    planning,
    db: jobs.database,
    brief,
    plan,
    version,
    scenePlan,
    spec,
    close: () => {
      jobs.close();
      return rm(directory, { recursive: true, force: true });
    },
  };
}

function executionRow(overrides = {}) {
  return {
    id: "exec-1",
    projectId: "proj-1",
    planId: "plan-1",
    planVersionId: "plan-1-v1",
    executionFingerprint: "fp-1",
    rulesVersion: "plan-execution-v1",
    mappingScope: "scope-1",
    providerId: "mock",
    sceneCount: 1,
    sceneVersionCount: 1,
    jobCount: 1,
    reusedJobCount: 0,
    now: NOW,
    ...overrides,
  };
}

test("v7 adds one table and five nullable link columns without touching earlier rows", async () => {
  const harness = await createHarness();
  try {
    assert.equal(harness.jobs.getSchemaVersion(), 7);
    const tableNames = harness.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    assert.ok(tableNames.includes("plan_executions"));
    for (const [table, column] of [
      ["scene_versions", "plan_execution_id"],
      ["scene_versions", "plan_version_id"],
      ["scene_versions", "scene_plan_id"],
      ["scene_versions", "generation_spec_id"],
      ["generation_jobs", "plan_execution_id"],
    ]) {
      const columns = harness.db.pragma(`table_info(${table})`).map((entry) => entry.name);
      assert.ok(columns.includes(column), `${table}.${column} should exist`);
    }
    // A scene version created by hand before Phase 5 has no link, and reads back without one: absent is an
    // ordinary state here, not a defect.
    harness.jobs.createScene({ id: "scene-hand", projectId: "proj-1", title: "Hand", sceneNumber: 40, now: NOW });
    const version = harness.jobs.createSceneVersion({
      sceneId: "scene-hand",
      prompt: "Hand-authored prompt",
      now: NOW,
    });
    assert.equal(version.planExecutionId, undefined);
    assert.equal(version.planVersionId, undefined);
  } finally {
    await harness.close();
  }
});

test("a materialization record is written once and reusing the same fingerprint writes nothing", async () => {
  const harness = await createHarness();
  try {
    const first = harness.jobs.createPlanExecutionWithCreated(
      executionRow({ planVersionId: harness.version.id }),
    );
    assert.equal(first.created, true);
    assert.equal(first.execution.status, "MATERIALIZED");
    assert.equal(first.execution.jobCount, 1);
    assert.equal(first.execution.createdAt, NOW);

    const second = harness.jobs.createPlanExecutionWithCreated(
      executionRow({ planVersionId: harness.version.id, now: "2027-01-01T00:00:00.000Z" }),
    );
    assert.equal(second.created, false);
    assert.equal(second.execution.id, first.execution.id);
    // The timestamp of a materialization is the moment it *happened*, so a reuse must not restamp it.
    assert.equal(second.execution.createdAt, NOW);

    // A different fingerprint is a different body of work: distinguishable, never folded into the first row.
    const third = harness.jobs.createPlanExecutionWithCreated(
      executionRow({ planVersionId: harness.version.id, executionFingerprint: "fp-2", id: "exec-2" }),
    );
    assert.equal(third.created, true);
    assert.deepEqual(
      harness.jobs.listPlanExecutionsForVersion(harness.version.id).map((row) => row.executionFingerprint),
      ["fp-1", "fp-2"],
    );
  } finally {
    await harness.close();
  }
});

test("a fingerprint that describes different work is refused rather than reused", async () => {
  const harness = await createHarness();
  try {
    harness.jobs.createPlanExecutionWithCreated(executionRow({ planVersionId: harness.version.id }));
    assert.throws(
      () =>
        harness.jobs.createPlanExecutionWithCreated(
          executionRow({ planVersionId: harness.version.id, jobCount: 9, id: "exec-other" }),
        ),
      /fingerprint collision/i,
    );
    // The refused call wrote nothing, and the stored row is unchanged.
    assert.equal(harness.jobs.listPlanExecutionsForVersion(harness.version.id).length, 1);
    assert.equal(harness.jobs.getPlanExecution("exec-other"), null);
  } finally {
    await harness.close();
  }
});

test("materialization records are immutable, and ownership is checked at insert", async () => {
  const harness = await createHarness();
  try {
    harness.jobs.createPlanExecutionWithCreated(executionRow({ planVersionId: harness.version.id }));
    assert.throws(
      () =>
        harness.db
          .prepare("UPDATE plan_executions SET job_count = 99 WHERE id = 'exec-1'")
          .run(),
      /plan executions are immutable/i,
    );
    assert.throws(
      () => harness.db.prepare("DELETE FROM plan_executions WHERE id = 'exec-1'").run(),
      /plan executions cannot be deleted/i,
    );
    assert.throws(
      () =>
        harness.jobs.createPlanExecutionWithCreated(
          executionRow({ planVersionId: harness.version.id, projectId: "proj-elsewhere" }),
        ),
      /must match the plan version's project/i,
    );
    assert.throws(
      () => harness.jobs.createPlanExecutionWithCreated(executionRow({ planVersionId: "nope" })),
      /Plan version not found/i,
    );
    assert.equal(harness.jobs.listPlanExecutionsForVersion(harness.version.id).length, 1);
  } finally {
    await harness.close();
  }
});

test("a scene version plan link is all four columns or none, enforced by the database", async () => {
  const harness = await createHarness();
  try {
    harness.jobs.createPlanExecutionWithCreated(executionRow({ planVersionId: harness.version.id }));
    harness.jobs.createScene({ id: "scene-1", projectId: "proj-1", title: "Rooftop", sceneNumber: 1, now: NOW });

    const version = harness.jobs.createSceneVersion({
      id: "sv-1",
      sceneId: "scene-1",
      prompt: "Wide shot of a rooftop at dawn",
      planLink: {
        planExecutionId: "exec-1",
        planVersionId: harness.version.id,
        scenePlanId: harness.scenePlan.id,
        generationSpecId: harness.spec.id,
      },
      now: NOW,
    });
    assert.equal(version.planExecutionId, "exec-1");
    assert.equal(version.scenePlanId, harness.scenePlan.id);
    assert.equal(version.generationSpecId, harness.spec.id);

    // Half a link is not evidence, so the trigger refuses it even for a caller that bypassed the repository.
    assert.throws(
      () =>
        harness.db
          .prepare(
            `INSERT INTO scene_versions (id, scene_id, version_number, prompt, references_json, created_at, plan_execution_id)
             VALUES ('sv-bad', 'scene-1', 5, 'x', '[]', @now, 'exec-1')`,
          )
          .run({ now: NOW }),
      /complete set/i,
    );
    // The repository refuses the same shape before SQL, with a field-named message.
    assert.throws(
      () =>
        harness.jobs.createSceneVersion({
          sceneId: "scene-1",
          prompt: "another",
          planLink: { planExecutionId: "exec-1", planVersionId: "", scenePlanId: "a", generationSpecId: "b" },
          now: NOW,
        }),
      /plan link field planVersionId is required/i,
    );
    // And the link is part of a deterministic id's identity: the same id with a different origin conflicts.
    assert.throws(
      () =>
        harness.jobs.createSceneVersion({
          id: "sv-1",
          sceneId: "scene-1",
          prompt: "Wide shot of a rooftop at dawn",
          planLink: {
            planExecutionId: "exec-1",
            planVersionId: harness.version.id,
            scenePlanId: "other-scene-plan",
            generationSpecId: harness.spec.id,
          },
          now: NOW,
        }),
      /already exists with different content/i,
    );
  } finally {
    await harness.close();
  }
});

test("a job's plan execution link is recorded at insert and never amended", async () => {
  const harness = await createHarness();
  try {
    harness.jobs.createPlanExecutionWithCreated(executionRow({ planVersionId: harness.version.id }));
    harness.jobs.createScene({ id: "scene-1", projectId: "proj-1", title: "Rooftop", sceneNumber: 1, now: NOW });
    const version = harness.jobs.createSceneVersion({
      id: "sv-1",
      sceneId: "scene-1",
      prompt: "Wide shot of a rooftop at dawn",
      now: NOW,
    });
    const { job, created } = harness.jobs.createGenerationJobWithCreated({
      id: "job-1",
      projectId: "proj-1",
      sceneId: "scene-1",
      sceneVersionId: version.id,
      provider: "mock",
      planExecutionId: "exec-1",
      now: NOW,
    });
    assert.equal(created, true);
    assert.equal(job.planExecutionId, "exec-1");

    // Normal job mutation stays allowed — status and attempt bookkeeping must keep working — while the link
    // is frozen in both directions: neither changed nor added after the fact.
    assert.doesNotThrow(() =>
      harness.db.prepare("UPDATE generation_jobs SET attempt_count = attempt_count + 1 WHERE id = 'job-1'").run(),
    );
    assert.throws(
      () => harness.db.prepare("UPDATE generation_jobs SET plan_execution_id = 'exec-2' WHERE id = 'job-1'").run(),
      /recorded once and never rewritten/i,
    );
    assert.throws(
      () =>
        harness.db
          .prepare(`INSERT INTO generation_jobs (
              id, project_id, scene_id, scene_version_id, provider, prompt, references_json, metadata_json,
              idempotency_key, identity_json, parameters_json, status, attempt_count, max_attempts,
              plan_execution_id, created_at, updated_at
            ) VALUES ('job-bad', 'proj-1', 'scene-1', 'sv-1', 'mock', 'p', '[]', NULL, 'k-bad', '{}', '{}',
              'QUEUED', 0, 3, 'exec-missing', @now, @now)`)
          .run({ now: NOW }),
      /FOREIGN KEY/i,
    );
    assert.equal(harness.jobs.getGenerationJob("job-bad"), null);
  } finally {
    await harness.close();
  }
});

test("transaction() commits as one unit and rolls a failed unit back completely", async () => {
  const harness = await createHarness();
  try {
    harness.jobs.createPlanExecutionWithCreated(executionRow({ planVersionId: harness.version.id }));
    harness.jobs.createScene({ id: "scene-1", projectId: "proj-1", title: "Rooftop", sceneNumber: 1, now: NOW });
    harness.jobs.createSceneVersion({ id: "sv-1", sceneId: "scene-1", prompt: "committed", now: NOW });

    assert.throws(
      () =>
        harness.jobs.transaction(() => {
          harness.jobs.createScene({ id: "scene-2", projectId: "proj-1", title: "Half", sceneNumber: 2, now: NOW });
          harness.jobs.createSceneVersion({ id: "sv-2", sceneId: "scene-2", prompt: "doomed", now: NOW });
          harness.jobs.createGenerationJobWithCreated({
            id: "job-2",
            projectId: "proj-1",
            sceneId: "scene-2",
            sceneVersionId: "sv-2",
            provider: "mock",
            planExecutionId: "exec-1",
            now: NOW,
          });
          harness.jobs.createPlanExecutionWithCreated(
            executionRow({ id: "exec-3", planVersionId: harness.version.id, executionFingerprint: "fp-3" }),
          );
          throw new Error("injected mid-materialization failure");
        }),
      /injected mid-materialization failure/,
    );

    // Nothing survived: no scene, no version, no job, no queue item, no execution row.
    assert.equal(harness.jobs.getScene("scene-2"), null);
    assert.equal(harness.jobs.getSceneVersion("sv-2"), null);
    assert.equal(harness.jobs.getGenerationJob("job-2"), null);
    assert.equal(harness.jobs.getQueueItemByJob("job-2"), null);
    assert.equal(harness.jobs.getPlanExecution("exec-3"), null);
    assert.equal(harness.jobs.countGenerationJobs(), 0);
    // …and the pre-existing committed rows are untouched.
    assert.ok(harness.jobs.getSceneVersion("sv-1"));

    const committed = harness.jobs.transaction(() => {
      harness.jobs.createScene({ id: "scene-3", projectId: "proj-1", title: "Whole", sceneNumber: 3, now: NOW });
      harness.jobs.createSceneVersion({ id: "sv-3", sceneId: "scene-3", prompt: "whole", now: NOW });
      return harness.jobs.createGenerationJobWithCreated({
        id: "job-3",
        projectId: "proj-1",
        sceneId: "scene-3",
        sceneVersionId: "sv-3",
        provider: "mock",
        planExecutionId: "exec-1",
        now: NOW,
      });
    });
    assert.equal(committed.created, true);
    assert.equal(harness.jobs.countGenerationJobs(), 1);
    assert.equal(harness.jobs.getQueueItemByJob("job-3").status, "QUEUED");
  } finally {
    await harness.close();
  }
});

test("a caught inner failure rolls back only its own unit, which is what a savepoint is for", async () => {
  const harness = await createHarness();
  try {
    // Phase 5's materialization lets errors escape so the whole unit rolls back. This proves the *other*
    // half of the nesting contract the design relies on: an inner repository transaction that is handled
    // inside the outer one loses its own writes and keeps the outer transaction alive.
    const outcome = harness.jobs.transaction(() => {
      harness.jobs.createScene({ id: "scene-a", projectId: "proj-1", title: "A", sceneNumber: 5, now: NOW });
      let failed = false;
      try {
        harness.jobs.createScene({
          id: "scene-b",
          // A missing project makes the repository's own transaction throw.
          projectId: "no-such-project",
          title: "B",
          sceneNumber: 6,
          now: NOW,
        });
      } catch {
        failed = true;
      }
      harness.jobs.createScene({ id: "scene-c", projectId: "proj-1", title: "C", sceneNumber: 7, now: NOW });
      return { failed, a: Boolean(harness.jobs.getScene("scene-a")), b: Boolean(harness.jobs.getScene("scene-b")), c: Boolean(harness.jobs.getScene("scene-c")) };
    });
    assert.deepEqual(outcome, { failed: true, a: true, b: false, c: true });
  } finally {
    await harness.close();
  }
});

test("reads list what one materialization produced, in the plan's own order", async () => {
  const harness = await createHarness();
  try {
    harness.jobs.createPlanExecutionWithCreated(executionRow({ planVersionId: harness.version.id }));
    for (const [index, key] of ["second", "first"].entries()) {
      const sceneNumber = index === 0 ? 2 : 1;
      harness.jobs.createScene({
        id: `scene-${key}`,
        projectId: "proj-1",
        title: key,
        sceneNumber,
        now: NOW,
      });
      harness.jobs.createSceneVersion({
        id: `sv-${key}`,
        sceneId: `scene-${key}`,
        prompt: `prompt for ${key}`,
        planLink: {
          planExecutionId: "exec-1",
          planVersionId: harness.version.id,
          scenePlanId: harness.scenePlan.id,
          generationSpecId: harness.spec.id,
        },
        now: NOW,
      });
      harness.jobs.createGenerationJobWithCreated({
        id: `job-${key}`,
        projectId: "proj-1",
        sceneId: `scene-${key}`,
        sceneVersionId: `sv-${key}`,
        provider: "mock",
        planExecutionId: "exec-1",
        priority: index === 0 ? 1 : 2,
        now: NOW,
      });
    }
    assert.deepEqual(
      harness.jobs.listSceneVersionsByPlanExecution("exec-1").map((row) => row.prompt),
      ["prompt for first", "prompt for second"],
    );
    assert.deepEqual(
      harness.jobs
        .listGenerationJobs({ planExecutionId: "exec-1" })
        .map((job) => job.id)
        .sort(),
      ["job-first", "job-second"],
    );
    // A job that predates the plan (or was requested directly) carries no link and is not listed.
    assert.deepEqual(harness.jobs.listGenerationJobs({ planExecutionId: "exec-missing" }), []);
  } finally {
    await harness.close();
  }
});
