import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/**
 * The Phase 5 golden vertical slice, walked end to end through the CLI an operator would actually type:
 *
 *   project → brief → definitions → planner run (validate → approve → executable) → plan execute
 *     → scene + scene version + generation job → durable queue → worker → MockProvider
 *     → asset → deterministic QC → review approve → selection → production ready
 *
 * It is a test rather than a demo script for one reason: the interesting claim is not that the chain can be
 * run, it is that it can be run *again* — twice, from a separate process, after the work already succeeded —
 * without producing a second scene version, job, queue item, asset, or review decision. Only an assertion can
 * hold that. The Phase 1 slice stays exactly as it was; this one adds the planning legs on top of the same
 * execution machinery, with no second engine anywhere.
 */
async function createWorkspace() {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-plan-slice-"));
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
      data: () => payload?.data,
      error: () => payload,
    };
  };
  const json = (args) => run([...args, "--json"]);
  const must = (args, options) => {
    const result = options ? run(args, options) : json(args);
    assert.equal(result.code, 0, `${args.join(" ")} → ${result.stderr || result.stdout}`);
    return result;
  };
  return { directory, dataDir, run, json, must, close: () => rm(directory, { recursive: true, force: true }) };
}

test("the plan-to-approved-asset slice runs once, and a second run changes nothing", async () => {
  const workspace = await createWorkspace();
  try {
    const { dataDir, must } = workspace;
    must(["project", "create", "--project-id", "pilot", "--name", "Pilot"]);
    must([
      "brief",
      "create",
      "--project-id",
      "pilot",
      "--title",
      "Launch film",
      "--concept",
      "A launch teaser for a planning tool that ships in an afternoon",
      "--objective",
      "Get signups",
      "--audience",
      "Indie developers",
      "--tone",
      "confident",
      "--style",
      "clean product film",
    ]);
    const character = must([
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
    ]).data();
    const world = must([
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
    ]).data();
    must([
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
    ]);

    // 1 — planning: one command authors the plan and drives it to EXECUTABLE through the existing transitions.
    const planned = must([
      "planner",
      "run",
      "--project-id",
      "pilot",
      "--visual-dna-id",
      "dna-grain",
      "--story-json",
      JSON.stringify({
        premise: "A solo developer ships a launch teaser in an afternoon.",
        beginning: `${character.name} opens a blank project. Nothing works yet.`,
        development: "The pipeline comes online. Shots queue in order. The first render lands.",
        ending: `${world.name} at dusk: the teaser ships and the signups arrive.`,
      }),
      "--cast-json",
      '[{"characterId":"char-aya","role":"the developer"}]',
      "--worlds-json",
      '[{"worldId":"world-loft"}]',
      "--options-json",
      '{"totalDurationMs":12000,"developmentScenes":1}',
      "--providers",
      "mock",
      "--approve",
      "--reviewer",
      "ops",
    ]).data();
    assert.equal(planned.outcome, "SUCCESS");
    assert.equal(planned.version.status, "EXECUTABLE");
    const planId = planned.plan.id;

    // 2 — materialization: plan → scene → scene version → job → queue item, in one durable unit of work.
    const report = must(["plan", "execute", "--plan-id", planId]).data();
    assert.equal(report.created, true);
    assert.equal(report.counts.scenesCreated, 3);
    assert.equal(report.counts.sceneVersionsCreated, 3);
    assert.equal(report.counts.jobsCreated, 3);
    assert.equal(report.counts.queueItemsCreated, 3);
    const afterPlan = workspace.json(["plan", "status", "--plan-id", planId]).data();
    assert.equal(afterPlan.version.status, "EXECUTABLE", "materializing does not consume the plan");
    assert.equal(workspace.json(["scene", "list", "--project-id", "pilot"]).data().length, 3);
    assert.equal(workspace.json(["queue", "status"]).data().depth.queued, 3);

    // 3 — execution belongs to the existing worker; the plan leg only asked for it to have something to do.
    const firstRun = must(["queue", "run", "--max-jobs", "10"]).data();
    assert.equal(firstRun.attempted, 3);
    assert.equal(firstRun.results.every((row) => row.status === "SUCCEEDED"), true);
    assert.equal(firstRun.results.every((row) => row.qcStatus === "PASSED"), true);

    const state = must(["plan", "execution", "--plan-id", planId]).data();
    assert.equal(state.totals.succeeded, 3);
    assert.equal(state.totals.qcPassed, 3);
    assert.equal(state.totals.approved, 0);
    for (const unit of state.units) {
      assert.match(unit.assetVersionId, /^asset-version-[0-9a-f]{16,}$/u);
      assert.equal(unit.qcStatus, "PASSED");
      assert.equal(unit.isCurrentSceneVersion, true, "the plan's version is the scene's current one");
      assert.equal(unit.jobStatus, "SUCCEEDED");
    }
    const assetFiles = await readdir(path.join(dataDir, "assets"), { recursive: true });
    assert.equal(assetFiles.filter((name) => name.endsWith(".png")).length, 3, "bytes exist on disk");

    // 4 — review and selection stay explicit operator decisions.
    const chosen = state.units[0];
    must(["review", "approve", "--asset-version-id", chosen.assetVersionId, "--reviewer", "ops"]);
    must(["review", "select", "--scene-id", chosen.sceneId, "--asset-version-id", chosen.assetVersionId]);
    const ready = must(["production", "ready", "--scene-id", chosen.sceneId]).data();
    assert.equal(ready.productionReady, true);
    assert.equal(ready.sceneStatus, "READY");
    assert.equal(ready.selectedAssetVersionId, chosen.assetVersionId);
    const reviewed = must(["plan", "execution", "--plan-id", planId]).data();
    assert.equal(reviewed.totals.approved, 1);
    assert.equal(reviewed.totals.selected, 1);

    // 5 — re-run the whole tail. Idempotency is the point of the phase, so this is the assertion that matters.
    const again = must(["plan", "execute", "--plan-id", planId]).data();
    assert.equal(again.created, false);
    assert.equal(again.executionId, report.executionId);
    assert.equal(again.executionFingerprint, report.executionFingerprint);
    assert.deepEqual(again.units.map((unit) => unit.jobId), report.units.map((unit) => unit.jobId));
    const secondRun = must(["queue", "run", "--max-jobs", "10"]).data();
    assert.equal(secondRun.attempted, 0, "the queue holds no work left for the worker to do");

    const settled = must(["plan", "execution", "--plan-id", planId]).data();
    assert.deepEqual(
      settled.units.map((unit) => [unit.jobStatus, unit.queueStatus, unit.attemptCount, unit.assetVersionId]),
      state.units.map((unit) => [unit.jobStatus, unit.queueStatus, unit.attemptCount, unit.assetVersionId]),
      "one asset, one attempt, and one ACK per unit, after two materializations and two worker runs",
    );
    assert.equal(settled.totals.approved, 1, "the review decision was not re-decided or duplicated");
    assert.equal(workspace.json(["scene", "list", "--project-id", "pilot"]).data().length, 3);
    assert.equal(workspace.json(["queue", "status"]).data().depth.total, 3);
    assert.equal((await readdir(path.join(dataDir, "assets"), { recursive: true })).filter((name) => name.endsWith(".png")).length, 3);
  } finally {
    await workspace.close();
  }
});

