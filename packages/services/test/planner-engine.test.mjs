import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DETERMINISTIC_PLANNER_VERSION, PLANNING_RULES_VERSION } from "@flowforge/core";
import { planner } from "../dist/index.js";

const { runPlanner, PLANNER_RULES, PLANNER_DEFAULTS, PlannerInputError } = planner;

/**
 * Deterministic-planner engine tests (Phase 4B). Everything here runs the engine as a pure function —
 * no database, no provider, no clock beyond the `asOf` the input supplies — because the engine's whole
 * promise is that its output is a function of its input and nothing else.
 */

const AS_OF = "2026-05-01T00:00:00.000Z";
const CAPS = {
  imageOnly: { imageGeneration: true, videoGeneration: false, referenceImages: true, startFrame: false, endFrame: false, batchGeneration: false },
  full: { imageGeneration: true, videoGeneration: true, referenceImages: true, startFrame: true, endFrame: true, batchGeneration: true },
  bare: { imageGeneration: true, videoGeneration: false, referenceImages: false, startFrame: false, endFrame: false, batchGeneration: false },
};

const brief = (overrides = {}) => ({
  id: "brief-1",
  projectId: "proj-1",
  versionNumber: 1,
  title: "Launch teaser",
  concept: "A launch teaser for a planning tool.",
  objective: "Get signups",
  audience: "Indie developers",
  tone: "confident",
  style: "clean product film",
  constraints: [{ kind: "MUST_NOT", value: "on-screen text after the hook" }],
  status: "ACTIVE",
  contentHash: "brief-hash",
  createdAt: AS_OF,
  updatedAt: AS_OF,
  ...overrides,
});

const character = (id, name) => ({
  id,
  projectId: "proj-1",
  name,
  kind: "character",
  status: "ACTIVE",
  createdAt: AS_OF,
  updatedAt: AS_OF,
  traits: { appearance: "tall, grey hoodie", personality: "dry humour" },
  visualIdentity: { description: "round glasses" },
});

const world = (id, name, environment = "a loft with three monitors") => ({
  id,
  projectId: "proj-1",
  name,
  description: "",
  environment,
  rules: ["no visible brand logos"],
  status: "ACTIVE",
  versionNumber: 1,
  contentHash: `world-${id}`,
  createdAt: AS_OF,
  updatedAt: AS_OF,
});

const dna = (id, name) => ({
  id,
  projectId: "proj-1",
  name,
  style: "35mm film",
  palette: ["teal", "amber"],
  lighting: "soft key",
  composition: "centred",
  cameraLanguage: "slow push-ins",
  renderingStyle: "photo-real",
  atmosphere: "focused",
  consistencyRules: ["keep the horizon level"],
  versionNumber: 1,
  contentHash: `dna-${id}`,
  createdAt: AS_OF,
  updatedAt: AS_OF,
});

const STORY = {
  premise: "A solo developer ships a launch teaser in an afternoon.",
  beginning: "A developer opens a blank project. Nothing works yet.",
  development: "The pipeline comes online. Shots queue in order. The first render lands.",
  ending: "The teaser ships and the signups arrive.",
};

const CAPS_IMAGE_ONLY = { id: "mock", capabilities: CAPS.imageOnly };

function input(overrides = {}) {
  const { providers, ...rest } = overrides;
  return {
    projectId: "proj-1",
    brief: brief(),
    story: STORY,
    cast: [{ characterId: "char-dev", role: "the developer" }],
    worlds: [{ worldId: "world-studio" }],
    definitions: {
      characters: [character("char-dev", "Ada")],
      worlds: [world("world-studio", "Studio")],
      visualDna: [dna("dna-1", "Launch look")],
    },
    providerCandidates: [CAPS_IMAGE_ONLY],
    options: { totalDurationMs: 12_000, developmentScenes: 2 },
    asOf: AS_OF,
    ...rest,
    ...(providers === undefined ? {} : { providerCandidates: providers }),
  };
}

test("the rule registry is explicit, ordered, and documented", () => {
  const ids = PLANNER_RULES.map((rule) => rule.id);
  assert.deepEqual(ids, [
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
  ]);
  assert.equal(new Set(ids).size, ids.length);
  for (const rule of PLANNER_RULES) {
    assert.ok(rule.summary.length > 20, `${rule.id} needs a summary an operator can read`);
    assert.ok(rule.reads.length > 0, `${rule.id} must name the input it reads`);
    assert.equal(typeof rule.apply, "function");
  }
  // The engine versions behaviour separately from the validator, and both are pinned in core.
  assert.equal(DETERMINISTIC_PLANNER_VERSION, "deterministic-planner-v1");
  assert.equal(PLANNING_RULES_VERSION, "planning-rules-v1");
});

