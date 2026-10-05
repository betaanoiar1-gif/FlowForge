import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AI_PLANNING_SCHEMA_VERSION } from "@flowforge/core";
import { SqliteJobRepository, SqlitePlanningRepository } from "@flowforge/storage";
import { createApplication, validateProposal } from "../dist/index.js";

/**
 * Application-layer tests for AI-assisted planning (Phase 4C).
 *
 * Every adapter here is a deterministic fake: the point under test is FlowForge's *handling* of a model
 * answer — schema validation, translation, the fail-closed boundary, provenance, reuse, and what is never
 * written — and none of that may depend on a credential, a network, or a vendor's mood. The live provider
 * path is covered separately in `providers/openai-chat` against a loopback endpoint, and by documentation;
 * it is never required to build, typecheck, or test this repository.
 *
 * Two claims are checked over and over because they are the phase: (1) an accepted proposal produces the
 * *same plan content* the deterministic planner would have produced from the equivalent input — AI
 * changes the route, never the rules; and (2) a run that cannot produce a valid proposal writes nothing at
 * all, with no patched, padded, or partially planned version behind it.
 */

const NOW = "2026-06-01T00:00:00.000Z";
const IMAGE_ONLY = Object.freeze({
  imageGeneration: true,
  videoGeneration: false,
  referenceImages: true,
  startFrame: false,
  endFrame: false,
  batchGeneration: false,
});

const STORY = {
  premise: "A solo developer ships a launch teaser in an afternoon.",
  beginning: "A developer opens a blank project. Nothing works yet.",
  development: "The pipeline comes online. Shots queue in order. The first render lands.",
  ending: "The teaser ships and the signups arrive.",
};

/** A schema-valid proposal for the harness project. */
function proposal(overrides = {}) {
  return {
    schemaVersion: AI_PLANNING_SCHEMA_VERSION,
    title: "Launch teaser, three beats",
    story: {
      premise: "A solo developer ships a launch teaser in an afternoon.",
      beginning: "A developer opens a blank project. Nothing works yet.",
      development: "The pipeline comes online. Shots queue in order.",
      ending: "The teaser ships and the signups arrive.",
    },
    scenes: [
      {
        title: "Blank project",
        intent: "Establish the stakes: an empty timeline at 4pm.",
        characters: ["Aya"],
        world: "The loft",
        emphasis: "establish",
        durationMs: 4000,
        kinds: ["image"],
      },
      {
        title: "Pipeline online",
        intent: "Show the tooling working, one shot at a time.",
        characters: ["Aya", "Rae"],
        world: "The loft",
        emphasis: "develop",
        durationMs: 6000,
        kinds: ["image"],
      },
      {
        title: "Ship it",
        intent: "Land the release and the first signups.",
        characters: ["Rae"],
        world: "The loft",
        emphasis: "resolve",
        durationMs: 5000,
        kinds: ["image"],
        continuity: "Rae keeps the red scarf from the previous scene.",
      },
    ],
    visualDna: "grain",
    ...overrides,
  };
}

/** A fake adapter: an answer, a refusal, or a thrown error — never a real call. */
function fakeAdapter(answer, options = {}) {
  const adapter = {
    id: options.id ?? "test-adapter",
    adapterVersion: options.adapterVersion ?? "test-adapter-v1",
    provider: options.provider ?? "test-provider",
    model: options.model ?? "test-model",
    schemaVersion: options.schemaVersion ?? AI_PLANNING_SCHEMA_VERSION,
    calls: [],
    async propose(request) {
      adapter.calls.push(request);
      if (answer instanceof Error) throw answer;
      if (typeof answer === "function") return answer(request);
      return answer;
    },
  };
  return adapter;
}

const ok = (value, meta) => ({ status: "OK", proposal: value, ...(meta === undefined ? {} : { meta }) });
const refused = (code, message, retryable = false) => ({ status: "FAILED", code, message, retryable });

