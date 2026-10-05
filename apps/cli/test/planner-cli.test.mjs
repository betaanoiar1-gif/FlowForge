import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/**
 * Phase 4B operator-surface tests. Every call is what an operator types, and every assertion is on the
 * read models the services return — the CLI owns no planning logic of its own. The phase deliberately
 * exposes no execution command, so these tests also prove the surface stops at the plan.
 */
async function createWorkspace() {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-planner-cli-"));
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

const STORY = JSON.stringify({
  premise: "A solo developer ships a launch teaser in an afternoon.",
  beginning: "A developer opens a blank project. Nothing works yet.",
  development: "The pipeline comes online. Shots queue in order. The first render lands.",
  ending: "The teaser ships and the signups arrive.",
});

function setup(workspace) {
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
  const character = workspace.json([
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
  ]);
  assert.equal(character.code, 0, character.stderr);
  const world = workspace.json([
    "definition",
    "world-create",
    "--project-id",
    "pilot",
    "--world-id",
    "world-roof",
    "--name",
    "Rooftops",
    "--environment",
    "Dense rooftop grid at dawn",
  ]);
  assert.equal(world.code, 0, world.stderr);
  const dna = workspace.json([
    "definition",
    "dna-create",
    "--project-id",
    "pilot",
    "--visual-dna-id",
    "dna-grain",
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
  ]);
  assert.equal(dna.code, 0, dna.stderr);
  return { briefId: brief.data().brief.id };
}

const PLAN_ARGS = (extra = []) => [
  "planner",
  "run",
  "--project-id",
  "pilot",
  "--story-json",
  STORY,
  "--cast-json",
  '[{"characterId":"char-aya","role":"the courier"}]',
  "--worlds-json",
  '[{"worldId":"world-roof"}]',
  "--options-json",
  '{"totalDurationMs":15000,"developmentScenes":2}',
  ...extra,
];

test("planner rules prints the engine the operator is about to run", async () => {
  const workspace = await createWorkspace();
  try {
    const result = workspace.json(["planner", "rules"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.data().plannerVersion, "deterministic-planner-v1");
    assert.equal(result.data().rulesVersion, "planning-rules-v1");
    assert.deepEqual(
      result.data().rules.map((rule) => rule.id),
      [
        "brief-foundation",
        "story-foundation",
        "beat-decomposition",
        "cast-assignment",
        "world-binding",
        "visual-dna-binding",
        "duration-allocation",
        "capability-adaptation",
        "generation-spec-planning",
        "continuity-linking",
        "planned-output-manifest",
        "plan-integrity",
      ],
    );
    assert.equal(result.data().defaults.defaultOutputKinds.join(","), "image");
    const human = workspace.run(["planner", "rules"]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /guarantees: no LLM, no randomness, no clock, no I\/O/u);
    assert.match(human.stdout, /01\. brief-foundation/u);
    assert.match(human.stdout, /12\. plan-integrity/u);
  } finally {
    await workspace.close();
  }
});

test("a dry run reports the plan without writing it", async () => {
  const workspace = await createWorkspace();
  try {
    setup(workspace);
    const dry = workspace.json(PLAN_ARGS(["--dry-run"]));
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.data().outcome, "SUCCESS");
    assert.equal(dry.data().scenePlans, 4);
    assert.equal(dry.data().specs, 4);
    assert.equal(dry.data().plan, null);
    assert.equal(dry.data().validation, null);
    assert.match(dry.data().nextAction, /without dryRun/u);
    assert.equal(workspace.json(["plan", "list", "--project-id", "pilot"]).data().length, 0);
    // The fingerprints the dry run reports are the ones the real run records.
    const written = workspace.json(PLAN_ARGS());
    assert.equal(written.code, 0, written.stderr);
    assert.equal(written.data().planner.inputFingerprint, dry.data().planner.inputFingerprint);
    assert.equal(written.data().planner.outputFingerprint, dry.data().planner.outputFingerprint);
  } finally {
    await workspace.close();
  }
});

test("planner run authors an ordinary plan version and records its provenance", async () => {
  const workspace = await createWorkspace();
  try {
    setup(workspace);
    const first = workspace.json(PLAN_ARGS());
    assert.equal(first.code, 0, first.stderr);
    const result = first.data();
    assert.equal(result.outcome, "SUCCESS");
    assert.equal(result.created, true);
    assert.equal(result.version.status, "VALIDATED");
    assert.equal(result.validation.status, "PASSED");
    assert.match(result.planner.inputFingerprint, /^[0-9a-f]{64}$/u);
    assert.equal(result.trace.length, 12);
    assert.deepEqual(result.notices, []);

    const planId = result.plan.id;
    const inspect = workspace.json(["plan", "inspect", "--plan-id", planId]);
    assert.equal(inspect.code, 0, inspect.stderr);
    assert.equal(inspect.data().planner.planned, true);
    assert.equal(inspect.data().planner.traceSteps, 12);
    assert.equal(inspect.data().planner.plannerVersion, "deterministic-planner-v1");
    assert.equal(inspect.data().planner.contentMatchesProvenance, true);
    assert.equal(inspect.data().scenePlans.length, 4);
    // The shot text the plan carries is the planner's own instruction template, verbatim; the brief's
    // constraints travel as labelled spec constraints rather than prose the operator has to re-read.
    const firstSpec = inspect.data().scenePlans[0].specs[0];
    assert.match(firstSpec.instructions, /^\[image\] /u);
    assert.match(firstSpec.instructions, /Look: 35mm film look; photoreal; low key/u);
    assert.match(firstSpec.instructions, /Setting: Rooftops/u);
    assert.match(firstSpec.instructions, /Cast: Aya as the courier\./u);
    assert.deepEqual(firstSpec.constraints, ["MUST: no on-screen text"]);

    const versions = workspace.json(["plan", "versions", "--plan-id", planId]);
    assert.equal(versions.data()[0].planned, true);
    assert.equal(versions.data()[0].unchangedSincePlanning, true);

    // Re-running the same inputs writes nothing, and says so.
    const again = workspace.json(PLAN_ARGS());
    assert.equal(again.data().reused, true);
    assert.equal(again.data().created, false);
    assert.equal(again.data().version.id, result.version.id);
    assert.equal(workspace.json(["plan", "versions", "--plan-id", planId]).data().length, 1);

    // A new seed is a new version of the same plan, still planned.
    const seeded = workspace.json(PLAN_ARGS(["--seed", "9"]));
    assert.equal(seeded.data().created, true);
    assert.equal(seeded.data().version.versionNumber, 2);
    assert.equal(seeded.data().version.plannerSeed, 9);
    const table = workspace.run(["plan", "versions", "--plan-id", planId]);
    assert.match(table.stdout, /authored/u);
    assert.match(table.stdout, /deterministic-planner-v1/u);
  } finally {
    await workspace.close();
  }
});

test("--approve takes a clean plan all the way to EXECUTABLE against the mock provider", async () => {
  const workspace = await createWorkspace();
  try {
    setup(workspace);
    const run = workspace.json(PLAN_ARGS(["--approve", "--reviewer", "ops", "--providers", "mock"]));
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.data().version.status, "EXECUTABLE");
    assert.deepEqual(run.data().version.executableProviders, ["mock"]);
    assert.match(run.data().nextAction, /EXECUTABLE/u);
    const human = workspace.run(PLAN_ARGS(["--dry-run"]));
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /outcome: SUCCESS/u);
    assert.match(human.stdout, /rules applied: brief-foundation > story-foundation/u);
  } finally {
    await workspace.close();
  }
});

