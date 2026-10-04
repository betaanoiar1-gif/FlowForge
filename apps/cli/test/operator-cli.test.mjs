import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/**
 * End-to-end operator-surface tests: every command below is exactly what an operator types, and
 * every assertion is made on the same read models the services return. No test touches a real
 * browser or Google Flow session; the flow provider is only ever configured, never executed.
 */
async function createWorkspace() {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-cli-"));
  const dataDir = path.join(directory, "data");
  const run = (args, options = {}) => {
    const result = spawnSync(process.execPath, [CLI, ...args, ...(options.raw ? [] : ["--data-dir", dataDir])], {
      encoding: "utf8",
      timeout: 60_000,
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

test("the operator CLI walks the whole pipeline from project to production-ready scene", async () => {
  const workspace = await createWorkspace();
  try {
    const project = workspace.json(["project", "create", "--project-id", "pilot", "--name", "Pilot"]);
    assert.equal(project.code, 0, project.stderr);
    assert.equal(project.data().status, "ACTIVE");

    const scene = workspace.json(["scene", "create", "--project-id", "pilot", "--scene-id", "scene-1", "--title", "Opening shot"]);
    assert.equal(scene.code, 0, scene.stderr);
    assert.equal(scene.data().sceneNumber, 1);

    const version = workspace.json([
      "scene",
      "version",
      "add",
      "--scene-id",
      "scene-1",
      "--prompt",
      "A lantern lights a dark stairwell at dusk.",
    ]);
    assert.equal(version.code, 0, version.stderr);
    assert.equal(version.data().versionNumber, 1);
    assert.equal(workspace.json(["scene", "show", "--scene-id", "scene-1"]).data().versions.length, 1);

    const generated = workspace.json([
      "generate",
      "--project-id",
      "pilot",
      "--scene-id",
      "scene-1",
      "--parameters-json",
      '{"size":3}',
    ]);
    assert.equal(generated.code, 0, generated.stderr);
    assert.equal(generated.data().created, true);
    assert.equal(generated.data().job.status, "QUEUED");
    assert.equal(generated.data().status.nextAction, "AWAIT_WORKER");
    const jobId = generated.data().job.id;

    const repeat = workspace.json(["generate", "--project-id", "pilot", "--scene-id", "scene-1", "--parameters-json", '{"size":3}']);
    assert.equal(repeat.data().created, false, "an identical operator command must reuse the durable job");
    assert.equal(repeat.data().job.id, jobId);

    const executed = workspace.json(["queue", "run", "--max-jobs", "1"]);
    assert.equal(executed.code, 0, executed.stderr);
    assert.equal(executed.data().attempted, 1);
    assert.equal(executed.data().results[0].status, "SUCCEEDED");
    assert.equal(executed.data().results[0].qcStatus, "PASSED");

    const status = workspace.json(["status", "--job-id", jobId]);
    assert.equal(status.data().job.status, "SUCCEEDED");
    assert.equal(status.data().outputs.length, 1);
    assert.equal(status.data().outputs[0].review.status, "PENDING");
    assert.equal(status.data().nextAction, "AWAIT_HUMAN_REVIEW");
    const assetVersionId = status.data().outputs[0].assetVersionId;

    const blocked = workspace.json(["production", "ready", "--scene-id", "scene-1"]);
    assert.equal(blocked.code, 3, "selection must be missing, and that is an operator-blocking state");
    assert.equal(blocked.error().code, "READINESS_NOT_SATISFIED");
    assert.deepEqual(blocked.error().details.blockers.map((blocker) => blocker.code), ["NO_SELECTED_ASSET_VERSION"]);

    assert.equal(workspace.json(["review", "approve", "--asset-version-id", assetVersionId, "--reviewer", "mina", "--comment", "Approved from the CLI test."]).code, 0);
    const selected = workspace.json(["review", "select", "--scene-id", "scene-1", "--asset-version-id", assetVersionId]);
    assert.equal(selected.data().readiness.productionReady, true);

    const ready = workspace.json(["production", "ready", "--scene-id", "scene-1"]);
    assert.equal(ready.code, 0, ready.stderr);
    assert.equal(ready.data().sceneStatus, "READY");
    assert.equal(ready.data().productionReady, true);

    const overview = workspace.json(["project", "show", "--project-id", "pilot"]);
    assert.equal(overview.data().totals.readyScenes, 1);
    assert.equal(overview.data().totals.jobsByStatus.SUCCEEDED, 1);
    assert.equal(overview.data().scenes[0].productionReady, true);
    assert.equal(workspace.json(["production", "project", "--project-id", "pilot"]).data().productionReady, true);
    assert.equal(workspace.json(["review", "selected", "--scene-id", "scene-1"]).data().assetVersionId, assetVersionId);
  } finally {
    await workspace.close();
  }
});

test("human output and JSON output are built from the same read models", async () => {
  const workspace = await createWorkspace();
  try {
    workspace.run(["project", "create", "--project-id", "pilot", "--name", "Pilot"]);
    workspace.run(["scene", "create", "--project-id", "pilot", "--scene-id", "scene-1", "--title", "Opening shot"]);
    workspace.run(["scene", "version", "add", "--scene-id", "scene-1", "--prompt", "A lantern lights a dark stairwell at dusk."]);
    workspace.run(["generate", "--project-id", "pilot", "--scene-id", "scene-1"]);

    const human = workspace.run(["queue", "status"]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /queue depth: 1 claimable now/);
    assert.match(human.stdout, /configured providers: mock/);
    assert.match(human.stdout, /provider=mock/);

    const sceneBoard = workspace.run(["scene", "list", "--project-id", "pilot"]);
    assert.match(sceneBoard.stdout, /#1 Opening shot \[DRAFT\]/);
    assert.match(sceneBoard.stdout, /blocked: [^\n]*GENERATION_IN_PROGRESS/);
    assert.ok(!sceneBoard.stdout.includes("A lantern lights"), "the board view stays compact and omits prompt text");
  } finally {
    await workspace.close();
  }
});

test("a provider this worker cannot serve is refused instead of being failed by accident", async () => {
  const workspace = await createWorkspace();
  try {
    workspace.run(["project", "create", "--project-id", "pilot", "--name", "Pilot"]);
    workspace.run(["scene", "create", "--project-id", "pilot", "--scene-id", "scene-1", "--title", "Opening shot"]);
    workspace.run(["scene", "version", "add", "--scene-id", "scene-1", "--prompt", "A lantern lights a dark stairwell at dusk."]);

    const flowJob = workspace.json([
      "generate",
      "--project-id",
      "pilot",
      "--scene-id",
      "scene-1",
      "--provider",
      "google-flow",
    ]);
    assert.equal(flowJob.code, 0, flowJob.stderr);
    assert.equal(flowJob.data().job.provider, "google-flow", "enqueueing flow work needs no browser session");

    const refused = workspace.json(["queue", "run", "--max-jobs", "1"]);
    assert.equal(refused.code, 3, refused.stderr + refused.stdout);
    assert.equal(refused.error().code, "PROVIDER_COVERAGE_INCOMPLETE");
    assert.equal(refused.error().details.uncovered["google-flow"], 1);

    const after = workspace.json(["status", "--job-id", flowJob.data().job.id]);
    assert.equal(after.data().job.status, "QUEUED");
    assert.equal(after.data().job.attemptCount, 0, "the guard must not consume an attempt");

    const capabilities = workspace.json(["provider", "list", "--provider", "google-flow"]);
    assert.equal(capabilities.code, 0, capabilities.stderr);
    assert.equal(capabilities.data()[0].capabilities.videoGeneration, false);
  } finally {
    await workspace.close();
  }
});

test("cancellation, retry, and lease recovery are operator commands with durable effects", async () => {
  const workspace = await createWorkspace();
  try {
    workspace.run(["project", "create", "--project-id", "pilot", "--name", "Pilot"]);
    workspace.run(["scene", "create", "--project-id", "pilot", "--scene-id", "scene-1", "--title", "Opening shot"]);
    workspace.run(["scene", "version", "add", "--scene-id", "scene-1", "--prompt", "A lantern lights a dark stairwell at dusk."]);
    const generated = workspace.json(["generate", "--project-id", "pilot", "--scene-id", "scene-1"]);
    const jobId = generated.data().job.id;

    const cancelled = workspace.json(["cancel", "--job-id", jobId, "--local-only"]);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.equal(cancelled.data().job.status, "CANCELLED");
    assert.equal(cancelled.data().providerCancellation, "NOT_ATTEMPTED");
    assert.match(cancelled.data().providerCancellationReason, /local-only/);

    assert.equal(workspace.json(["retry", "--job-id", jobId]).code, 1);
    assert.equal(workspace.json(["retry", "--job-id", jobId]).error().code, "RETRY_NOT_ALLOWED");
    assert.equal(workspace.json(["queue", "recover"]).data().recoveredLeases, 0);

    const failed = workspace.json([
      "generate",
      "--project-id",
      "pilot",
      "--scene-id",
      "scene-1",
      "--provider",
      "mock",
      "--parameters-json",
      '{"size":5}',
    ]);
    assert.equal(failed.code, 0, failed.stderr);
    const runFailures = workspace.run([
      "queue",
      "run",
      "--all",
      "--mode",
      "PERMANENT_FAILURE",
    ]);
    assert.equal(runFailures.code, 0, runFailures.stderr);
    const failureStatus = workspace.json(["status", "--job-id", failed.data().job.id]);
    assert.equal(failureStatus.data().job.status, "FAILED");
    assert.equal(failureStatus.data().safeToRetry, true);

    const retried = workspace.json(["retry", "--job-id", failed.data().job.id]);
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal(retried.data().job.status, "QUEUED");
    assert.equal(retried.data().nextAction, "AWAIT_WORKER");
  } finally {
    await workspace.close();
  }
});

test("usage errors are loud, and the Phase 1 vertical-slice invocation still works", async () => {
  const workspace = await createWorkspace();
  try {
    assert.equal(workspace.run(["project", "create", "--description", "no name"]).code, 2);
    assert.match(workspace.run(["project", "create", "--description", "no name"]).stderr, /--name is required/);
    assert.equal(workspace.run(["nonsense", "command"]).code, 2);
    assert.equal(workspace.run(["queue", "status", "--nope"]).code, 2);
    assert.equal(workspace.run(["generate", "--project-id", "pilot", "--scene-id", "missing", "--json"]).error().code, "NOT_FOUND");

    const help = workspace.run(["help"], { raw: true });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /flowforge <group> <action> \[flags\]/);
    assert.match(help.stdout, /project create --name NAME/);
    assert.match(help.stdout, /Exit codes: 0 ok, 1 error, 2 usage error, 3/);
    const commandHelp = workspace.run(["review", "approve", "--help"], { raw: true });
    assert.match(commandHelp.stdout, /Usage:\n {2}flowforge review approve --asset-version-id ID/);

    const legacy = workspace.run(["--data-dir", path.join(workspace.directory, "legacy"), "--review", "approve"], { raw: true });
    assert.equal(legacy.code, 0, legacy.stderr);
    assert.match(legacy.stdout, /FlowForge Phase 1 vertical slice/);
    assert.match(legacy.stdout, /"jobStatus": "SUCCEEDED"/);
    assert.match(legacy.stdout, /"qcStatus": "PASSED"/);
    assert.match(legacy.stdout, /"reviewStatus": "APPROVED"/);

    const named = workspace.run(["vertical-slice", "--data-dir", path.join(workspace.directory, "named"), "--mode", "SUCCESS"], { raw: true });
    assert.equal(named.code, 0, named.stderr);
    assert.match(named.stdout, /"workflow": "Project -> Scene Version/);
  } finally {
    await workspace.close();
  }
});