async function createHarness(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-ai-planner-"));
  const repository = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
  const planning = new SqlitePlanningRepository(repository);
  const adapter = options.adapter === null ? undefined : options.adapter ?? fakeAdapter(ok(proposal()));
  const app = createApplication(repository, {
    providers: options.providers ?? [{ id: "mock", capabilities: IMAGE_ONLY }],
    now: () => new Date(NOW),
    planning,
    ...(adapter === undefined ? {} : { aiPlanner: adapter }),
  });
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
  for (const [characterId, name, role] of [
    ["char-aya", "Aya", "protagonist"],
    ["char-qa", "Rae", "supporting"],
  ]) {
    app.definitions.createCharacter({
      projectId: "pilot",
      characterId,
      name,
      traits: { role, appearance: `${name} in a red jacket`, personality: "decisive" },
      visualIdentity: { description: "silver watch", distinguishingFeatures: ["watch"], palette: ["#c0392b"] },
    });
  }
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
  const planWithAi = (overrides = {}) => app.aiPlanning.plan({ projectId: "pilot", ...overrides });
  const counts = (table) => repository.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  const rawVersionRow = (versionId) =>
    repository.database.prepare("SELECT * FROM production_plan_versions WHERE id = ?").get(versionId);
  return {
    directory,
    repository,
    planning,
    app,
    adapter,
    brief,
    world,
    visualDna,
    planWithAi,
    counts,
    rawVersionRow,
    close: () => {
      repository.close();
      return rm(directory, { recursive: true, force: true });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* the pipeline: proposal → planner → version                                   */
/* -------------------------------------------------------------------------- */

test("an accepted proposal is planned by the deterministic engine and validated as ordinary plan state", async () => {
  const harness = await createHarness();
  try {
    const run = await harness.planWithAi();
    assert.equal(run.outcome, "SUCCESS");
    assert.equal(run.created, true);
    assert.equal(run.reused, false);
    assert.equal(run.scenePlans, 3, "the proposal's scene count and order are the plan's");
    assert.equal(run.specs, 3);
    assert.equal(run.validation.status, "PASSED");
    assert.equal(run.ai.path, "ai-adapter");
    assert.equal(run.ai.fallback, false);
    assert.equal(run.ai.adapter, "test-adapter");
    assert.equal(run.ai.model, "test-model");
    assert.equal(run.ai.schemaVersion, AI_PLANNING_SCHEMA_VERSION);
    assert.equal(run.ai.provenanceRecorded, true);
    assert.equal(run.planner.rulesVersion, "planning-rules-v1");

    // The AI stages bracket the deterministic ones in the version's single trace.
    const stages = run.trace.map((step) => step.stage ?? "RULE");
    assert.deepEqual(stages.slice(0, 4), ["AI_REQUEST", "AI_RESPONSE", "AI_SCHEMA_VALIDATION", "NORMALIZATION"]);
    assert.equal(stages[stages.length - 1], "DOMAIN_VALIDATION");
    assert.ok(stages.filter((stage) => stage === "RULE").length >= 11, "the deterministic rules ran unchanged");

    // The adapter saw planning context, not a database, a queue, or a credential.
    const request = harness.adapter.calls[0];
    assert.equal(request.schemaVersion, AI_PLANNING_SCHEMA_VERSION);
    assert.equal(request.characters.length, 2);
    assert.deepEqual(
      request.characters.map((entry) => Object.keys(entry).sort()),
      [
        ["appearance", "name", "role"],
        ["appearance", "name", "role"],
      ],
      "characters are handed over by name and description, never by id",
    );
    assert.deepEqual(request.worlds, [{ name: "The loft", environment: "Three monitors and a cold brew" }]);
    assert.deepEqual(request.visualDna, [{ name: "grain", style: "35mm film look" }]);
    assert.deepEqual(request.availableKinds, ["image", "audio", "text"], "video needs a declaration");
    assert.deepEqual(request.brief.constraints, [{ kind: "MUST_NOT", value: "on-screen text after the hook" }]);
    assert.equal(JSON.stringify(request).includes("char-aya"), false, "ids never travel to an adapter");
  } finally {
    await harness.close();
  }
});

/** The same creative intent a proposal carries, written by hand for the deterministic planner. */
const HAND_AUTHORED_INPUT = {
  projectId: "pilot",
  story: {
    premise: "A solo developer ships a launch teaser in an afternoon.",
    beginning: "A developer opens a blank project. Nothing works yet.",
    development: "The pipeline comes online. Shots queue in order.",
    ending: "The teaser ships and the signups arrive.",
    beats: [
      {
        key: "blank-project",
        title: "Blank project",
        purpose: "Establish the stakes: an empty timeline at 4pm.",
        characters: ["char-aya"],
        worldId: "world-loft",
        durationMs: 4000,
        emphasis: "establish",
        outputKinds: ["image"],
      },
      {
        key: "pipeline-online",
        title: "Pipeline online",
        purpose: "Show the tooling working, one shot at a time.",
        characters: ["char-aya", "char-qa"],
        worldId: "world-loft",
        durationMs: 6000,
        emphasis: "develop",
        outputKinds: ["image"],
      },
      {
        key: "ship-it",
        title: "Ship it",
        purpose: "Land the release and the first signups.",
        characters: ["char-qa"],
        worldId: "world-loft",
        durationMs: 5000,
        emphasis: "resolve",
        outputKinds: ["image"],
        continuityNote: "Rae keeps the red scarf from the previous scene.",
      },
    ],
  },
  cast: [
    { characterId: "char-aya", role: "protagonist" },
    { characterId: "char-qa", role: "supporting" },
  ],
  worlds: [{ worldId: "world-loft", scenes: ["blank-project", "pipeline-online", "ship-it"] }],
  visualDnaId: "dna-grain",
};

test("an AI proposal and the equivalent hand-authored input produce the same plan content and fingerprints", async () => {
  const harness = await createHarness();
  let aiRun;
  let aiContent;
  try {
    aiRun = await harness.planWithAi();
    assert.equal(aiRun.outcome, "SUCCESS");
    const snapshot = harness.app.planReads.snapshot(aiRun.version.id);
    const aiSceneKeys = snapshot.scenePlans.map((node) => node.scenePlan.sceneKey);
    aiContent = {
      keys: aiSceneKeys,
      durations: snapshot.scenePlans.map((node) => node.scenePlan.durationTargetMs),
      titles: snapshot.scenePlans.map((node) => node.scenePlan.title),
      worlds: snapshot.scenePlans.map((node) => node.scenePlan.worldId),
      // Per scene, not flat: the stored spec list is ordered by its own keys, and the identity that
      // matters is "this scene's shot text".
      specs: snapshot.scenePlans.map((node) => node.specs.map((spec) => ({ kind: spec.kind, instructions: spec.instructions }))),
      story: { premise: snapshot.story.premise, themes: snapshot.story.themes },
    };
    // The same intent, authored by hand through the deterministic planner. `planTitle` is the
    // brief-derived default in both, so plan identity cannot fork on how an adapter worded a title.
    const hand = harness.app.planner.plan(HAND_AUTHORED_INPUT);
    assert.equal(hand.outcome, "SUCCESS");
    assert.equal(hand.planner.outputFingerprint, aiRun.planner.outputFingerprint);
    assert.equal(hand.planner.inputFingerprint, aiRun.planner.inputFingerprint);
    // Same project, same content: the planner's own reuse recognises it, so the AI version is what a
    // hand-authored run would have written — byte for byte — and its provenance is left exactly as it was.
    assert.equal(hand.reused, true);
    assert.equal(hand.created, false);
    assert.equal(hand.version.id, aiRun.version.id);
    assert.equal(hand.version.contentHash, aiRun.version.contentHash);
    assert.equal(hand.version.ai.adapter, "test-adapter");
    assert.equal(hand.notices.some((notice) => notice.code === "AI_PROPOSAL_ACCEPTED"), false);
  } finally {
    await harness.close();
  }

  // A second, untouched project, planned only by hand: the plan content is identical across the two
  // routes, and only the version that went through the adapter carries an AI record.
  const alone = await createHarness();
  try {
    const handOnly = alone.app.planner.plan(HAND_AUTHORED_INPUT);
    assert.equal(handOnly.outcome, "SUCCESS");
    assert.equal(handOnly.created, true);
    assert.equal(handOnly.version.ai, undefined, "a hand-authored version records no AI route");
    assert.equal(handOnly.scenePlans, aiRun.scenePlans);
    assert.equal(handOnly.specs, aiRun.specs);
    // The comparison across two databases is over content, not over the digests: a fingerprint legitimately
    // covers the brief row it was planned against, and two harnesses mint different brief ids. Equal scene
    // keys, titles, durations, worlds, and spec text is the claim that survives a fresh database.
    const handSnapshot = alone.app.planReads.snapshot(handOnly.version.id);
    assert.deepEqual(
      {
        keys: handSnapshot.scenePlans.map((node) => node.scenePlan.sceneKey),
        durations: handSnapshot.scenePlans.map((node) => node.scenePlan.durationTargetMs),
        titles: handSnapshot.scenePlans.map((node) => node.scenePlan.title),
        worlds: handSnapshot.scenePlans.map((node) => node.scenePlan.worldId),
        specs: handSnapshot.scenePlans.map((node) => node.specs.map((spec) => ({ kind: spec.kind, instructions: spec.instructions }))),
        story: { premise: handSnapshot.story.premise, themes: handSnapshot.story.themes },
      },
      aiContent,
    );
  } finally {
    await alone.close();
  }
});

/** Scene keys are plan content: they must be the proposal's order, not an artifact of the route. */
test("the model cannot plan a scene the domain would not accept: capability limits and durations win", async () => {
  const harness = await createHarness({
    adapter: fakeAdapter(
      ok(
        proposal({
          scenes: [
            { title: "Wide", intent: "Open the piece.", kinds: ["video"], durationMs: 1500 },
            { title: "Close", intent: "Land the product.", kinds: ["video"], durationMs: 1500 },
          ],
        }),
      ),
    ),
  });
  try {
    const run = await harness.planWithAi();
    // The model asked for video; the only declared provider does image. The planner does not obey the
    // request, silently downgrade it into a plan the operator did not approve, or pretend it worked: the
    // capability rule refuses, and the refusal is reported with the planner's own code.
    assert.notEqual(run.outcome, "SUCCESS", JSON.stringify(run.errors));
    const codes = [...run.errors.map((error) => error.code), ...run.findings.map((finding) => finding.code)].join(",");
    assert.match(codes, /CAPABILITY|UNSUPPORTED|KIND/u, codes);
    assert.equal(harness.counts("production_plan_versions"), 0, "an unsatisfiable request plans nothing");
    assert.equal(run.ai.provenanceRecorded, false);
    assert.equal(run.version, null);
  } finally {
    await harness.close();
  }
});

test("a proposal that names what the project does not have fails closed, and writes nothing", async () => {
  for (const [label, patched, expectedCode] of [
    ["unknown character", (value) => ({ ...value, scenes: [{ title: "X", intent: "Y", characters: ["Nobody"] }] }), "AI_PROPOSAL_UNKNOWN_CHARACTER"],
    ["unknown world", (value) => ({ ...value, scenes: [{ title: "X", intent: "Y", world: "Mars" }] }), "AI_PROPOSAL_UNKNOWN_WORLD"],
    ["unknown visual DNA", (value) => ({ ...value, visualDna: "kodachrome" }), "AI_PROPOSAL_UNKNOWN_VISUAL_DNA"],
    ["invented constraint", (value) => ({ ...value, scenes: [{ title: "X", intent: "Y", constraints: ["MUST: shot on a phone"] }] }), "AI_PROPOSAL_CONSTRAINT_UNKNOWN"],
  ]) {
    const source = proposal();
    const harness = await createHarness({ adapter: fakeAdapter(ok(patched(source))) });
    try {
      const run = await harness.planWithAi();
      assert.equal(run.outcome, "AI_FAILURE", label);
      assert.ok(
        run.errors.some((error) => error.code === expectedCode),
        `${label}: expected ${expectedCode}, got ${JSON.stringify(run.errors)}`,
      );
      assert.equal(run.version, null);
      assert.equal(run.plan, null);
      assert.equal(run.ai.provenanceRecorded, false);
      assert.equal(harness.counts("production_plans"), 0);
      assert.equal(harness.counts("production_plan_versions"), 0);
      assert.equal(harness.counts("scene_plans"), 0);
    } finally {
      await harness.close();
    }
  }
});

test("an ambiguous reference is refused rather than guessed", async () => {
  // Two characters called "Aya" is a project the model cannot address unambiguously.
  const harness = await createHarness();
  try {
    harness.app.definitions.createCharacter({
      projectId: "pilot",
      characterId: "char-aya-two",
      name: "  aya ",
      traits: { appearance: "a second Aya", personality: "patient" },
      visualIdentity: { description: "green scarf", distinguishingFeatures: [], palette: [] },
    });
    const run = await harness.planWithAi();
    assert.equal(run.outcome, "AI_FAILURE");
    assert.equal(run.errors[0].code, "AI_PROPOSAL_INVALID");
    assert.match(run.errors[0].message, /matches more than one character/u);
    assert.equal(harness.counts("production_plan_versions"), 0);
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------- */
/* fail-closed: schema, adapter refusals, and what a refusal must not do       */
/* -------------------------------------------------------------------------- */

test("arbitrary prose is a failure, never a partial plan", async () => {
  const harness = await createHarness({ adapter: fakeAdapter(ok("Sure! Here is a story about a developer…")) });
  try {
    const run = await harness.planWithAi();
    assert.equal(run.outcome, "AI_FAILURE");
    assert.equal(run.errors[0].code, "AI_PROPOSAL_INVALID");
    assert.ok(run.ai.issues.some((issue) => issue.code === "TYPE" && issue.path === "$"));
    assert.equal(harness.counts("production_plan_versions"), 0);
  } finally {
    await harness.close();
  }
});

test("the schema validator is strict about fields, bounds, and emptiness", async () => {
  // Unknown fields are refused at every level, because accommodating an invented field is how a model
  // starts defining the domain.
  const unknownField = validateProposal(proposal({ unexpected: true, scenes: [{ title: "X", intent: "Y", budget: 9 }] }));
  assert.equal(unknownField.ok, false);
  assert.deepEqual(
    unknownField.issues.map((issue) => `${issue.path}:${issue.code}`).sort(),
    ["$.scenes[0].budget:UNKNOWN_FIELD", "$.unexpected:UNKNOWN_FIELD"],
  );

  const empty = validateProposal({ ...proposal(), scenes: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.issues[0].code, "EMPTY");

  const wrongVersion = validateProposal(proposal({ schemaVersion: "ai-planning-proposal-v0" }));
  assert.equal(wrongVersion.ok, false);
  assert.equal(wrongVersion.issues[0].code, "SCHEMA_VERSION");

  const durations = validateProposal(
    proposal({
      scenes: [
        { title: "Zero", intent: "I", durationMs: 0 },
        { title: "Fraction", intent: "I", durationMs: 1500.5 },
        { title: "Huge", intent: "I", durationMs: 7_200_000 },
      ],
    }),
  );
  assert.equal(durations.ok, false);
  // A fractional duration is not an integer, so it is a type violation; 0 and an over-cap duration are
  // range violations. The distinction matters because "send whole milliseconds" is a wire-format fact.
  assert.deepEqual(durations.issues.map((issue) => issue.code), ["RANGE", "TYPE", "RANGE"]);

  const tooMany = validateProposal(
    proposal({
      scenes: Array.from({ length: 25 }, (_unused, index) => ({ title: `Scene ${index}`, intent: "I" })),
    }),
  );
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.issues[0].code, "TOO_MANY");

  // Trailing whitespace is not a content difference, and it must not survive into a fingerprint.
  const padded = validateProposal(proposal({ scenes: [{ title: "  Blank project  ", intent: "  Establish.  " }] }));
  assert.equal(padded.ok, true);
  assert.equal(padded.proposal.scenes[0].title, "Blank project");
  assert.equal(padded.proposal.scenes[0].intent, "Establish.");
});

test("adapter refusals surface as typed failures with nothing written", async () => {
  for (const [code, retryable] of [
    ["AI_CREDENTIAL_MISSING", false],
    ["AI_TIMEOUT", true],
    ["AI_HTTP_ERROR", true],
    ["AI_EMPTY_RESPONSE", false],
  ]) {
    const harness = await createHarness({ adapter: fakeAdapter(refused(code, `the endpoint said no (${code})`, retryable)) });
    try {
      const run = await harness.planWithAi();
      assert.equal(run.outcome, "AI_FAILURE", code);
      assert.equal(run.errors[0].code, code);
      assert.equal(run.ai.path, "ai-adapter");
      assert.equal(run.ai.responseFingerprint, null);
      assert.equal(run.ai.provenanceRecorded, false);
      assert.match(run.ai.provenanceReason, /never reached the deterministic planner/u);
      assert.ok(
        run.notices.some(
          (notice) => notice.code === "AI_FALLBACK_NOT_REQUESTED" && notice.severity === "INFO",
        ),
        "the operator is told how to proceed, and that nothing was patched in",
      );
      assert.equal(harness.counts("production_plan_versions"), 0);
      assert.equal(harness.counts("queue_items"), 0);
      assert.equal(harness.counts("generation_jobs"), 0);
    } finally {
      await harness.close();
    }
  }
});

test("an adapter that throws is reported as a failure, not a crash", async () => {
  const harness = await createHarness({
    adapter: fakeAdapter(
      new Error('request failed with header "Authorization: Bearer sk-secret-token-value-for-testing-only-0000" at https://api.example.com/v1'),
    ),
  });
  try {
    const run = await harness.planWithAi();
    assert.equal(run.outcome, "AI_FAILURE");
    assert.equal(run.errors[0].code, "AI_FAILED");
    const printed = JSON.stringify(run);
    assert.equal(printed.includes("sk-secret-token-value-for-testing-only-0000"), false, "a credential fragment never travels");
    assert.equal(printed.includes("Authorization"), false);
    assert.equal(printed.includes("api.example.com"), false, "even a URL authority is dropped");
    assert.match(run.errors[0].message, /\[redacted\]/u);
  } finally {
    await harness.close();
  }
});

test("AI planning is unavailable, not improvised, when no adapter is configured", async () => {
  const harness = await createHarness({ adapter: null });
  try {
    await assert.rejects(
      () => harness.app.aiPlanning.plan({ projectId: "pilot" }),
      (error) => error.code === "AI_PLANNER_NOT_CONFIGURED" && /nothing was written/u.test(error.message),
    );
    assert.equal(harness.counts("production_plan_versions"), 0);
    // The deterministic path is untouched by the absence of an adapter.
    const deterministic = harness.app.planner.plan({ projectId: "pilot", story: STORY });
    assert.equal(deterministic.outcome, "SUCCESS");
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------- */
/* fallback, dry run, reuse, and provenance                                     */
/* -------------------------------------------------------------------------- */

test("the deterministic route happens only when the operator asked for it, and says so", async () => {
  const failing = () => fakeAdapter(refused("AI_UNAVAILABLE", "no endpoint reachable", true));

  const without = await createHarness({ adapter: failing() });
  try {
    const run = await without.planWithAi({ story: STORY });
    assert.equal(run.outcome, "AI_FAILURE", "a failed adapter never quietly becomes a deterministic run");
    assert.equal(without.counts("production_plan_versions"), 0);
  } finally {
    await without.close();
  }

  const withFallback = await createHarness({ adapter: failing() });
  try {
    const run = await withFallback.planWithAi({ story: STORY, fallback: "deterministic" });
    assert.equal(run.outcome, "SUCCESS");
    assert.equal(run.ai.path, "deterministic-fallback");
    assert.equal(run.ai.fallback, true);
    assert.equal(run.ai.provenanceRecorded, true);
    assert.ok(run.notices.some((notice) => notice.code === "AI_FALLBACK_USED" && notice.severity === "WARNING"));
    const stored = withFallback.planning.getPlanVersion(run.version.id);
    assert.equal(stored.ai.path, "deterministic-fallback");
    assert.equal(stored.ai.fallback, true);
    // Even a fallback run keeps the *attempt* auditable: the refusal is digested, not forgotten.
    assert.match(stored.ai.proposalFingerprint, /^[a-f0-9]{64}$/u);
    assert.equal(stored.ai.responseFingerprint, null);
    assert.equal(withFallback.counts("generation_jobs"), 0);
  } finally {
    await withFallback.close();
  }
});

test("a dry run reports everything and writes nothing — including provenance", async () => {
  const harness = await createHarness();
  try {
    const run = await harness.planWithAi({ dryRun: true });
    assert.equal(run.outcome, "SUCCESS");
    assert.equal(run.created, false);
    assert.equal(run.version, null, "a dry run reports no stored version");
    assert.equal(run.scenePlans, 3);
    assert.match(run.ai.requestFingerprint, /^[a-f0-9]{64}$/u);
    assert.match(run.ai.proposalFingerprint, /^[a-f0-9]{64}$/u);
    assert.equal(run.ai.provenanceRecorded, false);
    assert.match(run.ai.provenanceReason, /dry run writes nothing/u);
    assert.equal(harness.counts("production_plans"), 0);
    assert.equal(harness.counts("production_plan_versions"), 0);
    assert.equal(harness.counts("plan_validations"), 0);
    assert.equal(harness.counts("scene_plans"), 0);
    assert.equal(harness.counts("generation_jobs"), 0);
    assert.equal(harness.counts("queue_items"), 0);
    assert.equal(harness.adapter.calls.length, 1, "the model was asked once, honestly");

    // Authorising the same input for real creates the first version — the dry run left nothing to fork from.
    const real = await harness.planWithAi();
    assert.equal(real.created, true);
    assert.equal(real.version.versionNumber, 1);
    assert.equal(real.planner.outputFingerprint, run.planner.outputFingerprint);
  } finally {
    await harness.close();
  }
});

test("equivalent proposals are idempotent, differing ones stay distinguishable", async () => {
  const answers = [
    proposal(),
    // Wording the domain does not plan with: a different proposal title is a different document, yet the
    // accepted *content* is the same, so no second version may appear.
    proposal({ title: "Launch teaser, THREE beats", logline: "  retyped by hand  " }),
    // A real content difference: one more scene, planned as its own version.
    proposal({ scenes: [...proposal().scenes, { title: "Signups", intent: "Count them." }] }),
  ];
  let index = 0;
  const harness = await createHarness({
    adapter: fakeAdapter(() => ok(answers[Math.min(index, answers.length - 1)])),
  });
  try {
    const first = await harness.planWithAi();
    assert.equal(first.created, true);

    index = 1;
    const sameContent = await harness.planWithAi();
    assert.equal(sameContent.reused, true, "equivalent normalized proposals must not fork a version");
    assert.equal(sameContent.created, false);
    assert.equal(sameContent.version.id, first.version.id);
    assert.notEqual(
      sameContent.ai.proposalFingerprint,
      first.ai.proposalFingerprint,
      "the two answers were different documents, which the attempt digest still shows",
    );
    assert.equal(sameContent.planner.outputFingerprint, first.planner.outputFingerprint);
    assert.equal(sameContent.ai.provenanceRecorded, false, "a reused version keeps the authorship it was created with");
    assert.match(sameContent.ai.provenanceReason, /already holds this content/u);

    index = 2;
    const different = await harness.planWithAi();
    assert.equal(different.created, true, "a real content difference is never collapsed into the old version");
    assert.notEqual(different.version.id, first.version.id);
    assert.equal(different.version.versionNumber, 2);
    assert.notEqual(different.ai.proposalFingerprint, sameContent.ai.proposalFingerprint);
    assert.notEqual(different.planner.outputFingerprint, first.planner.outputFingerprint);
    assert.equal(harness.counts("production_plan_versions"), 2);
    assert.equal(harness.adapter.calls.length, 3, "three attempts, three questions asked");
  } finally {
    await harness.close();
  }
});

test("whitespace-only differences in an answer are the same proposal to the planner", async () => {
  const harness = await createHarness({
    adapter: fakeAdapter((request) =>
      ok(request.sequence === 2 ? paddedSpaces(proposal()) : proposal()),
    ),
  });
  try {
    const first = await harness.planWithAi();
    harness.adapter.calls.length = 0;
    const second = await harness.planWithAi();
    assert.equal(second.reused, true, "the same accepted content must not fork a version");
    assert.equal(first.ai.proposalFingerprint, second.ai.proposalFingerprint);
    assert.equal(first.planner.inputFingerprint, second.planner.inputFingerprint);
  } finally {
    await harness.close();
  }
});

function paddedSpaces(value) {
  return {
    ...value,
    scenes: value.scenes.map((scene) => ({ ...scene, title: `  ${scene.title}  `, intent: `${scene.intent}  ` })),
  };
}

test("the version records who was asked and what was accepted, and never how to ask again", async () => {
  const harness = await createHarness({
    adapter: fakeAdapter(ok(proposal()), { id: "openai-chat", provider: "openai-compatible", model: "gpt-audit" }),
  });
  try {
    const run = await harness.planWithAi({ approve: true, reviewer: "operator" });
    assert.equal(run.outcome, "SUCCESS");
    assert.equal(run.version.status, "APPROVED", "AI planning leaves lifecycle to the lifecycle services");
    const stored = harness.planning.getPlanVersion(run.version.id);
    assert.deepEqual(Object.keys(stored.ai).sort(), [
      "adapter",
      "adapterVersion",
      "fallback",
      "model",
      "path",
      "proposalFingerprint",
      "provider",
      "requestFingerprint",
      "responseFingerprint",
      "schemaVersion",
    ]);
    assert.equal(stored.ai.adapter, "openai-chat");
    assert.equal(stored.ai.model, "gpt-audit");
    for (const fingerprint of [stored.ai.requestFingerprint, stored.ai.proposalFingerprint, stored.ai.responseFingerprint]) {
      assert.match(String(fingerprint), /^[a-f0-9]{64}$/u, "digests only");
    }

    // Raw row and trace, checked for anything that could be replayed or leaked.
    const row = harness.rawVersionRow(run.version.id);
    const serialized = JSON.stringify(row);
    for (const forbidden of ["Authorization", "Bearer", "api.openai.com", "sk-", "baseUrl", "headers", "prompt"]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} must never reach storage`);
    }
    const trace = JSON.stringify(stored.plannerTrace ?? []);
    for (const forbidden of ["Authorization", "Bearer", "sk-", "prompt", "https://"]) {
      assert.equal(trace.includes(forbidden), false, `${forbidden} must never reach the trace`);
    }
    // The request digest is stable and content-derived: no clock, no attempt counter.
    const again = await harness.planWithAi();
    assert.equal(again.ai.requestFingerprint, run.ai.requestFingerprint);
  } finally {
    await harness.close();
  }
});

test("includeTrace:false records no steps, and the notices still explain the route", async () => {
  const harness = await createHarness();
  try {
    const run = await harness.planWithAi({ options: { includeTrace: false } });
    assert.equal(run.outcome, "SUCCESS");
    assert.deepEqual(run.trace, []);
    const stored = harness.planning.getPlanVersion(run.version.id);
    assert.ok(stored.plannerTrace === undefined || stored.plannerTrace.length === 0, "no steps were recorded");
    // Provenance is not a trace: identity is recorded whether or not the operator wants the step list.
    assert.equal(stored.ai.adapter, "test-adapter");
    assert.ok(run.notices.some((notice) => notice.code === "AI_PROPOSAL_ACCEPTED"));
  } finally {
    await harness.close();
  }
});

test("AI metadata stays outside the deterministic content hash and the plan's evidence", async () => {
  const harness = await createHarness();
  try {
    const run = await harness.planWithAi();
    const row = harness.rawVersionRow(run.version.id);
    assert.equal(row.content_hash, run.version.contentHash);
    assert.equal(row.planner_content_hash, run.version.contentHash);
    // The AI columns are outside `content_hash`, so an adapter's identity cannot make a plan look edited…
    assert.equal(harness.planning.planVersionContentHash(run.version.id), run.version.contentHash);
    // …and a re-run of the same proposal is recognised as the same content, not as a new draft.
    const second = await harness.planWithAi();
    assert.equal(second.reused, true);
    assert.equal(second.version.id, run.version.id);
  } finally {
    await harness.close();
  }
});

test("nothing about a proposal may reach execution state", async () => {
  const harness = await createHarness();
  try {
    const run = await harness.planWithAi({ approve: true, reviewer: "operator", providers: ["mock"] });
    assert.equal(run.outcome, "SUCCESS");
    assert.equal(harness.counts("generation_jobs"), 0, "no job was created");
    assert.equal(harness.counts("queue_items"), 0, "nothing was enqueued");
    assert.equal(harness.counts("generation_attempts"), 0, "nothing was attempted");
    assert.equal(harness.counts("asset_versions"), 0, "no asset was written");
    // `approve` with named providers is 4A/4B lifecycle, and it behaves identically for an AI-planned
    // version — which is the point: the AI path cannot *execute* anything, and it cannot skip a gate
    // either. Executable means "some later phase may act on it", and no later phase was invoked here.
    assert.equal(run.version.status, "EXECUTABLE");
    assert.equal(
      harness.planning.listPlanVersions(run.plan.id).filter((version) => version.status === "EXECUTABLE").length,
      1,
    );
    assert.equal(run.ai.adapter, "test-adapter", "and the route that produced it is still recorded");
  } finally {
    await harness.close();
  }
});
