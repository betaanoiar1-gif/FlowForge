import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/**
 * Phase 5 operator surface: `plan execute`, `plan execution`, and `plan executions`.
 *
 * Each invocation is a separate process over one SQLite file, which is what makes these tests worth having
 * next to the service-level matrix: durability across "restarts" is not simulated here, it is the ordinary
 * way the CLI runs. The commands themselves stay thin — they read flags, call `app.planExecution`, and print
 * what the service returned. No execution engine lives in this file, and `plan execute` enqueues work for the
 * existing durable worker instead of performing any of it.
 */
async function createWorkspace() {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-plan-execution-cli-"));
  const dataDir = path.join(directory, "data");
  const run = (args, options = {}) => {
    const result = spawnSync(process.execPath, [CLI, ...args, ...(options.raw ? [] : ["--data-dir", dataDir])], {
      encoding: "utf8",
      timeout: 120_000,
    });
    const stdout = result.stdout ?? "";
    let payload;
    try {
      payload = stdout.trim() ? JSON.parse(stdout) : undefined;
    } catch {
      payload = undefined;
    }
    return {
      code: result.status,
      stdout,
      stderr: result.stderr ?? "",
      payload,
      data: () => payload?.data,
      error: () => payload,
    };
  };
  const json = (args) => run([...args, "--json"]);
  return { directory, dataDir, run, json, close: () => rm(directory, { recursive: true, force: true }) };
}

const STORY = JSON.stringify({
  premise: "A solo developer ships a launch teaser in an afternoon.",
  beginning: "A developer opens a blank project. Nothing works yet.",
  development: "The pipeline comes online. Shots queue in order. The first render lands.",
  ending: "The teaser ships and the signups arrive.",
});

/** Project, brief, definitions, and one EXECUTABLE plan version — the same recipe `planner run` documents. */
function prepare(workspace, { approve = true } = {}) {
  assert.equal(
    workspace.json(["project", "create", "--project-id", "pilot", "--name", "Pilot"]).code,
    0,
    "project create failed",
  );
  const brief = workspace.json([
    "brief",
    "create",
    "--project-id",
    "pilot",
    "--title",
    "Launch film",
    "--concept",
    "A launch teaser for a planning tool",
    "--objective",
    "Get signups",
    "--audience",
    "Indie developers",
    "--tone",
    "confident",
    "--style",
    "clean product film",
  ]);
  assert.equal(brief.code, 0, brief.stderr);
  assert.equal(
    workspace.json([
      "definition",
      "character-create",
      "--project-id",
      "pilot",
      "--character-id",
      "char-aya",
      "--name",
      "Aya",
      "--traits-json",
      '{"role":"protagonist","appearance":"red jacket","personality":"decisive"}',
      "--visual-identity-json",
      '{"description":"silver watch"}',
    ]).code,
    0,
    "character create failed",
  );
  assert.equal(
    workspace.json([
      "definition",
      "world-create",
      "--project-id",
      "pilot",
      "--world-id",
      "world-loft",
      "--name",
      "The loft",
      "--environment",
      "Three monitors and a cold brew",
    ]).code,
    0,
    "world create failed",
  );
  assert.equal(
    workspace.json([
      "definition",
      "dna-create",
      "--project-id",
      "pilot",
      "--visual-dna-id",
      "dna-grain",
      "--name",
      "grain",
      "--style",
      "35mm film look",
      "--palette-json",
      '["#0b1020","#c0392b"]',
      "--lighting",
      "low key",
      "--composition",
      "centred thirds",
      "--camera-language",
      "slow dolly",
      "--rendering-style",
      "photoreal",
      "--atmosphere",
      "tense",
      "--consistency-rules-json",
      '["keep the horizon level"]',
    ]).code,
    0,
    "dna create failed",
  );
  const planned = workspace.json([
    "planner",
    "run",
    "--project-id",
    "pilot",
    "--visual-dna-id",
    "dna-grain",
    "--story-json",
    STORY,
    "--cast-json",
    '[{"characterId":"char-aya","role":"the developer"}]',
    "--worlds-json",
    '[{"worldId":"world-loft"}]',
    "--options-json",
    '{"totalDurationMs":12000,"developmentScenes":1}',
    "--providers",
    "mock",
    ...(approve ? ["--approve", "--reviewer", "ops"] : []),
  ]);
  assert.equal(planned.code, 0, planned.stderr);
  return { planId: planned.data().plan.id, versionId: planned.data().version.id };
}