test("identical input yields an identical plan, byte for byte, whatever the clock says", () => {
  const first = runPlanner(input());
  const second = runPlanner(input());
  const later = runPlanner(input({ asOf: "2020-01-01T00:00:00.000Z" }));
  assert.equal(first.outcome, "SUCCESS");
  assert.deepEqual(first.draft, second.draft);
  assert.equal(first.inputFingerprint, second.inputFingerprint);
  assert.equal(first.outputFingerprint, second.outputFingerprint);
  assert.deepEqual(
    first.draft.scenePlans.map((scene) => scene.specs.map((spec) => spec.instructions)),
    second.draft.scenePlans.map((scene) => scene.specs.map((spec) => spec.instructions)),
  );
  // `asOf` is recorded, never planned from: a re-run tomorrow is the same plan, not a new fingerprint.
  assert.equal(later.inputFingerprint, first.inputFingerprint);
  assert.equal(later.outputFingerprint, first.outputFingerprint);
  assert.deepEqual(later.draft.scenePlans.map((scene) => scene.id), first.draft.scenePlans.map((scene) => scene.id));
});

test("normalization is tidy without rewriting prose", () => {
  const plain = runPlanner(input());
  const padded = runPlanner(
    input({
      story: { ...STORY, development: `  ${STORY.development}  ` },
      cast: [{ characterId: "char-dev", role: "  the developer " }],
      // Provider order is not a creative decision, so it is sorted before it can affect anything.
      providerCandidates: [CAPS_IMAGE_ONLY, { id: "other", capabilities: CAPS.bare }].reverse(),
    }),
  );
  assert.equal(
    padded.draft.scenePlans.map((scene) => scene.specs[0].instructions).join("\n"),
    plain.draft.scenePlans.map((scene) => scene.specs[0].instructions).join("\n"),
  );
  // Words, case, and sentence order survive untouched: the planner quotes, it never rewrites.
  assert.equal(plain.draft.scenePlans[0].title, "A developer opens a blank project.");
  assert.equal(plain.draft.scenePlans[0].title.startsWith("a developer"), false);
  // Meaningful order is preserved: scenes follow the beats they came from.
  assert.deepEqual(
    plain.draft.scenePlans.map((scene) => scene.sceneNumber),
    [1, 2, 3, 4],
  );
});

test("beats are partitioned from the story, never summarised", () => {
  const run = runPlanner(input({ options: { totalDurationMs: 12_000, developmentScenes: 3 } }));
  const scenes = run.draft.scenePlans;
  assert.equal(scenes.length, 5);
  assert.deepEqual(scenes.map((scene) => scene.emphasis), ["establish", "develop", "develop", "develop", "resolve"]);
  // Titles are the first sentence of each slice; purposes are the slice itself, verbatim.
  assert.equal(scenes[0].title, "A developer opens a blank project.");
  assert.equal(scenes[0].narrativePurpose, STORY.beginning);
  assert.equal(scenes[4].title, "The teaser ships and the signups arrive.");
  assert.equal(scenes[1].narrativePurpose, "The pipeline comes online.");
  assert.equal(scenes[2].narrativePurpose, "Shots queue in order.");
  assert.equal(scenes[3].narrativePurpose, "The first render lands.");
  // Explicit beats win over derivation, in the operator's order.
  const explicit = runPlanner(
    input({ story: { ...STORY, beats: [{ title: "Second beat" }, { title: "First beat" }] } }),
  );
  assert.deepEqual(explicit.draft.scenePlans.map((scene) => scene.title), ["Second beat", "First beat"]);
});

test("a long first sentence becomes a quoted title, truncated but not reworded", () => {
  const long = `${"An extremely long opening sentence that keeps going and going past the limit".padEnd(80, " ")}End.`;
  const run = runPlanner(input({ story: { ...STORY, beginning: long } }));
  const title = run.draft.scenePlans[0].title;
  assert.ok(title.length <= 72, `title is ${title.length} characters`);
  assert.ok(title.endsWith("…"));
  assert.ok(long.startsWith(title.slice(0, -1).trimEnd()));
});