test("the slice's planning leg still refuses to execute anything without an explicit materialization", async () => {
  const workspace = await createWorkspace();
  try {
    const { must, json } = workspace;
    must(["project", "create", "--project-id", "pilot", "--name", "Pilot"]);
    must([
      "brief",
      "create",
      "--project-id",
      "pilot",
      "--title",
      "Launch film",
      "--concept",
      "A launch teaser",
      "--objective",
      "Get signups",
      "--audience",
      "Indie developers",
      "--tone",
      "confident",
      "--style",
      "clean product film",
    ]);
    must([
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
      '["#0b1020"]',
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
    ]);
    const planned = must([
      "planner",
      "run",
      "--project-id",
      "pilot",
      "--visual-dna-id",
      "dna-grain",
      "--story-json",
      JSON.stringify({
        premise: "A solo developer ships a launch teaser in an afternoon.",
        beginning: "A developer opens a blank project.",
        development: "The pipeline comes online.",
        ending: "The teaser ships.",
      }),
      "--options-json",
      '{"totalDurationMs":8000}',
    ]).data();
    assert.equal(planned.version.status, "VALIDATED", "no --approve, so no approval and no execution path");

    const refused = workspace.run(["plan", "execute", "--plan-id", planned.plan.id, "--json"]);
    assert.equal(refused.code, 3, refused.stdout);
    assert.equal(refused.error().code, "EXECUTION_NOT_READY");
    assert.deepEqual(refused.error().details.blockers.map((blocker) => blocker.code), ["PLAN_NOT_EXECUTABLE"]);
    assert.equal(json(["scene", "list", "--project-id", "pilot"]).data().length, 0);
    assert.equal(json(["queue", "status"]).data().depth.total, 0);
  } finally {
    await workspace.close();
  }
});