test("plan execute materializes an EXECUTABLE plan into queued work, and the existing worker executes it", async () => {
  const workspace = await createWorkspace();
  try {
    const { planId } = prepare(workspace);

    const dryRun = workspace.json(["plan", "execute", "--plan-id", planId, "--dry-run"]);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    assert.equal(dryRun.data().dryRun, true);
    assert.equal(dryRun.data().counts.queueItemsCreated, 0);
    assert.equal(workspace.json(["queue", "status"]).data().depth.total, 0, "a dry run enqueued nothing");
    assert.equal(workspace.json(["scene", "list", "--project-id", "pilot"]).data().length, 0);

    const executed = workspace.json(["plan", "execute", "--plan-id", planId]);
    assert.equal(executed.code, 0, executed.stderr);
    const report = executed.data();
    assert.equal(report.dryRun, false);
    assert.equal(report.created, true);
    assert.equal(report.counts.units, 3);
    assert.equal(report.counts.scenesCreated, 3);
    assert.equal(report.counts.jobsCreated, 3);
    assert.equal(report.counts.queueItemsCreated, 3);
    assert.equal(report.providerId, "mock");
    assert.equal(report.mappingScope.length > 0, true);
    assert.equal(report.units.every((unit) => unit.jobStatus === "QUEUED"), true);
    assert.deepEqual(report.units.map((unit) => unit.priority), [1000, 999, 998]);

    const depth = workspace.json(["queue", "status"]).data().depth;
    assert.equal(depth.total, 3);
    assert.equal(depth.queued, 3);

    const human = workspace.run(["plan", "execution", "--plan-id", planId]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /units 3 · queued 3 · running 0 · succeeded 0/u);
    assert.match(human.stdout, /next: flowforge queue run --max-jobs 3 executes the 3 queued item\(s\) with provider mock\./u);

    const run = workspace.json(["queue", "run", "--max-jobs", "3"]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.data().attempted, 3);
    assert.equal(run.data().results.every((row) => row.status === "SUCCEEDED"), true);
    assert.equal(run.data().results.every((row) => row.qcStatus === "PASSED"), true);

    const state = workspace.json(["plan", "execution", "--plan-id", planId]).data();
    assert.equal(state.executionId, report.executionId);
    assert.equal(state.providerId, "mock");
    assert.equal(state.rulesVersion, "plan-execution-v1");
    assert.equal(state.totals.succeeded, 3);
    assert.equal(state.totals.qcPassed, 3);
    assert.deepEqual(state.units.map((unit) => unit.queueStatus), ["ACKED", "ACKED", "ACKED"]);
    const reviewed = workspace.run(["plan", "execution", "--plan-id", planId]);
    assert.match(reviewed.stdout, /review approve/u, "once work is done, the report names the next explicit step");
    assert.equal(state.units.every((unit) => unit.assetVersionId), true);
    assert.equal(state.units.every((unit) => unit.reviewStatus === "PENDING"), true, "nothing self-approves");

    // And the plan itself is untouched by being materialized: still EXECUTABLE, still the current version.
    const status = workspace.json(["plan", "status", "--plan-id", planId]).data();
    assert.equal(status.version.status, "EXECUTABLE");
  } finally {
    await workspace.close();
  }
});

test("a second process materializes nothing new: same execution id, same fingerprint, same jobs", async () => {
  const workspace = await createWorkspace();
  try {
    const { planId } = prepare(workspace);
    const first = workspace.json(["plan", "execute", "--plan-id", planId]).data();
    const depthAfterFirst = workspace.json(["queue", "status"]).data().depth.total;

    const repeat = workspace.json(["plan", "execute", "--plan-id", planId]);
    assert.equal(repeat.code, 0, repeat.stderr);
    const second = repeat.data();
    assert.equal(second.created, false);
    assert.equal(second.executionId, first.executionId);
    assert.equal(second.executionFingerprint, first.executionFingerprint);
    assert.deepEqual(second.counts, { ...first.counts,
      scenesCreated: 0, scenesReused: 3, sceneVersionsCreated: 0, sceneVersionsReused: 3,
      jobsCreated: 0, jobsReused: 3, queueItemsCreated: 0 });
    assert.deepEqual(
      second.units.map((unit) => unit.jobId),
      first.units.map((unit) => unit.jobId),
    );
    assert.equal(workspace.json(["queue", "status"]).data().depth.total, depthAfterFirst, "no extra queue items");
    assert.equal(workspace.json(["scene", "list", "--project-id", "pilot"]).data().length, 3);

    const listed = workspace.json(["plan", "executions", "--plan-id", planId]);
    assert.equal(listed.data().length, 1, "one materialization recorded, not two");
    assert.match(workspace.run(["plan", "execute", "--plan-id", planId]).stdout, /already materialized/iu);
  } finally {
    await workspace.close();
  }
});