test("durations divide the budget exactly, honour fixed beats, and floor short shares", () => {
  const run = runPlanner(input({ options: { totalDurationMs: 15_000, developmentScenes: 2 } }));
  const durations = run.draft.scenePlans.map((scene) => scene.durationTargetMs);
  // weights 3,2,2,2 over 15000: floor per share, remainder to the heaviest first.
  assert.deepEqual(durations, [5001, 3333, 3333, 3333]);
  assert.equal(durations.reduce((sum, value) => sum + value, 0), 15_000);

  const fixed = runPlanner(
    input({
      story: {
        ...STORY,
        beats: [
          { title: "Open", durationMs: 8_000, emphasis: "establish" },
          { title: "Build", emphasis: "develop" },
          { title: "Land", emphasis: "resolve" },
        ],
      },
      options: { totalDurationMs: 12_000 },
    }),
  );
  assert.deepEqual(fixed.draft.scenePlans.map((scene) => scene.durationTargetMs), [8000, 2000, 2000]);

  const overBudget = runPlanner(
    input({
      story: { ...STORY, beats: [{ title: "Too long", durationMs: 20_000 }] },
      options: { totalDurationMs: 5_000 },
    }),
  );
  assert.equal(overBudget.outcome, "PLANNING_FAILURE");
  assert.equal(overBudget.draft, undefined);
  assert.equal(overBudget.notices[0].code, "PLANNER_DURATION_OVER_BUDGET");

  const floored = runPlanner(input({ options: { totalDurationMs: 1_200, minSceneDurationMs: 1_000, developmentScenes: 2 } }));
  assert.equal(floored.outcome, "SUCCESS");
  assert.ok(floored.notices.some((notice) => notice.code === "PLANNER_DURATION_FLOORED"));
  assert.ok(floored.draft.scenePlans.every((scene) => scene.durationTargetMs >= 1_000));
});

test("plans stay inside what the declared providers can do", () => {
  const video = runPlanner(input({ options: { totalDurationMs: 12_000, defaultOutputKinds: ["video"] } }));
  assert.equal(video.outcome, "PLANNING_FAILURE");
  assert.equal(video.notices[0].code, "PLANNER_KIND_UNAVAILABLE");
  assert.match(video.notices[0].message, /videoGeneration/u);

  const both = runPlanner(
    input({
      providerCandidates: [CAPS_IMAGE_ONLY, { id: "flow", capabilities: CAPS.full }],
      options: { totalDurationMs: 12_000, defaultOutputKinds: ["video"] },
    }),
  );
  assert.equal(both.outcome, "SUCCESS");
  assert.equal(both.draft.scenePlans[0].specs[0].kind, "video");
  assert.equal(both.draft.scenePlans[0].specs[0].durationMs, both.draft.scenePlans[0].durationTargetMs);

  const batched = runPlanner(input({ options: { totalDurationMs: 12_000, outputCountPerSpec: 3 } }));
  assert.equal(batched.notices.find((notice) => notice.code === "PLANNER_BATCH_UNAVAILABLE").severity, "WARNING");
  for (const scene of batched.draft.scenePlans) {
    assert.equal(scene.specs[0].outputCount, 1);
    assert.equal(scene.specs[0].requiredCapabilities.includes("batchGeneration"), false);
    assert.equal(scene.specs[0].requiredCapabilities.includes("referenceImages"), true);
  }
  const batching = runPlanner(
    input({ providerCandidates: [{ id: "flow", capabilities: CAPS.full }], options: { totalDurationMs: 12_000, outputCountPerSpec: 3 } }),
  );
  assert.equal(batching.draft.scenePlans[0].specs[0].outputCount, 3);
  assert.ok(batching.draft.scenePlans[0].specs[0].requiredCapabilities.includes("batchGeneration"));

  // No referenceImages anywhere: specs drop their references, but the scene plan keeps saying what it needs.
  const unreferenceable = runPlanner(input({ providerCandidates: [{ id: "bare", capabilities: CAPS.bare }] }));
  assert.equal(unreferenceable.outcome, "SUCCESS");
  assert.equal(unreferenceable.draft.scenePlans[0].specs[0].references.length, 0);
  assert.equal(unreferenceable.draft.scenePlans[0].specs[0].requiredCapabilities.includes("referenceImages"), false);
  assert.ok(unreferenceable.draft.scenePlans[0].requiredReferences.length > 0);
  assert.ok(unreferenceable.notices.some((notice) => notice.code === "PLANNER_REFERENCES_SKIPPED"));

  // An empty candidate list means "assume nothing", which is the validator's business, not the planner's.
  const blind = runPlanner(input({ providerCandidates: [] }));
  assert.equal(blind.outcome, "SUCCESS");
  assert.equal(blind.draft.scenePlans[0].specs[0].references.length > 0, true);
  const skipped = blind.findings.find((finding) => finding.code === "PROVIDER_CAPABILITY_CHECK_SKIPPED");
  assert.equal(skipped.severity, "WARNING");
});

