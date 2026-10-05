import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileSystemAssetStore } from "@flowforge/assets";
import { MockGenerationProvider } from "@flowforge/provider-mock";
import { LocalQueueWorker, SqliteJobQueue } from "@flowforge/queue";
import { SqliteJobRepository, SqlitePlanningRepository } from "@flowforge/storage";
import { createApplication, execution } from "../dist/index.js";

/**
 * Phase 5: materializing a plan into durable, recoverable execution work.
 *
 * These run against the real stack — SQLite, the durable queue, the local worker, the deterministic mock
 * provider, and the 4A/4B planning services — because the claim under test is not "a mapping produces
 * command-shaped objects" (Phase 4B proved that) but "planned work becomes and stays durable execution work
 * under the machinery Phase 1–3 already own": one transaction, one idempotent identity, one lease, one retry
 * budget, one asset, one review decision. A mocked repository would test the shape of the code, not the
 * behaviour of the system.
 *
 * The matrix mirrors the phase brief: happy path, idempotent materialization, restart, lease recovery,
 * retry, non-retryable failure, capability refusal, blocked plan, transaction rollback, and duplicate
 * claiming — plus the determinism, provenance, and security properties Phase 5 must not break.
 */

const NOW = "2026-07-01T00:00:00.000Z";
const IMAGE_ONLY = Object.freeze({
  imageGeneration: true,
  videoGeneration: false,
  referenceImages: true,
  startFrame: false,
  endFrame: false,
  batchGeneration: false,
});
const NO_IMAGE = Object.freeze({ ...IMAGE_ONLY, imageGeneration: false });
const STORY = {
  premise: "A solo developer ships a launch teaser in an afternoon.",
  beginning: "A developer opens a blank project. Nothing works yet.",
  development: "The pipeline comes online. Shots queue in order. The first render lands.",
  ending: "The teaser ships and the signups arrive.",
};
const PLAN_OPTIONS = { totalDurationMs: 12_000, developmentScenes: 1 };