test("a plan the rules reject is reported, blocks the exit code, and writes nothing", async () => {
  const workspace = await createWorkspace();
  try {
    setup(workspace);
    // A story with no development or ending: the planner refuses rather than inventing them.
    const incomplete = workspace.json([
      "planner",
      "run",
      "--project-id",
      "pilot",
      "--story-json",
      '{"premise":"one thought","beginning":"It starts.","development":"","ending":""}',
    ]);
    assert.equal(incomplete.code, 3, incomplete.stdout);
    assert.equal(incomplete.data().outcome, "PLANNING_FAILURE");
    assert.equal(incomplete.data().notices[0].code, "PLANNER_STORY_INCOMPLETE");
    assert.match(incomplete.data().nextAction, /Nothing was written/u);
    assert.equal(workspace.json(["plan", "list", "--project-id", "pilot"]).data().length, 0);

    // Asking the mock provider for video is refused the same way: no partial plan is stored.
    const video = workspace.json(PLAN_ARGS(["--options-json", '{"totalDurationMs":15000,"defaultOutputKinds":["video"]}']));
    assert.equal(video.code, 3, video.stdout);
    assert.equal(video.data().notices[0].code, "PLANNER_KIND_UNAVAILABLE");
    assert.equal(workspace.json(["plan", "list", "--project-id", "pilot"]).data().length, 0);

    // A malformed knob is an input error, reported with the field that caused it.
    const badRatio = workspace.json(PLAN_ARGS(["--options-json", '{"aspectRatio":"cinematic"}']));
    assert.equal(badRatio.code, 3, badRatio.stdout);
    assert.equal(badRatio.data().errors[0].code, "PLANNER_INPUT_INVALID");
    assert.match(badRatio.data().errors[0].message, /aspectRatio/u);
    assert.match(badRatio.stdout, /aspectRatio/u);
  } finally {
    await workspace.close();
  }
});

test("the phase stops at the plan: no planner command executes anything", async () => {
  const workspace = await createWorkspace();
  try {
    setup(workspace);
    const missing = workspace.json(["planner", "execute"]);
    assert.notEqual(missing.code, 0);
    const help = workspace.run(["planner", "--help"]);
    assert.equal(help.code, 2, help.stdout);
    const overview = workspace.run(["--help"]);
    assert.match(overview.stdout, /planner run/u);
    assert.match(overview.stdout, /planner rules/u);
    assert.doesNotMatch(overview.stdout, /planner execute|planner submit|planner queue/u);
    // `plan preview` remains the read-only view of the execution seam.
    const run = workspace.json(PLAN_ARGS());
    const preview = workspace.json(["plan", "preview", "--plan-id", run.data().plan.id]);
    assert.equal(preview.code, 0, preview.stderr);
    assert.equal(preview.data().items.length, 4);
    assert.equal(preview.data().executable, false);
  } finally {
    await workspace.close();
  }
});

test("unknown flags are refused rather than silently dropped", async () => {
  const workspace = await createWorkspace();
  try {
    setup(workspace);
    const typo = workspace.json(PLAN_ARGS(["--dry-run-no"]));
    assert.notEqual(typo.code, 0);
    assert.match(typo.stdout + typo.stderr, /dry-run-no/u);
  } finally {
    await workspace.close();
  }
});