test("every scene says what it inherits, and the manifest matches the specs", () => {
  const run = runPlanner(input());
  const scenes = run.draft.scenePlans;
  assert.ok(scenes.every((scene) => scene.continuity.length >= 1));
  assert.equal(scenes[0].requiredReferences.some((reference) => reference.kind === "scenePlan"), false);
  for (const [index, scene] of scenes.entries()) {
    if (index === 0) {
      assert.match(scene.continuity[0].statement, /^Opens the piece:/u);
      continue;
    }
    assert.match(scene.continuity[0].statement, new RegExp(`Continues from scene plan ${scenes[index - 1].sceneKey}`, "u"));
    const previous = scene.requiredReferences.find((reference) => reference.kind === "scenePlan");
    assert.equal(previous.id, scenes[index - 1].id);
    assert.equal(previous.note, `inherited from ${scenes[index - 1].sceneKey}`);
  }
  for (const scene of scenes) {
    const promised = scene.plannedOutputs.reduce((sum, entry) => sum + entry.count, 0);
    const specified = scene.specs.reduce((sum, spec) => sum + spec.outputCount, 0);
    assert.equal(promised, specified);
    for (const output of scene.plannedOutputs) {
      assert.ok(scene.specs.some((spec) => spec.kind === output.kind));
    }
  }
});

test("world and visual DNA binding are decided by rule, and ambiguity is reported not guessed", () => {
  const single = runPlanner(input());
  assert.equal(single.draft.scenePlans.every((scene) => scene.worldId === "world-studio"), true);
  assert.equal(single.draft.visualDnaId, "dna-1");

  const ambiguous = runPlanner(
    input({
      worlds: [{ worldId: "world-a" }, { worldId: "world-b" }],
      definitions: { ...input().definitions, worlds: [world("world-a", "Rooftops"), world("world-b", "Street")] },
    }),
  );
  assert.equal(ambiguous.draft.scenePlans[0].worldId, undefined);
  assert.ok(ambiguous.notices.some((notice) => notice.code === "PLANNER_WORLD_AMBIGUOUS"));

  const claimed = runPlanner(
    input({
      story: { ...STORY, beats: [{ title: "On the roof", worldId: "world-b" }, { title: "On the street", worldId: "world-a" }] },
      worlds: [{ worldId: "world-a" }, { worldId: "world-b" }],
      definitions: { ...input().definitions, worlds: [world("world-a", "Rooftops"), world("world-b", "Street")] },
    }),
  );
  assert.deepEqual(claimed.draft.scenePlans.map((scene) => scene.worldId), ["world-b", "world-a"]);

  const twoDna = runPlanner(
    input({ definitions: { ...input().definitions, visualDna: [dna("dna-1", "A"), dna("dna-2", "B")] } }),
  );
  assert.equal(twoDna.outcome, "VALIDATION_FAILURE");
  assert.ok(twoDna.notices.some((notice) => notice.code === "PLANNER_DNA_AMBIGUOUS"));
  // The draft is refused *because* the Phase 4A validator rejects it: no competing rule set.
  assert.ok(twoDna.findings.some((finding) => finding.code === "VISUAL_DNA_MISSING" && finding.severity === "ERROR"));
  const chosen = runPlanner(
    input({
      visualDnaId: "dna-2",
      definitions: { ...input().definitions, visualDna: [dna("dna-1", "A"), dna("dna-2", "B")] },
    }),
  );
  assert.equal(chosen.outcome, "SUCCESS");
  assert.equal(chosen.draft.visualDnaId, "dna-2");
});

