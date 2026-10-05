/**
 * Phase 6 composition-root tests: what the operator sees when the real Google Flow provider is
 * selected. These are the two configuration states that must not be collapsed, and they are proven
 * against an endpoint that does not exist — no browser is launched, no Flow session is contacted, and
 * no credential is ever read or echoed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** A port nothing listens on: the attach must fail, and it must fail in under a second. */
const DEAD_ENDPOINT_ORIGIN = "127.0.0.1:1";

async function createWorkspace() {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-flow-runtime-"));
  const dataDir = path.join(directory, "data");
  const env = { ...process.env };
  delete env.FLOWFORGE_CDP_ENDPOINT;
  const run = (args, options = {}) => {
    const result = spawnSync(process.execPath, [CLI, ...args, "--data-dir", dataDir], {
      encoding: "utf8",
      timeout: 60_000,
      env: options.env ? { ...env, ...options.env } : env,
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
  const json = (args, options = {}) => run([...args, "--json"], options);
  return { directory, dataDir, run, json, close: () => rm(directory, { recursive: true, force: true }) };
}

async function seedScene(workspace, sceneId = "scene-1") {
  const project = workspace.json(["project", "create", "--project-id", "pilot", "--name", "Pilot"]);
  assert.equal(project.code, 0, project.stderr);
  assert.equal(workspace.json(["scene", "create", "--project-id", "pilot", "--scene-id", sceneId, "--title", "Opening shot"]).code, 0);
  assert.equal(
    workspace.json(["scene", "version", "add", "--scene-id", sceneId, "--prompt", "A lantern lights a dark stairwell at dusk."]).code,
    0,
  );
}

test("selecting Flow without a configured browser says so, and says nothing else", async () => {
  const workspace = await createWorkspace();
  try {
    await seedScene(workspace);
    const refused = workspace.json(["queue", "run", "--provider", "google-flow"]);
    assert.equal(refused.code, 1, refused.stdout + refused.stderr);
    assert.equal(refused.error().code, "GOOGLE_FLOW_NOT_CONFIGURED");
    assert.equal(refused.error().details.configured, false);
    assert.equal(refused.error().details.provider, "google-flow");
    assert.match(refused.error().message, /never logs in for you/i, "the remedy is manual authentication");
    assert.equal(
      workspace.json(["queue", "status", "--provider", "google-flow"]).data().items.length,
      0,
      "a refused run leaves the queue untouched",
    );
  } finally {
    await workspace.close();
  }
});

test("an endpoint that was configured but cannot be attached is a different, explicit failure", async () => {
  const workspace = await createWorkspace();
  try {
    await seedScene(workspace);
    const refused = workspace.json(["queue", "run", "--provider", "google-flow", "--cdp-endpoint", `http://${DEAD_ENDPOINT_ORIGIN}`]);
    assert.equal(refused.code, 1, refused.stdout + refused.stderr);
    assert.equal(refused.error().code, "PROVIDER_SESSION_UNAVAILABLE");
    assert.equal(refused.error().details.configured, true);
    assert.equal(refused.error().details.endpoint, `http://${DEAD_ENDPOINT_ORIGIN}`);
    assert.match(refused.error().details.reason, /.+/, "the underlying transport reason is preserved");
  } finally {
    await workspace.close();
  }
});

test("endpoint credentials and query data are never echoed back by the provider wiring", async () => {
  const workspace = await createWorkspace();
  try {
    await seedScene(workspace);
    const refused = workspace.json([
      "queue",
      "run",
      "--provider",
      "google-flow",
      "--cdp-endpoint",
      `http://user:pass@${DEAD_ENDPOINT_ORIGIN}/proxy?token=SECRET-ENDPOINT-TOKEN`,
    ]);
    assert.equal(refused.code, 1, refused.stdout + refused.stderr);
    const printed = `${refused.stdout}${refused.stderr}`;
    for (const secret of ["SECRET-ENDPOINT-TOKEN", "user:pass", "/proxy"]) {
      assert.equal(printed.includes(secret), false, `${secret} must never reach operator output`);
    }
    assert.equal(refused.error().details.endpoint, `http://${DEAD_ENDPOINT_ORIGIN}`);
  } finally {
    await workspace.close();
  }
});

test("reading capabilities and queueing Flow work never requires a browser session", async () => {
  const workspace = await createWorkspace();
  try {
    await seedScene(workspace, "scene-enqueue");
    const capabilities = workspace.json(["provider", "list", "--provider", "google-flow"]);
    assert.equal(capabilities.code, 0, capabilities.stderr);
    assert.deepEqual(capabilities.data()[0], {
      id: "google-flow",
      capabilities: {
        imageGeneration: true,
        videoGeneration: false,
        referenceImages: false,
        startFrame: false,
        endFrame: false,
        batchGeneration: false,
      },
    });

    const queued = workspace.json([
      "generate",
      "--project-id",
      "pilot",
      "--scene-id",
      "scene-enqueue",
      "--provider",
      "google-flow",
      "--parameters-json",
      '{"mode":"image","outputCount":1}',
    ]);
    assert.equal(queued.code, 0, queued.stderr + queued.stdout);
    assert.equal(queued.data().job.status, "QUEUED");
    assert.equal(queued.data().job.provider, "google-flow");

    const refused = workspace.json(["queue", "run", "--max-jobs", "1"]);
    assert.equal(refused.code, 3, refused.stdout + refused.stderr);
    assert.equal(refused.error().code, "PROVIDER_COVERAGE_INCOMPLETE");
    assert.equal(refused.error().details.uncovered["google-flow"], 1, "the mock worker refuses Flow work instead of substituting itself");
  } finally {
    await workspace.close();
  }
});

test("the capability gate refuses Flow-unsupported requests before a job or queue row exists", async () => {
  const workspace = await createWorkspace();
  try {
    await seedScene(workspace, "scene-capability");
    for (const [label, parametersJson] of [
      ["video", '{"mode":"video"}'],
      ["batch", '{"mode":"image","outputCount":3}'],
      ["start frame", '{"mode":"image","startFrame":"asset-1"}'],
    ]) {
      const refused = workspace.json([
        "generate",
        "--project-id",
        "pilot",
        "--scene-id",
        "scene-capability",
        "--provider",
        "google-flow",
        "--parameters-json",
        parametersJson,
      ]);
      assert.equal(refused.code, 1, `${label}: ${refused.stdout}${refused.stderr}`);
      assert.equal(refused.error().code, "PROVIDER_UNSUPPORTED_REQUEST", label);
    }
    const status = workspace.json(["scene", "show", "--scene-id", "scene-capability"]);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(status.data().jobs.length, 0, "a capability refusal must not leave a job behind");
    const queue = workspace.json(["queue", "status"]);
    assert.equal(queue.data().items.length, 0, "and nothing was enqueued");
  } finally {
    await workspace.close();
  }
});