test("execution survives a process restart, because the queue and the links are durable", async () => {
  const workspace = await createWorkspace();
  try {
    const { planId } = prepare(workspace);
    const report = workspace.json(["plan", "execute", "--plan-id", planId]).data();
    // Every CLI call is a new process, so this *is* a restart test: the state read below is rebuilt from the
    // database, with nothing carried over from the process that wrote it.
    const state = workspace.json(["plan", "execution", "--plan-id", planId]).data();
    assert.equal(state.executionId, report.executionId);
    assert.equal(state.materializedAt, report.materializedAt);
    assert.deepEqual(
      state.units.map((unit) => unit.jobId),
      report.units.map((unit) => unit.jobId),
    );

    const run = workspace.json(["queue", "run", "--max-jobs", "2"]);
    assert.equal(run.code, 0, run.stderr);
    const halfDone = workspace.json(["plan", "execution", "--plan-id", planId]).data();
    assert.equal(halfDone.totals.succeeded, 2);
    assert.equal(halfDone.totals.queued, 1);
    assert.equal(halfDone.units.filter((unit) => unit.jobStatus === "SUCCEEDED").length, 2);

    const rest = workspace.json(["queue", "run", "--max-jobs", "5"]);
    assert.equal(rest.data().attempted, 1, "the remaining job only, because two were already ACKED");
    const done = workspace.json(["plan", "execution", "--plan-id", planId]).data();
    assert.equal(done.totals.succeeded, 3);
    assert.equal(done.totals.queued, 0);
  } finally {
    await workspace.close();
  }
});

test("a plan that is not EXECUTABLE is refused, with nothing created", async () => {
  const workspace = await createWorkspace();
  try {
    const { planId } = prepare(workspace, { approve: false });
    const status = workspace.json(["plan", "status", "--plan-id", planId]).data();
    assert.equal(status.version.status, "VALIDATED");

    const refused = workspace.json(["plan", "execute", "--plan-id", planId]);
    assert.equal(refused.code, 3, `expected the blocked exit code, got ${refused.code}: ${refused.stdout}`);
    assert.equal(refused.error().code, "EXECUTION_NOT_READY");
    assert.deepEqual(refused.error().details.blockers.map((blocker) => blocker.code), ["PLAN_NOT_EXECUTABLE"]);
    assert.match(refused.error().message, /Materialization requires EXECUTABLE/u);

    const dry = workspace.json(["plan", "execute", "--plan-id", planId, "--dry-run"]);
    assert.equal(dry.code, 3, "a blocked dry run is reported and still exits blocked, without throwing");
    assert.deepEqual(dry.data().blockers.map((blocker) => blocker.code), ["PLAN_NOT_EXECUTABLE"]);

    // No half-execution state exists to clean up.
    assert.equal(workspace.json(["scene", "list", "--project-id", "pilot"]).data().length, 0);
    assert.equal(workspace.json(["queue", "status"]).data().depth.total, 0);
    assert.equal(workspace.json(["plan", "executions", "--plan-id", planId]).data().length, 0);
    assert.match(workspace.run(["plan", "executions", "--plan-id", planId]).stdout, /no materialization recorded/u);
    assert.equal(workspace.json(["plan", "status", "--plan-id", planId]).data().version.status, "VALIDATED");
  } finally {
    await workspace.close();
  }
});

test("execution state is not guessed: asking before the first materialization is an explicit refusal", async () => {
  const workspace = await createWorkspace();
  try {
    const { planId } = prepare(workspace);
    const missing = workspace.json(["plan", "execution", "--plan-id", planId]);
    assert.equal(missing.code, 1, missing.stdout + missing.stderr);
    assert.equal(missing.error().code, "NOT_FOUND");
    assert.match(missing.error().message, /has not been materialized/iu);
    assert.match(missing.error().message, /run flowforge plan execute first/u);
    assert.match(workspace.run(["plan", "execution", "--plan-id", planId]).stderr, /plan execute/u);
  } finally {
    await workspace.close();
  }
});