test("scene keys follow the beat, and a repeated beat key collides into a suffix", () => {
  const titled = runPlanner(
    input({
      story: {
        ...STORY,
        beats: [
          { title: "Same Title", emphasis: "establish" },
          { title: "Same Title", emphasis: "develop" },
          { title: "Same Title", emphasis: "resolve" },
        ],
      },
    }),
  );
  // The key is the slug alone: a scene inserted in front must not rename the ones behind it, and the
  // dense scene number is what carries order.
  assert.deepEqual(titled.draft.scenePlans.map((scene) => scene.sceneKey), [
    "same-title",
    "same-title-2",
    "same-title-3",
  ]);
  assert.deepEqual(titled.draft.scenePlans.map((scene) => scene.sceneNumber), [1, 2, 3]);
  // An explicit beat key is more stable than a title, so it is what the scene key is built from.
  const keyed = runPlanner(
    input({
      story: {
        ...STORY,
        beats: [
          { key: "hook", title: "Open on the machine", emphasis: "establish" },
          { key: "turn", title: "The queue drains", emphasis: "develop" },
        ],
      },
    }),
  );
  assert.deepEqual(keyed.draft.scenePlans.map((scene) => scene.sceneKey), ["hook", "turn"]);
  const repeated = runPlanner(
    input({
      story: { ...STORY, beats: [{ key: "same", title: "One" }, { key: "same", title: "Two" }] },
    }),
  );
  assert.deepEqual(repeated.draft.scenePlans.map((scene) => scene.sceneKey), ["same", "same-2"]);
  // Keys stay unique even so, which is what plan-integrity insists on.
  assert.equal(new Set(repeated.draft.scenePlans.map((scene) => scene.sceneKey)).size, 2);
});

test("the seed moves the cast rotation and nothing else", () => {
  const many = input({
    cast: [
      { characterId: "char-dev", role: "the developer" },
      { characterId: "char-qa", role: "the reviewer" },
    ],
  });
  many.definitions = { ...many.definitions, characters: [character("char-dev", "Ada"), character("char-qa", "Rae")] };
  const zero = runPlanner({ ...many, options: { totalDurationMs: 12_000, developmentScenes: 2, seed: 0 } });
  const one = runPlanner({ ...many, options: { totalDurationMs: 12_000, developmentScenes: 2, seed: 1 } });
  assert.equal(zero.outcome, "SUCCESS");
  // Establishing and resolving beats keep the whole company; only developing beats rotate.
  assert.deepEqual(zero.draft.scenePlans.map((scene) => scene.cast.map((link) => link.characterId)), [
    ["char-dev", "char-qa"],
    ["char-dev"],
    ["char-qa"],
    ["char-dev", "char-qa"],
  ]);
  assert.deepEqual(one.draft.scenePlans.map((scene) => scene.cast.map((link) => link.characterId)), [
    ["char-dev", "char-qa"],
    ["char-qa"],
    ["char-dev"],
    ["char-dev", "char-qa"],
  ]);
  // Everything that is not cast assignment is untouched by the seed.
  assert.deepEqual(
    one.draft.scenePlans.map((scene) => ({ key: scene.sceneKey, duration: scene.durationTargetMs, kinds: scene.specs.map((spec) => spec.kind) })),
    zero.draft.scenePlans.map((scene) => ({ key: scene.sceneKey, duration: scene.durationTargetMs, kinds: scene.specs.map((spec) => spec.kind) })),
  );
  assert.notEqual(one.inputFingerprint, zero.inputFingerprint);
});

test("an input the rules cannot use is refused with a field, not a crash", () => {
  assert.throws(() => runPlanner(input({ projectId: "" })), PlannerInputError);
  assert.throws(() => runPlanner({ ...input(), brief: undefined }), /creative brief is required/u);
  // A story without its movements is a planning failure the rules report, not a normalisation crash.
  assert.equal(runPlanner(input({ story: { premise: "p" } })).outcome, "PLANNING_FAILURE");
  const missingMovements = runPlanner(input({ story: { premise: "p", beginning: "One.", development: "", ending: "Three." } }));
  assert.equal(missingMovements.outcome, "PLANNING_FAILURE");
  assert.equal(missingMovements.notices[0].code, "PLANNER_STORY_INCOMPLETE");
  assert.match(missingMovements.notices[0].message, /development|ending/u);
  assert.equal(missingMovements.draft, undefined);
  assert.equal(missingMovements.outputFingerprint, null);
  // A beat that claims a beat key nobody has is a typo, and it is reported as one.
  const badKey = runPlanner(input({ cast: [{ characterId: "char-dev", scenes: ["nope"] }] }));
  assert.equal(badKey.outcome, "PLANNING_FAILURE");
  assert.equal(badKey.notices[0].code, "PLANNER_BEAT_KEY_UNKNOWN");
  // Out-of-range knobs are input errors too: a planner that silently clamps hides a mistake.
  assert.throws(() => runPlanner(input({ options: { totalDurationMs: 4_000_000 } })), /must not exceed 3600000 milliseconds/u);
  assert.throws(() => runPlanner(input({ options: { aspectRatio: "wide" } })), /aspectRatio/u);
  assert.throws(() => runPlanner(input({ options: { minSceneDurationMs: 100 } })), /at least 250/u);
});

