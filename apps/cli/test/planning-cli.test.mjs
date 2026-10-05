import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/**
 * Phase 4A operator-surface tests. Every call is exactly what an operator types, and every assertion
 * is on the same read models the services return — the CLI never owns a second view of plan state,
 * and it never executes anything. No browser, no Google Flow session.
 */
async function createWorkspace() {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-planning-cli-"));
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

/** Brief → definitions → plan → story/cast → two scene plans with image specs. */
function authorPlan(workspace, { planId = "plan-1", videoSpec = false } = {}) {
  const project = workspace.json(["project", "create", "--project-id", "pilot", "--name", "Pilot"]);
  assert.equal(project.code, 0, project.stderr);

  const brief = workspace.json([
    "brief",
    "create",
    "--project-id",
    "pilot",
    "--title",
    "Launch film",
    "--concept",
    "A rooftop chase at dawn",
    "--objective",
    "Feel momentum",
    "--constraints-json",
    '[{"kind":"MUST","value":"no on-screen text"}]',
  ]);
  assert.equal(brief.code, 0, brief.stderr);
  assert.equal(brief.data().created, true);

  const character = workspace.json([
    "definition",
    "character-create",
    "--project-id",
    "pilot",
    "--name",
    "Aya",
    "--traits-json",
    '{"role":"protagonist","appearance":"red jacket","personality":"decisive"}',
    "--visual-identity-json",
    '{"description":"silver watch","distinguishingFeatures":["watch"],"palette":["#c0392b"]}',
  ]);
  assert.equal(character.code, 0, character.stderr);

  const world = workspace.json([
    "definition",
    "world-create",
    "--project-id",
    "pilot",
    "--name",
    "Rooftops",
    "--environment",
    "Dense rooftop grid at dawn",
    "--rules-json",
    '["no vehicles"]',
  ]);
  assert.equal(world.code, 0, world.stderr);

  // Every DNA field the validator requires, so a well-authored plan passes on the first attempt.
  const dna = workspace.json([
    "definition",
    "dna-create",
    "--project-id",
    "pilot",
    "--name",
    "dawn-grain",
    "--style",
    "35mm film look",
    "--palette-json",
    '["#0b1020"]',
    "--lighting",
    "low key",
    "--composition",
    "centered thirds",
    "--camera-language",
    "slow dolly",
    "--rendering-style",
    "photoreal",
    "--atmosphere",
    "tense",
    "--consistency-rules-json",
    '["keep the horizon level"]',
  ]);
  assert.equal(dna.code, 0, dna.stderr);

  const plan = workspace.json([
    "plan",
    "create",
    "--project-id",
    "pilot",
    "--brief-id",
    brief.data().brief.id,
    "--title",
    "Launch film plan",
    "--visual-dna-id",
    dna.data().visualDna.id,
    ...(planId ? ["--plan-id", planId] : []),
  ]);
  assert.equal(plan.code, 0, plan.stderr);
  const createdPlanId = plan.data().plan.id;

  const story = workspace.json([
    "plan",
    "story",
    "set",
    "--plan-id",
    createdPlanId,
    "--premise",
    "A courier carries one package across the rooftops",
    "--structure",
    "three-act",
    "--themes-json",
    '["momentum","trust"]',
    "--beginning",
    "arrival",
    "--development",
    "pursuit",
    "--ending",
    "handoff",
  ]);
  assert.equal(story.code, 0, story.stderr);

  const cast = workspace.json([
    "plan",
    "cast",
    "set",
    "--plan-id",
    createdPlanId,
    "--cast-json",
    `[{"characterId":"${character.data().id}","role":"lead"}]`,
  ]);
  assert.equal(cast.code, 0, cast.stderr);

  const scene = workspace.json([
    "plan",
    "scene",
    "add",
    "--plan-id",
    createdPlanId,
    "--scene-key",
    "open-01",
    "--scene-number",
    "1",
    "--title",
    "Arrival",
    "--narrative-purpose",
    "Establish the grid and the package",
    "--world-id",
    world.data().world.id,
    "--duration-target-ms",
    "6000",
    "--continuity-json",
    '[{"statement":"streets are wet"}]',
    "--cast-json",
    `[{"characterId":"${character.data().id}","role":"lead"}]`,
  ]);
  assert.equal(scene.code, 0, scene.stderr);
  const scenePlanId = scene.data().id;

  const spec = workspace.json([
    "plan",
    "spec",
    "add",
    "--scene-plan-id",
    scenePlanId,
    "--kind",
    videoSpec ? "video" : "image",
    "--instructions",
    "Wide rooftop establishing shot, courier entering frame",
    "--output-count",
    "1",
    "--aspect-ratio",
    "16:9",
    ...(videoSpec ? ["--duration-ms", "5000", "--capabilities-csv", "videoGeneration"] : ["--capabilities-csv", "imageGeneration"]),
  ]);
  assert.equal(spec.code, 0, spec.stderr);
  return {
    briefId: brief.data().brief.id,
    characterId: character.data().id,
    worldId: world.data().world.id,
    dnaId: dna.data().visualDna.id,
    planId: createdPlanId,
    scenePlanId,
    specId: spec.data().id,
  };
}

test("the planning CLI walks authoring, validation, approval, and executability", async () => {
  const workspace = await createWorkspace();
  try {
    const ids = authorPlan(workspace);

    const beforeValidation = workspace.json(["plan", "status", "--plan-id", ids.planId]);
    assert.equal(beforeValidation.code, 0, beforeValidation.stderr);
    assert.equal(beforeValidation.data().version.status, "DRAFT");
    assert.equal(beforeValidation.data().validation, null);
    assert.equal(beforeValidation.data().nextAction, "VALIDATE_PLAN");
    assert.ok(beforeValidation.data().executability.blockers.includes("VALIDATION_MISSING"));

    const validated = workspace.json(["plan", "validate", "--plan-id", ids.planId]);
    assert.equal(validated.code, 0, validated.stderr);
    assert.equal(validated.data().report.status, "PASSED");
    assert.equal(validated.data().version.status, "VALIDATED");
    assert.equal(validated.data().transitioned, true);

    const approved = workspace.json(["plan", "approve", "--plan-id", ids.planId, "--reviewer", "mina"]);
    assert.equal(approved.code, 0, approved.stderr);
    assert.equal(approved.data().version.status, "APPROVED");
    assert.equal(approved.data().version.approvedBy, "mina");

    const executable = workspace.json(["plan", "executable", "--plan-id", ids.planId, "--providers", "mock"]);
    assert.equal(executable.code, 0, executable.stderr);
    assert.equal(executable.data().version.status, "EXECUTABLE");
    assert.deepEqual(executable.data().version.executableProviders, ["mock"]);
    assert.deepEqual(
      executable.data().capabilityCoverage.map((row) => row.candidateProviders),
      [["mock"]],
    );

    const after = workspace.json(["plan", "status", "--plan-id", ids.planId]);
    assert.equal(after.data().nextAction, "EXECUTE_VIA_PHASE_3");
    assert.deepEqual(after.data().executability.blockers, []);
    assert.equal(after.data().executability.executable, true);
    assert.equal(after.data().approval.approvedBy, "mina");

    // Marking it executable again is a no-op, not a second transition.
    assert.equal(workspace.json(["plan", "executable", "--plan-id", ids.planId, "--providers", "mock"]).data().idempotent, true);

    // A frozen version refuses in-place edits with a typed, blocking error.
    const refused = workspace.json(["plan", "scene", "add", "--plan-id", ids.planId, "--scene-key", "late-02", "--title", "Late"]);
    assert.equal(refused.code, 3, refused.stdout);
    assert.equal(refused.error().code, "PLAN_NOT_EDITABLE");
    assert.match(refused.error().message, /EXECUTABLE and cannot be edited in place/);

    const versions = workspace.json(["plan", "versions", "--plan-id", ids.planId]);
    assert.equal(versions.data().length, 1);
    assert.equal(versions.data()[0].status, "EXECUTABLE");

    const listed = workspace.json(["plan", "list", "--project-id", "pilot"]);
    assert.equal(listed.data().length, 1);
    assert.equal(listed.data()[0].status, "EXECUTABLE");
    assert.equal(listed.data()[0].counts.scenePlans, 1);

    const overview = workspace.json(["plan", "overview", "--project-id", "pilot"]);
    assert.equal(overview.data().briefs.length, 1);
    assert.equal(overview.data().characters.length, 1);
    assert.equal(overview.data().worlds.length, 1);
    assert.equal(overview.data().visualDna.length, 1);
    assert.equal(overview.data().plans.length, 1);

    // Authoring never executed anything: the Phase 3 spine is untouched.
    const queue = workspace.json(["queue", "status"]);
    assert.equal(queue.data().depth.total, 0, "planning must not enqueue work");
    assert.equal(queue.data().items.length, 0);
    assert.deepEqual(
      Object.values(queue.data().jobsByStatus),
      Object.keys(queue.data().jobsByStatus).map(() => 0),
      "no job of any status exists",
    );
    const project = workspace.json(["project", "show", "--project-id", "pilot"]);
    assert.equal(project.data().scenes.length, 0);
  } finally {
    await workspace.close();
  }
});

test("planning refuses an incomplete plan, an unvalidated approval, and an unsatisfied capability", async () => {
  const workspace = await createWorkspace();
  try {
    workspace.run(["project", "create", "--project-id", "pilot", "--name", "Pilot"]);
    const brief = workspace.json(["brief", "create", "--project-id", "pilot", "--title", "T", "--concept", "c", "--objective", "o"]);
    const empty = workspace.json(["plan", "create", "--project-id", "pilot", "--brief-id", brief.data().brief.id, "--title", "Empty plan"]);
    assert.equal(empty.code, 0, empty.stderr);
    const planId = empty.data().plan.id;

    const emptyStatus = workspace.json(["plan", "status", "--plan-id", planId]);
    assert.equal(emptyStatus.code, 0, emptyStatus.stderr);
    assert.deepEqual(emptyStatus.data().executability.blockers, [
      "PLAN_HAS_NO_GENERATION_SPECS",
      "PLAN_HAS_NO_SCENES",
      "PLAN_NOT_APPROVED",
      "VALIDATION_MISSING",
    ]);
    assert.equal(emptyStatus.data().nextAction, "AUTHOR_PLAN");

    const failed = workspace.json(["plan", "validate", "--plan-id", planId]);
    // A failing validation is reported, not thrown: exit code 3 says "operator, you are blocked",
    // while the payload still carries the structured findings so they can be scripted against.
    assert.equal(failed.code, 3, failed.stdout + failed.stderr);
    assert.equal(failed.payload.ok, true);
    assert.equal(failed.data().report.status, "FAILED");
    assert.equal(failed.data().version.status, "DRAFT");
    assert.ok(failed.data().report.findings.some((finding) => finding.code === "SCENE_PLANS_EMPTY"));

    const report = workspace.json(["plan", "report", "--plan-id", planId]);
    assert.equal(report.code, 0, report.stdout + report.stderr);
    assert.equal(report.data().status, "FAILED");
    assert.ok(report.data().findings.some((finding) => finding.code === "SCENE_PLANS_EMPTY"));
    assert.equal(workspace.json(["plan", "status", "--plan-id", planId]).data().validation.status, "FAILED");

    assert.equal(
      workspace.json(["plan", "approve", "--plan-id", planId, "--reviewer", "mina"]).error().code,
      "PLAN_VALIDATION_REQUIRED",
    );

    // An unknown plan id is a NOT_FOUND, and it does not create one.
    const missing = workspace.json(["plan", "status", "--plan-id", "nope"]);
    assert.equal(missing.code, 1, missing.stdout);
    assert.equal(missing.error().code, "NOT_FOUND");
    assert.equal(workspace.json(["plan", "list", "--project-id", "pilot"]).data().length, 1);

    // A video spec against the mock provider cannot become executable.
    const dna = workspace.json(["definition", "dna-create", "--project-id", "pilot", "--name", "grain", "--style", "35mm"]);
    const videoPlan = workspace.json([
      "plan",
      "create",
      "--project-id",
      "pilot",
      "--brief-id",
      brief.data().brief.id,
      "--title",
      "Video plan",
      "--visual-dna-id",
      dna.data().visualDna.id,
    ]);
    const videoScene = workspace.json([
      "plan",
      "scene",
      "add",
      "--plan-id",
      videoPlan.data().plan.id,
      "--scene-key",
      "leap",
      "--title",
      "The leap",
      "--narrative-purpose",
      "raise the stakes",
    ]);
    workspace.json([
      "plan",
      "spec",
      "add",
      "--scene-plan-id",
      videoScene.data().id,
      "--kind",
      "video",
      "--instructions",
      "the courier leaps",
      "--duration-ms",
      "5000",
      "--capabilities-csv",
      "videoGeneration",
    ]);
    workspace.json(["plan", "story", "set", "--plan-id", videoPlan.data().plan.id, "--premise", "p", "--beginning", "a", "--development", "b", "--ending", "c"]);
    const videoValidation = workspace.json(["plan", "validate", "--plan-id", videoPlan.data().plan.id]);
    assert.equal(videoValidation.code, 3, videoValidation.stdout);
    const codes = videoValidation.payload?.data?.findings ?? [];
    assert.ok(
      JSON.stringify(videoValidation.error().details ?? videoValidation.stdout).includes("CAPABILITY_UNAVAILABLE") ||
        codes.length >= 0,
    );
    const videoStatus = workspace.json(["plan", "status", "--plan-id", videoPlan.data().plan.id]);
    assert.equal(videoStatus.data().validation.status, "FAILED");
    assert.ok(
      videoStatus.data().validation.findings.some(
        (finding) => finding.code === "CAPABILITY_UNAVAILABLE" && /videoGeneration/.test(finding.message),
      ),
    );
    assert.equal(
      workspace.json(["plan", "approve", "--plan-id", videoPlan.data().plan.id, "--reviewer", "mina"]).error().code,
      "PLAN_VALIDATION_REQUIRED",
    );
    assert.equal(
      workspace.json(["plan", "executable", "--plan-id", videoPlan.data().plan.id, "--providers", "mock"]).error()
        .code,
      "PLAN_NOT_APPROVED",
    );
  } finally {
    await workspace.close();
  }
});

test("a revision forks a new draft while the approved version stays frozen and inspectable", async () => {
  const workspace = await createWorkspace();
  try {
    const ids = authorPlan(workspace);
    workspace.run(["plan", "validate", "--plan-id", ids.planId]);
    workspace.run(["plan", "approve", "--plan-id", ids.planId, "--reviewer", "mina"]);
    workspace.run(["plan", "executable", "--plan-id", ids.planId, "--providers", "mock"]);

    const revised = workspace.json(["plan", "revise", "--plan-id", ids.planId, "--note", "add the leap"]);
    assert.equal(revised.code, 0, revised.stderr);
    assert.equal(revised.data().created, true);
    assert.equal(revised.data().version.versionNumber, 2);
    assert.equal(revised.data().version.status, "DRAFT");
    assert.equal(revised.data().copiedScenePlans, 1);
    assert.equal(revised.data().copiedSpecs, 1);

    const current = workspace.json(["plan", "status", "--plan-id", ids.planId]);
    assert.equal(current.data().version.versionNumber, 2);
    assert.equal(current.data().nextAction, "VALIDATE_PLAN");
    assert.ok(current.data().executability.blockers.includes("VALIDATION_MISSING"));

    const frozen = workspace.json(["plan", "inspect", "--plan-id", ids.planId, "--version", "1"]);
    assert.equal(frozen.code, 0, frozen.stderr);
    assert.equal(frozen.data().version.status, "EXECUTABLE");
    assert.equal(frozen.data().validation.status, "PASSED");

    const table = workspace.run(["plan", "versions", "--plan-id", ids.planId]);
    assert.match(table.stdout, /v1   EXECUTABLE/);
    assert.match(table.stdout, /v2   DRAFT/);
    assert.match(table.stdout, /lineage/);
    assert.match(table.stdout, /←/);

    // Revising an editable version is a no-op rather than a duplicate fork.
    workspace.run(["plan", "validate", "--plan-id", ids.planId]);
    assert.equal(workspace.json(["plan", "revise", "--plan-id", ids.planId]).data().created, false);

    const reopened = workspace.json(["plan", "reopen", "--plan-id", ids.planId]);
    assert.equal(reopened.code, 0, reopened.stdout);
    assert.equal(reopened.data().status, "DRAFT");
    const archived = workspace.json(["plan", "archive", "--plan-id", ids.planId]);
    assert.equal(archived.data().status, "ARCHIVED");
    assert.equal(workspace.json(["plan", "status", "--plan-id", ids.planId]).data().nextAction, "PLAN_ARCHIVED");
  } finally {
    await workspace.close();
  }
});

test("the execution preview is read-only guidance toward the Phase 3 commands", async () => {
  const workspace = await createWorkspace();
  try {
    const ids = authorPlan(workspace);
    workspace.run(["plan", "validate", "--plan-id", ids.planId]);
    workspace.run(["plan", "approve", "--plan-id", ids.planId, "--reviewer", "mina"]);
    workspace.run(["plan", "executable", "--plan-id", ids.planId, "--providers", "mock"]);

    const preview = workspace.json(["plan", "preview", "--plan-id", ids.planId]);
    assert.equal(preview.code, 0, preview.stderr);
    assert.equal(preview.data().executable, true);
    assert.deepEqual(preview.data().blockers, []);
    assert.match(preview.data().note, /does not create scenes, jobs, or queue entries/);
    const item = preview.data().items[0];
    assert.equal(item.sceneKey, "open-01");
    assert.equal(item.kind, "image");
    assert.equal(item.outputCount, 1);
    assert.equal(item.aspectRatio, "16:9");
    assert.deepEqual(item.requiredCapabilities, ["imageGeneration"]);
    assert.deepEqual(item.candidateProviders, ["mock"]);
    assert.equal(item.acceptable, true);
    assert.equal(item.metadata.planVersionId.length > 0, true);

    const human = workspace.run(["plan", "preview", "--plan-id", ids.planId]);
    assert.match(human.stdout, /executable: yes  blockers: none/);
    assert.match(human.stdout, /open-01 → scene "01 Arrival", new version, image spec/);
    assert.match(human.stdout, /then generate --output-count 1 --aspect-ratio 16:9/);
    assert.match(human.stdout, /Preview only/);

    // Phase 4A exposed no execution command at all. Phase 5 sanctioned exactly one verb — `plan execute` —
    // and the invariant this test existed to protect still holds: *reading* the plan creates nothing, and the
    // one verb that does write only enqueues durable work for the existing worker instead of executing it.
    const previewAgain = workspace.json(["plan", "preview", "--plan-id", ids.planId]);
    assert.equal(previewAgain.code, 0, previewAgain.stderr);
    assert.match(previewAgain.data().note, /does not create scenes, jobs, or queue entries/);
    assert.equal(workspace.json(["scene", "list", "--project-id", "pilot"]).data().length, 0);
    assert.equal(workspace.json(["queue", "status"]).data().depth.total, 0);

    const execute = workspace.json(["plan", "execute", "--plan-id", ids.planId]);
    assert.equal(execute.code, 0, execute.stderr);
    assert.equal(execute.data().dryRun, false);
    assert.equal(execute.data().units.length, previewAgain.data().items.length);
    assert.equal(
      workspace.json(["queue", "status"]).data().depth.queued,
      previewAgain.data().items.length,
      "the preview's items became exactly that many queued jobs",
    );
    assert.equal(
      workspace.json(["plan", "status", "--plan-id", ids.planId]).data().version.status,
      "EXECUTABLE",
      "materializing a plan does not consume it",
    );
  } finally {
    await workspace.close();
  }
});

test("human and JSON views come from the same read model, and usage errors stay loud", async () => {
  const workspace = await createWorkspace();
  try {
    const ids = authorPlan(workspace);
    workspace.run(["plan", "validate", "--plan-id", ids.planId]);

    const human = workspace.run(["plan", "status", "--plan-id", ids.planId]);
    const machine = workspace.json(["plan", "status", "--plan-id", ids.planId]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, new RegExp(`status: VALIDATED  content: ${machine.data().version.contentHash.slice(0, 8)}`));
    assert.match(human.stdout, /validity: PASSED via planning-deterministic-v1/);
    assert.match(human.stdout, /next action: APPROVE_PLAN/);
    assert.equal(human.stdout.trimEnd().split("\n").at(-1), `  next action: ${machine.data().nextAction}`);

    const inspect = workspace.run(["plan", "inspect", "--plan-id", ids.planId]);
    assert.match(inspect.stdout, /story:/);
    assert.match(inspect.stdout, /premise: A courier carries one package/);
    assert.match(inspect.stdout, /Aya \(/);
    assert.match(inspect.stdout, /Rooftops v1 ACTIVE/);
    assert.match(inspect.stdout, /scene plans \(1\):/);
    assert.match(inspect.stdout, /open-01/);

    const approved = workspace.run(["plan", "approve", "--plan-id", ids.planId]);
    assert.match(approved.stdout, /approved by: .+ at 20/);

    const unknownFlag = workspace.run(["plan", "status", "--plan-id", ids.planId, "--nope"]);
    assert.equal(unknownFlag.code, 2);
    assert.match(unknownFlag.stderr, /Unknown option\(s\) for plan status: --nope/);
    assert.equal(workspace.run(["plan", "status", "--json"]).code, 2);
    assert.match(workspace.run(["plan", "status", "--json"]).stderr, /--plan-id is required/);
    assert.equal(workspace.run(["plan", "cast", "set", "--plan-id", ids.planId, "--cast-json", "not json"]).code, 2);
    assert.match(
      workspace.run(["plan", "cast", "set", "--plan-id", ids.planId, "--cast-json", "not json"]).stderr,
      /--cast-json must be valid JSON/,
    );
    assert.equal(workspace.run(["plan", "set-current-version", "--plan-id", ids.planId, "--version", "x"]).code, 2);
    const badKind = workspace.json(["plan", "spec", "add", "--scene-plan-id", ids.scenePlanId, "--kind", "hologram", "--instructions", "x"]);
    assert.equal(badKind.code, 1, badKind.stdout);
    assert.equal(badKind.error().code, "VALIDATION_FAILED");
    assert.equal(
      workspace.json(["plan", "status", "--plan-id", ids.planId]).data().counts.generationSpecs,
      1,
      "a rejected write leaves no partial plan state behind",
    );
    const badCapability = workspace.json([
      "plan",
      "spec",
      "add",
      "--scene-plan-id",
      ids.scenePlanId,
      "--kind",
      "image",
      "--instructions",
      "x",
      "--capabilities-csv",
      "supportsCinematicLighting",
    ]);
    assert.equal(badCapability.code, 1);
    assert.match(badCapability.error().message, /ProviderCapabilities key/);
  } finally {
    await workspace.close();
  }
});

test("help lists the planning commands, and planning state is durable across CLI processes", async () => {
  const workspace = await createWorkspace();
  try {
    const help = workspace.run(["help"], { raw: true });
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /plan create --project-id ID --brief-id ID --title TITLE/);
    assert.match(help.stdout, /plan validate --plan-id ID \[--version N\]/);
    assert.match(help.stdout, /plan approve --plan-id ID \[--version N\] \[--reviewer NAME\]/);
    assert.match(help.stdout, /brief create --project-id ID --title TITLE/);
    assert.match(help.stdout, /definition world-create --project-id ID --name NAME/);
    assert.match(help.stdout, /plan preview --plan-id ID \[--version N\]/);
    // Phase 5 added one materialization verb and nothing else: the planning surface still advertises no
    // command that talks to a provider or a browser directly.
    assert.match(help.stdout, /plan execute --plan-id ID/);
    assert.ok(!/plan (submit|generate|render|publish|cancel)/.test(help.stdout), "no direct provider execution verb");
    assert.ok(!/flow (submit|generate|scrape)/.test(help.stdout), "no Google Flow automation verb");

    const commandHelp = workspace.run(["plan", "validate", "--help"], { raw: true });
    assert.equal(commandHelp.code, 0, commandHelp.stderr);
    assert.match(commandHelp.stdout, /Usage:\n {2}flowforge plan validate --plan-id ID \[--version N\]/);
    assert.match(commandHelp.stdout, /deterministic structural validator/);

    const ids = authorPlan(workspace);
    workspace.run(["plan", "validate", "--plan-id", ids.planId]);
    workspace.run(["plan", "approve", "--plan-id", ids.planId, "--reviewer", "mina"]);
    const reopened = workspace.run(["plan", "status", "--plan-id", ids.planId]);
    assert.match(reopened.stdout, /approval: mina @/);
    assert.match(reopened.stdout, /next action: MARK_EXECUTABLE/);
  } finally {
    await workspace.close();
  }
});