async function createHarness(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-plan-execution-services-"));
  const dbPath = path.join(directory, "flowforge.sqlite");
  const open = (providers) => {
    const repository = new SqliteJobRepository(dbPath);
    const planning = new SqlitePlanningRepository(repository);
    const queue = new SqliteJobQueue(repository);
    const provider = new MockGenerationProvider({
      rootDir: path.join(directory, "mock-provider"),
      mode: options.mode,
      artifact: options.artifact,
      failAttempts: options.failAttempts,
    });
    const worker = new LocalQueueWorker(
      repository,
      queue,
      provider,
      new FileSystemAssetStore(path.join(directory, "assets")),
      { workerId: options.workerId ?? "phase5-worker", leaseMs: options.leaseMs ?? 60_000, retryDelayMs: 0, now: () => new Date(NOW) },
    );
    const app = createApplication(repository, {
      queue,
      worker: options.noWorker ? undefined : worker,
      workerProviderId: options.noWorker ? undefined : "mock",
      providers,
      now: () => new Date(options.now ?? NOW),
      planning,
      defaultMaxAttempts: options.defaultMaxAttempts,
    });
    return { repository, planning, queue, provider, worker, app };
  };

  const first = open(options.providers ?? [{ id: "mock", capabilities: options.capabilities ?? IMAGE_ONLY }]);
  const { repository, planning, app } = first;

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

  /** Plan the brief deterministically; `approve: true` also runs the 4A capability gate to EXECUTABLE. */
  const plan = (overrides = {}) =>
    app.planner.plan({
      projectId: "pilot",
      story: STORY,
      cast: [{ characterId: character.id, role: "the developer" }],
      worlds: [{ worldId: world.id }],
      visualDnaId: visualDna.id,
      options: PLAN_OPTIONS,
      providers: ["mock"],
      approve: true,
      ...overrides,
    });

  const materialize = (overrides = {}) => {
    const run = plan(overrides.plan ?? {});
    const report = app.planExecution.materialize({
      planId: run.plan.id,
      ...(overrides.execution ?? {}),
    });
    return { run, report };
  };

  const reopen = () => open(options.reopenProviders ?? [{ id: "mock", capabilities: options.capabilities ?? IMAGE_ONLY }]);

  const counts = () => ({
    scenes: repository.listProjectScenes("pilot").length,
    jobs: repository.countGenerationJobs(),
    queue: repository.queueSize(),
    attempts: repository.listQueueItems({}).length,
  });

  return {
    directory,
    dbPath,
    ...first,
    reopen,
    brief,
    character,
    world,
    visualDna,
    plan,
    materialize,
    counts,
    close: async () => {
      repository.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/* -------------------------------------------------------------------------- *
 * A — happy path: plan → materialize → queue → worker → asset → QC → review   *
 * -------------------------------------------------------------------------- */

test("an EXECUTABLE plan becomes durable queued work, and the existing worker turns it into QC-passing assets", async () => {
  const harness = await createHarness();
  try {
    const { run, report } = harness.materialize();
    assert.equal(run.outcome, "SUCCESS");
    assert.equal(run.version.status, "EXECUTABLE");
    assert.equal(report.dryRun, false);
    assert.equal(report.created, true);
    assert.equal(report.counts.units, 3);
    assert.equal(report.counts.scenesCreated, 3);
    assert.equal(report.counts.sceneVersionsCreated, 3);
    assert.equal(report.counts.jobsCreated, 3);
    assert.equal(report.counts.queueItemsCreated, 3);
    assert.equal(report.skipped.length, 0);
    assert.equal(report.blockers.length, 0);
    assert.deepEqual(harness.counts(), { scenes: 3, jobs: 3, queue: 3, attempts: 3 });

    // Every unit is linked back to the plan row it executes — the bridge is recorded, not implied.
    for (const unit of report.units) {
      const version = harness.repository.getSceneVersion(unit.sceneVersionId);
      assert.equal(version.planExecutionId, report.executionId);
      assert.equal(version.planVersionId, run.version.id);
      assert.equal(version.scenePlanId, unit.scenePlanId);
      assert.equal(version.generationSpecId, unit.specId);
      const job = harness.repository.getGenerationJob(unit.jobId);
      assert.equal(job.planExecutionId, report.executionId);
      assert.equal(job.request.provider, "mock");
      assert.equal(job.status, "QUEUED");
    }

    // Materialization enqueued; it did not execute. Nothing ran before the operator drove the worker.
    assert.equal(report.units.every((unit) => unit.jobStatus === "QUEUED"), true);

    const execution = await harness.app.execution.drain();
    assert.equal(execution.attempted, 3);
    assert.deepEqual(execution.results.map((row) => row.status), ["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]);
    assert.equal(execution.results.every((row) => row.qcStatus === "PASSED"), true);
    const state = harness.app.planExecution.status({ planId: run.plan.id });
    assert.equal(state.totals.succeeded, 3);
    assert.equal(state.totals.qcPassed, 3);
    assert.equal(state.totals.approved, 0, "review is never granted by materialization or by execution");
    assert.equal(state.totals.selected, 0);
    assert.equal(state.units.every((unit) => unit.queueStatus === "ACKED"), true);

    // The last steps stay explicit operator commands, exactly as in Phase 3.
    const first = state.units[0];
    assert.equal(first.jobStatus, "SUCCEEDED");
    harness.app.reviews.decide({ assetVersionId: first.assetVersionId, decision: "APPROVED", reviewer: "tester" });
    harness.app.reviews.select({ sceneId: first.sceneId, assetVersionId: first.assetVersionId });
    assert.equal(harness.app.production.readiness(first.sceneId).productionReady, true);
    assert.match(state.hints.join(" "), /review approve/u);
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------- *
 * B — idempotent materialization                                               *
 * -------------------------------------------------------------------------- */

test("materializing the same plan version twice reuses every row and writes nothing the second time", async () => {
  const harness = await createHarness();
  try {
    const { run, report } = harness.materialize();
    const before = harness.counts();
    const repeat = harness.app.planExecution.materialize({ planId: run.plan.id });

    assert.equal(repeat.created, false, "the materialization record already exists");
    assert.equal(repeat.executionId, report.executionId);
    assert.equal(repeat.executionFingerprint, report.executionFingerprint);
    assert.deepEqual(
      repeat.units.map((unit) => [unit.sceneKey, unit.sceneVersionId, unit.jobId]),
      report.units.map((unit) => [unit.sceneKey, unit.sceneVersionId, unit.jobId]),
    );
    assert.equal(repeat.units.every((unit) => unit.scene === "REUSED"), true);
    assert.equal(repeat.units.every((unit) => unit.sceneVersion === "REUSED"), true);
    assert.equal(repeat.units.every((unit) => unit.job === "REUSED"), true);
    assert.deepEqual(repeat.counts, { ...report.counts,
      scenesCreated: 0, scenesReused: 3, sceneVersionsCreated: 0, sceneVersionsReused: 3,
      jobsCreated: 0, jobsReused: 3, queueItemsCreated: 0 });
    assert.deepEqual(harness.counts(), before, "no scene, no version, no job, no queue item appeared");
    assert.equal(harness.repository.listQueueItems({ statuses: ["QUEUED"] }).length, 3, "one queue item per unit, still three");
    assert.equal(harness.app.planExecution.executions({ planId: run.plan.id }).length, 1);
    assert.match(repeat.nextAction, /already materialized/iu);
  } finally {
    await harness.close();
  }
});

test("a dry run reports the whole materialization and commits nothing", async () => {
  const harness = await createHarness();
  try {
    const run = harness.plan();
    const dryRun = harness.app.planExecution.materialize({ planId: run.plan.id, dryRun: true });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.executionId, null);
    assert.equal(dryRun.counts.units, 3);
    assert.equal(dryRun.counts.jobsCreated, 3, "it predicts the work that a real run would enqueue");
    assert.equal(dryRun.counts.queueItemsCreated, 0);
    assert.deepEqual(harness.counts(), { scenes: 0, jobs: 0, queue: 0, attempts: 0 });
    // A dry run is not a promise about a later model or planner call, and it says so.
    assert.equal(dryRun.notices.some((notice) => notice.code === "DRY_RUN"), true);

    const real = harness.app.planExecution.materialize({ planId: run.plan.id });
    assert.equal(real.executionFingerprint, dryRun.executionFingerprint, "same inputs, same identity");
    assert.deepEqual(
      real.units.map((unit) => unit.sceneVersionId),
      dryRun.units.map((unit) => unit.sceneVersionId),
      "the predicted deterministic ids are the ids that were written",
    );
    assert.deepEqual(harness.counts(), { scenes: 3, jobs: 3, queue: 3, attempts: 3 });
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------- *
 * C — restart                                                                 *
 * -------------------------------------------------------------------------- */

test("a restarted process materializes the same plan into the same rows, not a second copy", async () => {
  const harness = await createHarness();
  let reopened = null;
  try {
    const { run, report } = harness.materialize();
    const before = harness.counts();
    harness.repository.close();

    reopened = harness.reopen();
    const after = reopened.app.planExecution.materialize({ planId: run.plan.id });
    assert.equal(after.created, false);
    assert.equal(after.executionFingerprint, report.executionFingerprint);
    assert.deepEqual(
      after.units.map((unit) => unit.jobId),
      report.units.map((unit) => unit.jobId),
    );
    assert.equal(after.units.every((unit) => unit.job === "REUSED"), true);
    assert.equal(reopened.repository.countGenerationJobs(), before.jobs);

    // The durable state the new process reports is the same state, read back rather than recomputed.
    const state = reopened.app.planExecution.status({ planId: run.plan.id });
    assert.equal(state.executionId, report.executionId);
    assert.equal(state.totals.queued, 3);
    await reopened.app.execution.drain();
    assert.equal(reopened.repository.countGenerationJobs(), before.jobs, "running did not duplicate work either");
  } finally {
    reopened?.repository.close();
    await rm(harness.directory, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- *
 * D + J — leases, duplicate claims, and no duplicate execution                 *
 * -------------------------------------------------------------------------- */

test("an unexpired lease blocks a second claim, and expiry returns the same job to the queue", async () => {
  const harness = await createHarness();
  const again = null;
  try {
    const { report } = harness.materialize();
    const first = harness.queue.claimNext("worker-a", 60_000, NOW);
    assert.ok(first);
    const second = harness.queue.claimNext("worker-b", 60_000, NOW);
    const third = harness.queue.claimNext("worker-c", 60_000, NOW);
    assert.ok(second && third);
    assert.equal(
      new Set([first.job.id, second.job.id, third.job.id]).size,
      3,
      "a claim never hands two workers the same job",
    );
    assert.equal(harness.queue.claimNext("worker-d", 60_000, NOW), null, "all three are leased");
    assert.equal(harness.repository.getQueueItemByJob(first.job.id).workerId, "worker-a");
    assert.equal(first.attempt.attemptNumber, 1, "the claim opened the job's first attempt");
    assert.equal(harness.repository.countGenerationJobs(), 3, "claiming does not create work");

    const recovered = harness.app.execution.recoverLeases();
    assert.equal(recovered.recoveredLeases, 0, "the lease has not expired at the fixed clock");

    // A worker that dies mid-lease must not lose the job: recovery returns the *same* job to the queue.
    harness.repository.close();
    const reopened = harness.reopen();
    try {
      const later = "2026-07-01T02:00:00.000Z";
      assert.equal(reopened.queue.recoverExpiredLeases(later), 3, "all three expired leases are recovered");
      const reclaimed = reopened.queue.claimNext("worker-e", 60_000, later);
      assert.ok(reclaimed);
      assert.deepEqual(
        [first.job.id, second.job.id, third.job.id].sort(),
        report.units.map((unit) => unit.jobId).sort(),
        "the three jobs are the plan's three units",
      );
      assert.equal(reclaimed.job.id, first.job.id, "the highest-priority leased job comes back first");
      assert.equal(reclaimed.attempt.id, first.attempt.id, "expiry resumes the same attempt, it does not restart it");
      assert.equal(reclaimed.attempt.attemptNumber, 1);
      assert.equal(reclaimed.queueItem.claimCount >= 2, true, "the claim was counted, not the job duplicated");
      assert.ok(
        [first.job.id, second.job.id, third.job.id].includes(reclaimed.job.id),
        "recovery requeues existing work instead of forking it",
      );
      assert.equal(reopened.repository.countGenerationJobs(), 3);
      assert.equal(reopened.repository.queueSize(), 3);

    } finally {
      reopened.repository.close();
    }
  } finally {
    await rm(harness.directory, { recursive: true, force: true });
  }
});

test("materialize, execute, materialize again, restart, and recover produce no duplicate work", async () => {
  const harness = await createHarness();
  try {
    const { run } = harness.materialize();
    await harness.app.execution.drain();
    harness.app.planExecution.materialize({ planId: run.plan.id });
    await harness.app.execution.drain();
    harness.app.planExecution.materialize({ planId: run.plan.id });

    assert.equal(harness.repository.countGenerationJobs(), 3);
    const versions = harness.repository.listProjectScenes("pilot").flatMap((scene) =>
      harness.repository.listSceneVersions(scene.id).map((version) => version.id),
    );
    assert.equal(new Set(versions).size, 3);
    const assets = [];
    for (const versionId of versions) {
      assets.push(...harness.repository.listAssetVersionsForSceneVersion(versionId).map((asset) => asset.id));
    }
    assert.equal(assets.length, 3, "one asset version per scene version, however many times it is materialized");
    const state = harness.app.planExecution.status({ planId: run.plan.id });
    assert.equal(state.totals.succeeded, 3);
    assert.equal(state.units.every((unit) => unit.attemptCount === 1), true, "no extra attempts either");
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------- *
 * E + F — retry semantics stay per job                                         *
 * -------------------------------------------------------------------------- */

test("a retryable provider failure retries inside the same job, with a new attempt and no new job", async () => {
  const harness = await createHarness({ mode: "TRANSIENT_FAILURE", failAttempts: 1, defaultMaxAttempts: 3 });
  try {
    const { report } = harness.materialize();
    const jobId = report.units[0].jobId;
    const execution = await harness.app.execution.drain();
    assert.equal(execution.attempted, 6, "three jobs, each attempted twice");
    assert.deepEqual(
      execution.results.map((row) => row.status),
      ["QUEUED", "SUCCEEDED", "QUEUED", "SUCCEEDED", "QUEUED", "SUCCEEDED"],
    );
    assert.equal(new Set(execution.results.map((row) => row.jobId)).size, 3, "the same three jobs, not six");
    assert.equal(
      execution.results.filter((row) => row.status === "QUEUED").every((row) => row.attemptNumber === 1),
      true,
      "the failed attempts are recorded as attempt 1, then requeued",
    );

    const job = harness.repository.getGenerationJob(jobId);
    assert.equal(job.status, "SUCCEEDED");
    assert.equal(job.attemptCount, 2, "attempt 1 failed transiently, attempt 2 succeeded");
    const attempts = harness.repository.listGenerationAttempts(jobId);
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["FAILED", "SUCCEEDED"]);
    assert.equal(harness.repository.countGenerationJobs(), 3, "retry never forks a job");
  } finally {
    await harness.close();
  }
});

test("a non-retryable provider failure stops at one attempt, and the plan work stays inspectable", async () => {
  const harness = await createHarness({ mode: "PERMANENT_FAILURE" });
  try {
    const { report } = harness.materialize();
    const execution = await harness.app.execution.drain();
    assert.equal(execution.results.every((row) => row.status === "FAILED"), true);
    for (const unit of report.units) {
      const job = harness.repository.getGenerationJob(unit.jobId);
      assert.equal(job.status, "FAILED");
      assert.equal(job.attemptCount, 1, "a permanent failure is not retried in a loop");
      assert.equal(harness.repository.listGenerationAttempts(unit.jobId).length, 1);
      assert.equal(harness.repository.getQueueItemByJob(unit.jobId).status, "FAILED");
    }
    const state = harness.app.planExecution.status({ planId: report.planId });
    assert.equal(state.totals.failed, 3);
    assert.match(state.hints.join(" "), /flowforge retry/u, "the report names the existing repair command");
  } finally {
    await harness.close();
  }
});

test("a QC failure is recorded as a QC failure, and never requeues or fabricates approval", async () => {
  const harness = await createHarness({ artifact: "INVALID_PNG" });
  try {
    const { report } = harness.materialize();
    await harness.app.execution.drain();
    const unit = report.units[0];
    const state = harness.app.planExecution.status({ planId: report.planId });
    assert.equal(state.totals.qcFailed, 3);
    assert.equal(state.totals.approved, 0);
    assert.equal(state.units[0].qcStatus, "FAILED");
    assert.equal(harness.repository.getGenerationJob(unit.jobId).status, "SUCCEEDED", "the provider did its job");
    assert.equal(state.units[0].selected, false);
    assert.match(state.hints.join(" "), /selection and readiness stay blocked/iu);
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------- *
 * G — the capability gate runs before any work is burned                      *
 * -------------------------------------------------------------------------- */

test("a provider that cannot satisfy the plan is refused before a single job is created", async () => {
  const harness = await createHarness();
  try {
    const run = harness.plan();
    // Same database, provider registry that can no longer serve an image: registration can drift after
    // approval, and materialization must re-check rather than trust the version's stamp.
    harness.repository.close();
    const drifted = openWith(harness, []);
    try {
      const error = captureError(() => drifted.app.planExecution.materialize({ planId: run.plan.id }));
      assert.equal(error.code, "EXECUTION_CAPABILITY_UNAVAILABLE");
      // Every blocker is capability-attributable, and at least one names the capability that is missing:
      // a provider set that cannot serve the plan is refused as a capability problem, not as a generic one.
      const codes = new Set(error.details.blockers.map((blocker) => blocker.code));
      assert.deepEqual(
        [...codes].sort(),
        ["EXECUTION_CAPABILITY_UNAVAILABLE", "PLAN_HAS_NO_EXECUTABLE_UNITS"],
      );
      assert.match(error.message, /imageGeneration/u);
      assert.deepEqual(drifted.counts(), { scenes: 0, jobs: 0, queue: 0, attempts: 0 });
    } finally {
      drifted.repository.close();
    }
  } finally {
    await rm(harness.directory, { recursive: true, force: true });
  }
});

test("an incapable provider is refused even when it is registered", async () => {
  const harness = await createHarness();
  try {
    const run = harness.plan();
    harness.repository.close();
    const incapable = openWith(harness, [{ id: "mock", capabilities: NO_IMAGE }]);
    try {
      const error = captureError(() => incapable.app.planExecution.materialize({ planId: run.plan.id }));
      assert.equal(error.code, "EXECUTION_CAPABILITY_UNAVAILABLE");
      assert.match(error.message, /imageGeneration/u);
      assert.equal(incapable.repository.countGenerationJobs(), 0);
      // The readiness read says the same thing without throwing, because it is a question, not a command.
      const readiness = incapable.app.planExecution.readiness({ planId: run.plan.id });
      assert.equal(readiness.ready, false);
      assert.equal(readiness.capabilityBlocked, true);
    } finally {
      incapable.repository.close();
    }
  } finally {
    await rm(harness.directory, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- *
 * H — lifecycle is the only door                                              *
 * -------------------------------------------------------------------------- */

test("a plan that is not EXECUTABLE cannot be materialized, and an archived one never can be", async () => {
  const harness = await createHarness();
  try {
    const draft = harness.plan({ approve: false });
    assert.equal(draft.version.status, "VALIDATED");
    const draftError = captureError(() => harness.app.planExecution.materialize({ planId: draft.plan.id }));
    assert.equal(draftError.code, "EXECUTION_NOT_READY");
    // A draft is refused on lifecycle *and* on everything that follows from it, with no partial reporting of
    // a graph that was never approved; the report lists the whole set rather than the first complaint.
    // A draft is refused for its own reason: the per-spec consequences of "not EXECUTABLE" are suppressed so
    // the report names the cause instead of a list of symptoms.
    assert.deepEqual(draftError.details.blockers.map((blocker) => blocker.code), ["PLAN_NOT_EXECUTABLE"]);
    assert.deepEqual(harness.counts(), { scenes: 0, jobs: 0, queue: 0, attempts: 0 });

    // APPROVED is not enough either: the executability gate is what checked capabilities.
    harness.app.plans.approve({ planId: draft.plan.id });
    const approvedError = captureError(() => harness.app.planExecution.materialize({ planId: draft.plan.id }));
    assert.equal(approvedError.code, "EXECUTION_NOT_READY");
    assert.deepEqual(
      approvedError.details.blockers.map((blocker) => blocker.code),
      ["PLAN_NOT_EXECUTABLE"],
      "APPROVED is not EXECUTABLE, and that alone is the answer",
    );

    // A dry run answers the same question without throwing, so an operator can ask before trying.
    const dry = harness.app.planExecution.materialize({ planId: draft.plan.id, dryRun: true });
    assert.deepEqual(dry.blockers.map((blocker) => blocker.code), ["PLAN_NOT_EXECUTABLE"]);
    assert.match(dry.nextAction, /Blocked: PLAN_NOT_EXECUTABLE/u);

    harness.app.plans.markExecutable({ planId: draft.plan.id, providers: ["mock"] });
    harness.app.plans.archive({ planId: draft.plan.id, note: "superseded" });
    const archived = captureError(() => harness.app.planExecution.materialize({ planId: draft.plan.id }));
    assert.deepEqual(archived.details.blockers.map((blocker) => blocker.code), ["PLAN_ARCHIVED"]);
    assert.equal(harness.repository.countGenerationJobs(), 0);
  } finally {
    await harness.close();
  }
});

test("an EXECUTABLE version cannot be made stale, and a draft with stale evidence is refused on both counts", async () => {
  const harness = await createHarness();
  try {
    const { run } = harness.materialize();
    // §8: evidence must be current for the *same content hash*. That is already structurally guaranteed for
    // an EXECUTABLE version — the v4 immutability triggers refuse an edit — so the only way to get stale
    // evidence onto a materializable version would be to bypass the triggers. Assert the door is shut…
    const editError = captureError(() =>
      harness.app.plans.setStory({
        planId: run.plan.id,
        premise: "rewritten after approval",
        beginning: "a",
        development: "b",
        ending: "c",
      }),
    );
    assert.equal(editError.code, "PLAN_NOT_EDITABLE");

    // …and that the readiness report does name staleness when a plan *can* still be edited.
    const draft = harness.plan({ approve: false, planTitle: "Draft film" });
    assert.equal(draft.version.status, "VALIDATED");
    harness.app.plans.setStory({
      planId: draft.plan.id,
      premise: "A developer ships something else entirely",
      beginning: "a",
      development: "b",
      ending: "c",
    });
    const error = captureError(() => harness.app.planExecution.materialize({ planId: draft.plan.id }));
    assert.equal(error.code, "EXECUTION_NOT_READY");
    const codes = error.details.blockers.map((blocker) => blocker.code);
    assert.ok(codes.includes("VALIDATION_STALE"), codes.join(","));
    assert.ok(codes.includes("PLAN_NOT_EXECUTABLE"), codes.join(","));
    // The first run is untouched by all of this.
    assert.equal(harness.app.planExecution.status({ planId: run.plan.id }).totals.queued, 3);
  } finally {
    await harness.close();
  }
});

test("widening the provider set beyond the approved one is refused, not silently accepted", async () => {
  const harness = await createHarness();
  try {
    const { run } = harness.materialize();
    const error = captureError(() =>
      harness.app.planExecution.materialize({ planId: run.plan.id, providers: ["someone-else"] }),
    );
    assert.equal(error.code, "EXECUTION_NOT_READY");
    assert.equal(error.details.blockers[0].code, "EXECUTION_PROVIDER_NOT_APPROVED");
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------- *
 * I — a mid-materialization failure leaves no half-built graph                *
 * -------------------------------------------------------------------------- */

test("an injected write failure mid-materialization rolls back every row of that run", async () => {
  const harness = await createHarness();
  try {
    const run = harness.plan();
    const repository = harness.repository;
    const original = repository.createSceneVersion.bind(repository);
    let writes = 0;
    repository.createSceneVersion = (input) => {
      writes += 1;
      if (writes === 2) throw new Error("injected mid-materialization failure");
      return original(input);
    };
    const error = captureError(() => harness.app.planExecution.materialize({ planId: run.plan.id }));
    assert.match(error.message, /injected mid-materialization failure/u);
    assert.equal(writes, 2, "it really did fail partway through, after a first unit was written");

    // Zero partial execution records: not one scene, version, job, queue item, or materialization row.
    assert.deepEqual(harness.counts(), { scenes: 0, jobs: 0, queue: 0, attempts: 0 });
    assert.deepEqual(repository.listPlanExecutionsForVersion(run.version.id), []);

    // And the retry after the failure is a clean full materialization, not a repair of debris.
    repository.createSceneVersion = original;
    const report = harness.app.planExecution.materialize({ planId: run.plan.id });
    assert.equal(report.counts.scenesCreated, 3);
    assert.equal(report.counts.jobsCreated, 3);
    assert.equal(report.created, true);
    assert.deepEqual(harness.counts(), { scenes: 3, jobs: 3, queue: 3, attempts: 3 });
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------- *
 * determinism, provenance, and security boundaries                           *
 * -------------------------------------------------------------------------- */

test("a revised plan version materializes as distinguishable new work without rewriting the first run", async () => {
  const harness = await createHarness();
  try {
    const { run, report } = harness.materialize();
    const firstVersions = report.units.map((unit) => unit.sceneVersionId);
    const firstJobs = report.units.map((unit) => unit.jobId);

    const revised = harness.app.planner.plan({
      projectId: "pilot",
      planTitle: run.plan.title,
      story: { ...STORY, beginning: "A developer opens a blank project and a timer starts." },
      cast: [{ characterId: harness.character.id, role: "the developer" }],
      worlds: [{ worldId: harness.world.id }],
      visualDnaId: harness.visualDna.id,
      options: PLAN_OPTIONS,
      providers: ["mock"],
      approve: true,
    });
    assert.notEqual(revised.version.id, run.version.id, "a revision is a new version, not an edit");
    const second = harness.app.planExecution.materialize({ planId: revised.plan.id });
    assert.equal(second.created, true);
    assert.notEqual(second.executionFingerprint, report.executionFingerprint);
    assert.notEqual(second.executionId, report.executionId);
    assert.deepEqual(
      harness.app.planExecution.executions({ planId: revised.plan.id, versionNumber: 1 }).map((row) => row.id),
      [report.executionId],
      "the first version keeps exactly the materialization it had",
    );
    assert.deepEqual(
      harness.app.planExecution.executions({ planId: revised.plan.id, versionNumber: 2 }).map((row) => row.id),
      [second.executionId],
      "the revision's materialization is recorded against the new version",
    );

    // Old history is never rewritten: the first run's versions still name the first plan version, its jobs
    // are the same rows, and the new run added versions rather than replacing them.
    for (const [index, versionId] of firstVersions.entries()) {
      assert.equal(harness.repository.getSceneVersion(versionId).planVersionId, run.version.id);
      assert.equal(harness.repository.getGenerationJob(firstJobs[index]).planExecutionId, report.executionId);
    }
    const allVersions = harness.repository
      .listProjectScenes("pilot")
      .flatMap((scene) => harness.repository.listSceneVersions(scene.id).map((version) => version.id));
    assert.equal(allVersions.length, 6, "three versions from the first run, three from the second");
    assert.equal(new Set(allVersions).size, 6);
    assert.equal(harness.repository.countGenerationJobs(), 6);
  } finally {
    await harness.close();
  }
});

test("execution identity ignores leases, priorities, clocks, and write-only knobs", async () => {
  const harness = await createHarness();
  try {
    const run = harness.plan();
    const first = harness.app.planExecution.materialize({ planId: run.plan.id, maxAttempts: 2, now: "2026-08-08T08:08:08.000Z" });
    const second = harness.app.planExecution.materialize({ planId: run.plan.id });
    assert.equal(second.executionFingerprint, first.executionFingerprint);
    assert.equal(second.executionId, first.executionId, "a later clock or retry budget does not fork the work");
    assert.equal(harness.repository.getGenerationJob(first.units[0].jobId).maxAttempts, 2);
    assert.equal(
      harness.repository.getGenerationJob(second.units[0].jobId).maxAttempts,
      2,
      "the existing job is reused, not re-created with a new retry budget",
    );

    // The same plan version, assessed through the pure helpers, yields the same identity with no database.
    const snapshot = harness.planning.loadPlanVersionSnapshot(run.version.id);
    const providers = new Map([["mock", { id: "mock", capabilities: IMAGE_ONLY }]]);
    const pure = execution.buildExecutionMapping(snapshot, { providers }, ["mock"]);
    assert.equal(pure.executionFingerprint, first.executionFingerprint);
    const again = execution.buildExecutionMapping(snapshot, { providers }, ["mock"]);
    assert.equal(again.executionFingerprint, pure.executionFingerprint);
    assert.deepEqual(
      again.units.map((unit) => [unit.sceneKey, unit.priority, unit.dependsOn]),
      first.units.map((unit) => [unit.sceneKey, unit.priority, unit.dependsOn]),
    );
    // Priorities descend with scene order, and each unit names the scene plan before it.
    assert.deepEqual(first.units.map((unit) => unit.priority), [1000, 999, 998]);
    assert.deepEqual(first.units.map((unit) => unit.dependsOn.length), [0, 1, 1]);
  } finally {
    await harness.close();
  }
});

test("the deterministic execution modules stay pure: no clock, no randomness, no I/O, no provider", async () => {
  const source = await import("node:fs");
  const forbidden = [
    ["Date.now", /Date\.now\s*\(/u],
    ["new Date", /new Date\s*\(/u],
    ["randomUUID", /randomUUID/u],
    ["Math.random", /Math\.random/u],
    ["node:fs", /node:fs/u],
    ["node:sqlite", /node:sqlite/u],
    ["node:net or http", /node:(net|http|https|dns|tls)/u],
    ["child_process", /child_process/u],
    ["provider imports", /@flowforge\/provider-/u],
    ["queue imports", /@flowforge\/queue/u],
    ["browser imports", /@flowforge\/browser|playwright|chromium/u],
  ];
  const files = [
    "execution/execution-idempotency.ts",
    "execution/execution-mapping.ts",
    "execution/execution-readiness.ts",
  ];
  for (const file of files) {
    const text = source
      .readFileSync(path.join(process.cwd(), "src", file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "");
    for (const [label, pattern] of forbidden) {
      assert.equal(pattern.test(text), false, `${file} must not use ${label}`);
    }
  }
});

test("no credential, endpoint, or prompt-secret leaks into persisted execution state", async () => {
  const harness = await createHarness();
  try {
    const { report } = harness.materialize();
    await harness.app.execution.drain();
    const db = harness.repository.database;
    const suspicious = /api[_-]?key|authorization|bearer |cookie|password|secret|sk-[a-z0-9]/iu;
    const scanned = [
      ["plan_executions", "*"],
      ["scene_versions", "*"],
      ["generation_jobs", "*"],
      ["queue_items", "*"],
      ["assets", "*"],
      ["asset_versions", "*"],
    ];
    const hits = [];
    for (const [table, columns] of scanned) {
      for (const row of db.prepare(`SELECT ${columns} FROM ${table}`).all()) {
        const text = JSON.stringify(row);
        if (suspicious.test(text)) hits.push(`${table}: ${text.slice(0, 120)}`);
      }
    }
    assert.deepEqual(hits, []);
    // The report itself is safe to log for the same reason: identities and digests, never secrets.
    const rendered = JSON.stringify(report);
    assert.equal(suspicious.test(rendered), false);
    assert.match(rendered, /"providerId":"mock"/u);
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------- *
 * helpers                                                                     *
 * -------------------------------------------------------------------------- */

function captureError(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the command to be refused, and it was accepted");
}

/** Opens a second application over the same database, with a different provider registry. */
function openWith(harness, providers) {
  const repository = new SqliteJobRepository(harness.dbPath);
  const planning = new SqlitePlanningRepository(repository);
  const queue = new SqliteJobQueue(repository);
  const app = createApplication(repository, {
    queue,
    providers,
    now: () => new Date(NOW),
    planning,
  });
  return {
    repository,
    planning,
    queue,
    app,
    counts: () => ({
      scenes: repository.listProjectScenes("pilot").length,
      jobs: repository.countGenerationJobs(),
      queue: repository.queueSize(),
      attempts: repository.listQueueItems({}).length,
    }),
  };
}