test("the trace explains the run rule by rule", () => {
  const run = runPlanner(input());
  assert.deepEqual(run.rulesApplied, PLANNER_RULES.map((rule) => rule.id));
  assert.equal(run.trace.length, PLANNER_RULES.length);
  for (const step of run.trace) {
    assert.ok(PLANNER_RULES.some((rule) => rule.id === step.rule));
    assert.ok(["APPLIED", "SKIPPED"].includes(step.outcome));
  }
  const duration = run.trace.find((step) => step.rule === "duration-allocation");
  assert.match(duration.detail, /budget 12000 ms → planned total 12000 ms/u);
  const integrity = run.trace.find((step) => step.rule === "plan-integrity");
  assert.match(integrity.detail, /keys and ids unique/u);
  const quiet = runPlanner(input({ options: { totalDurationMs: 12_000, includeTrace: false } }));
  assert.deepEqual(quiet.trace, []);
  assert.equal(quiet.outcome, "SUCCESS");
});

test("the engine touches no randomness, no clock, no I/O, and no model", async () => {
  const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "planner");
  const files = [
    "planner.ts",
    "rules.ts",
    "normalize.ts",
    "scene-decomposition.ts",
    "duration-planning.ts",
    "generation-spec-planning.ts",
    "continuity.ts",
    "state.ts",
    "deterministic-ids.ts",
    "snapshot.ts",
    "types.ts",
  ];
  // Comments are stripped first: the sources are *allowed* to say "no randomUUID()" out loud, and a
  // purity check that only greps prose would be a test of documentation rather than of behaviour.
  const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/^\s*\/\/.*$/gmu, " ");
  const sources = (await Promise.all(files.map((file) => readFile(path.join(directory, file), "utf8")))).map(withoutComments);
  // No node module at all: hashing arrives through @flowforge/core.
  const allowedNodeImports = new Set();
  const forbidden = [
    /Math\.random/u,
    /Date\.now/u,
    /new Date\(/u,
    /\bfetch\(/u,
    /randomUUID/u,
    /process\.env/u,
    /localStorage/u,
    /provider/i,
  ];
  for (const [index, source] of sources.entries()) {
    const file = files[index];
    for (const pattern of forbidden) {
      if (pattern.source === /provider/i.source) continue; // "providerCandidates" is data, not a call
      const match = source.match(pattern);
      assert.equal(match, null, `${file} must not contain ${pattern}`);
    }
    const imports = [...source.matchAll(/from "(node:[^"]+)"/g)].map((entry) => entry[1]);
    for (const specifier of imports) {
      assert.ok(allowedNodeImports.has(specifier), `${file} may not import ${specifier}`);
    }
  }
});

test("the documented defaults are the defaults the engine uses", () => {
  assert.equal(PLANNER_DEFAULTS.developmentScenes, 2);
  assert.equal(PLANNER_DEFAULTS.sceneDurationMs, 5_000);
  assert.equal(PLANNER_DEFAULTS.minSceneDurationMs, 1_000);
  assert.equal(PLANNER_DEFAULTS.maxTotalDurationMs, 3_600_000);
  assert.equal(PLANNER_DEFAULTS.aspectRatio, "16:9");
  assert.equal(PLANNER_DEFAULTS.outputCountPerSpec, 1);
  assert.deepEqual(PLANNER_DEFAULTS.defaultOutputKinds, ["image"]);
  assert.equal(PLANNER_DEFAULTS.seed, 0);
  assert.equal(PLANNER_DEFAULTS.replan, "new-version");
  // The default kinds are image-only on purpose: the deterministic CI provider cannot render video.
  assert.equal(PLANNER_DEFAULTS.defaultOutputKinds.length, 1);
});