test("flags reach the service: --max-attempts is stored on the jobs and --providers is enforced", async () => {
  const workspace = await createWorkspace();
  try {
    const { planId } = prepare(workspace);
    const report = workspace.json(["plan", "execute", "--plan-id", planId, "--max-attempts", "2"]).data();
    const items = workspace.json(["queue", "status"]).data().items;
    assert.equal(items.length, 3);
    assert.deepEqual(
      items.map((item) => item.jobId).sort(),
      report.units.map((unit) => unit.jobId).sort(),
      "the queue holds exactly the jobs the plan materialized",
    );
    const state = workspace.json(["plan", "execution", "--plan-id", planId]).data();
    assert.equal(state.units.every((unit) => unit.maxAttempts === 2), true, "--max-attempts reached the jobs");

    const widened = workspace.json(["plan", "execute", "--plan-id", planId, "--providers", "someone-else"]);
    assert.equal(widened.code, 3);
    assert.equal(widened.error().code, "EXECUTION_NOT_READY");
    assert.deepEqual(widened.error().details.blockers.map((blocker) => blocker.code), [
      "EXECUTION_PROVIDER_NOT_APPROVED",
    ]);

    const narrowed = workspace.json(["plan", "execute", "--plan-id", planId, "--providers", "mock"]);
    assert.equal(narrowed.code, 0, narrowed.stderr);
    assert.equal(narrowed.data().created, false, "the approved selection still matches the stored work");

    const missingArgs = workspace.run(["plan", "execute"]);
    assert.equal(missingArgs.code, 2);
    assert.match(missingArgs.stderr, /--plan-id/u);
  } finally {
    await workspace.close();
  }
});

test("review and selection stay explicit, and the execution report reflects them", async () => {
  const workspace = await createWorkspace();
  try {
    const { planId } = prepare(workspace);
    workspace.json(["plan", "execute", "--plan-id", planId]);
    workspace.json(["queue", "run", "--max-jobs", "3"]);
    const state = workspace.json(["plan", "execution", "--plan-id", planId]).data();
    const unit = state.units[0];
    assert.equal(unit.reviewStatus, "PENDING");
    assert.equal(state.totals.approved, 0);

    const approve = workspace.json(["review", "approve", "--asset-version-id", unit.assetVersionId, "--reviewer", "ops"]);
    assert.equal(approve.code, 0, approve.stderr);
    const select = workspace.json([
      "review",
      "select",
      "--scene-id",
      unit.sceneId,
      "--asset-version-id",
      unit.assetVersionId,
    ]);
    assert.equal(select.code, 0, select.stderr);

    const reviewed = workspace.json(["plan", "execution", "--plan-id", planId]).data();
    assert.equal(reviewed.totals.approved, 1);
    assert.equal(reviewed.totals.selected, 1);
    assert.deepEqual(
      reviewed.units.map((row) => [row.reviewStatus, row.selected]),
      [
        ["APPROVED", true],
        ["PENDING", false],
        ["PENDING", false],
      ],
    );
    const ready = workspace.json(["production", "scene", "--scene-id", unit.sceneId]).data();
    assert.equal(ready.productionReady, true);
    assert.equal(ready.blockers.length, 0);
  } finally {
    await workspace.close();
  }
});

test("the execution commands are advertised, and their own help explains the boundary", async () => {
  const workspace = await createWorkspace();
  try {
    const help = workspace.run(["help"], { raw: true });
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /plan execute --plan-id ID \[--version N\] \[--providers CSV\] \[--max-attempts N\] \[--dry-run\]/);
    assert.match(help.stdout, /plan execution --plan-id ID/);
    assert.match(help.stdout, /plan executions --plan-id ID/);
    assert.match(help.stdout, /Creates durable work; runs nothing\./u);
    // Nothing in the planning surface reaches a browser or a provider directly.
    assert.ok(!/plan (submit|generate|render|publish)/.test(help.stdout), "no direct execution verb exists");
    assert.ok(!/flow (submit|generate)/.test(help.stdout), "no Google Flow execution verb exists");

    const commandHelp = workspace.run(["plan", "execute", "--help"], { raw: true });
    assert.equal(commandHelp.code, 0, commandHelp.stderr);
    assert.match(commandHelp.stdout, /Usage:\n {2}flowforge plan execute --plan-id ID/u);
    assert.match(commandHelp.stdout, /--dry-run/u);
    assert.match(commandHelp.stdout, /durable worker|runs nothing/u);
  } finally {
    await workspace.close();
  }
});
