# The deterministic planner engine (Phase 4B)

`Creative Intent → Brief → Deterministic Planner → ProductionPlan → ProductionPlanVersion → Phase 4A validation → APPROVED / EXECUTABLE → Phase 3 execution boundary`

This document is the specification of the middle box. It is the authority for what the planner is allowed
to do; `docs/planning-domain.md` remains the authority for the aggregate it writes into.

Code: `packages/services/src/planner/` (engine) and `packages/services/src/planner-service.ts` (the seam to
persistence). Operator surface: `apps/cli/src/planner-commands.ts`, i.e. `flowforge planner …`.

---

## 1. What the engine is

`runPlanner(input: PlannerInput) -> PlannerRun` is a **pure function**. It reads only its argument. It has:

- no LLM, model call, or agent,
- no randomness (`Math.random`, `randomUUID`), no clock (`Date.now`, `new Date()`), no I/O (no `node:fs`,
  `node:sqlite`, network, child processes) — enforced by a source-scan test,
- no provider instance, browser, or Google Flow contact — provider **capability declarations** are input data,
- no generation job, queue submission, event bus, Redis/Kafka, daemon, scheduler, or worker,
- no UI.

Two consequences an operator can rely on:

1. **Same input ⇒ same plan.** Byte-identical normalized input, planner version, rules version, and seed
   produce byte-identical scene order, scene keys, ids, cast/world/DNA bindings, durations, instructions,
   reference lists, capability requirements, and both fingerprints.
2. **Every decision is a named rule.** The registry (`PLANNER_RULES`, 12 rules, frozen, ordered) *is* the
   algorithm. `flowforge planner rules` prints it, so what a human reads and what the engine runs are the
   same artifact. A rule may add notices; it may not read anything outside `state.input`.

## 2. Contracts

### `PlannerInput` (explicit; nothing is looked up)

| Field | Meaning |
| --- | --- |
| `projectId` | Identity only; the engine loads nothing by it. |
| `brief` | The `CreativeBrief` snapshot the plan serves (title, concept, objective, audience, tone, style, constraints). It must be `ACTIVE`; the planner never creates or edits a brief. |
| `story` | `PlannerStoryInput`: `premise`, `structure`, `themes`, `beginning`, `development`, `ending`, optional ordered `beats`. A beat may also carry `continuityNote` (added by Phase 4C for proposals that state what must carry forward): when present it is trimmed and becomes a `ScenePlanContinuity` statement between the predecessor seam and the forward seam. Inputs that omit it are unaffected, byte for byte. |
| `cast` | `PlannerCastInput[]`: `{ characterId, role?, scenes? }`, `scenes` naming beat keys. |
| `worlds` | `PlannerWorldInput[]`: `{ worldId, scenes? }`, `scenes` naming beat keys. |
| `visualDnaId` | Which DNA snapshot the version pins; omitted means "let the binding rule decide". |
| `definitions` | `PlannerProjectDefinitionInput`: `{ characters, worlds, visualDna }` — the project's records, read by the **caller** and handed over. Used twice: the fields a rule can read drive planning and fingerprints, and the records themselves feed the Phase 4A validator's draft self-check, so profile completeness is judged by the rules that will judge the stored plan. The engine never queries. |
| `options` | `PlannerOptionsInput`, §5. |
| `providerCandidates` | `{ id, capabilities }[]` — declarations only; the engine constructs no provider. |
| `asOf` | The timestamp the *service* hands over for the drafted rows. Typed optional, **required by normalization** (`PLANNER_INPUT_INVALID` without it), so a hand-written engine call cannot silently invent a date. Excluded from every fingerprint and used for nothing creative. |

The planner and rules versions are **not** input fields: `normalizePlannerInput` stamps every run with
`DETERMINISTIC_PLANNER_VERSION` (`deterministic-planner-v1`) and `PLANNING_RULES_VERSION`
(`planning-rules-v1`) from `@flowforge/core`, so a caller cannot forge a version by passing one.

### `PlannerRun` (three outcomes, never mixed)

| Field | Meaning |
| --- | --- |
| `outcome` | `SUCCESS` \| `VALIDATION_FAILURE` \| `PLANNING_FAILURE`. |
| `draft` | The assembled `PlannerDraft` (absent on `PLANNING_FAILURE`). |
| `findings` | Phase 4A validator findings against the draft (empty on `PLANNING_FAILURE`). |
| `notices` | `PLANNER_*` notices with `severity`, `rule`, `field`. |
| `errors` | The `ERROR` notices flattened for callers. |
| `trace` | One `PlannerTraceStep` per rule: `APPLIED` or `SKIPPED`, the inputs it read, and a human-readable effect. |
| `inputFingerprint` / `outputFingerprint` | 64-hex SHA-256 over the canonical forms (§4). `outputFingerprint` is `null` on `PLANNING_FAILURE`. |
| `rulesApplied` | The registry ids actually executed, in order. |

- **`SUCCESS`** — a complete draft that passes the Phase 4A validator. Only this outcome may be persisted.
- **`VALIDATION_FAILURE`** — a complete draft the planning rules reject. Nothing is persisted; the findings
  name exactly what is short.
- **`PLANNING_FAILURE`** — the rules could not finish (invalid or insufficient input, unsatisfiable request,
  failed internal integrity check). Nothing is persisted.

The engine never emits a partial executable plan: a run that could not be completed is reported as a failure,
not as a shorter plan.

### Naming, against the phase brief

The Phase 4B brief described the result as `PlannerResult { productionPlan, plannerVersion, inputFingerprint,
outputFingerprint, warnings, errors, planningTrace }`. The shipped names are the same contract split by who
owns the data, because "the plan" means two different things at two layers:

| Brief name | Shipped | Why the rename |
| --- | --- | --- |
| `PlannerResult` | `PlannerRun` | The engine's report is about a *run*; the durable thing is a plan version. `PlanProductionResult` is the service's report, and the two must not share a name. |
| `productionPlan` | `run.draft` (engine) → `result.plan` + `result.version` (service) | A `SUCCESS` draft is not yet a plan; the service is what turns it into a plan row and a version row. |
| `warnings` | `run.notices` with `severity: "WARNING"` (and `INFO`) | Notices carry the rule that produced them and the field they concern, so an operator can act on them; `findings` stays reserved for validator output. |
| `errors` | `run.errors` — the `ERROR` notices flattened, with the outcome set | Same field, and the outcome field says which kind of failure it was. |
| `planningTrace` | `run.trace` (`PlannerTraceStep[]`, a core contract) | Reuses the existing trace-step shape rather than inventing a planner-specific one. |
| `planningOptions`, `plannerConfig` | `options`, and versions stamped from `@flowforge/core` | Options keep the name the 4A commands use; versions are deliberately not caller-supplied. |


## 3. How a plan is built (the 12 rules)

`brief-foundation → story-foundation → beat-decomposition → cast-assignment → world-binding → visual-dna-binding → duration-allocation → capability-adaptation → generation-spec-planning → continuity-linking → planned-output-manifest → plan-integrity`

| Rule | What it decides |
| --- | --- |
| `brief-foundation` | Plan title (`options.planTitle` ?? `"<brief title> plan"`); the brief's constraints are carried verbatim into every spec as labelled `constraints`; an unconstrained brief yields an `INFO` (`PLANNER_BRIEF_UNCONSTRAINED`). |
| `story-foundation` | The ordered beats. The operator's `story.beats` win, in their order. Otherwise the story prose is **partitioned** — one establish beat from `beginning`, one develop beat per `developmentScenes` slice of `development`, one resolve beat from `ending`, each carrying its own sentences verbatim. A derived beat's title is its first
  sentence, truncated at 72 characters with an ellipsis when it is longer — shortened, never reworded. A missing movement is an error (`PLANNER_STORY_INCOMPLETE`): the planner does not write narrative on the operator's behalf. A `structure` the operator gave is kept; otherwise it is derived (`"3-movement story in 4 beat(s): 1 establish, 2 develop, 1 resolve"`). Cast/world claims naming an unknown beat key are errors (`PLANNER_BEAT_KEY_UNKNOWN`). |
| `beat-decomposition` | One scene plan per beat, `sceneNumber` dense from 1. `sceneKey` is the slug of the beat's own `key`, else its title, else `scene-N`, **position-free**, with `-2`, `-3`, … suffixes allocated on collision — so inserting a scene never renames the scenes behind it, which is what lets scene keys stay meaningful across versions. Title and narrative purpose are the beat's own text. |
| `cast-assignment` | Who appears where: explicit `beat.characters` first; else a cast member that declared `scenes` appears only in those beats; else every cast member appears in the establish/resolve beats and rotates across develop beats by `(seed + position - 1) % cast.length`. Rotation is index arithmetic, so the same input and seed seat the same people. A cast member who ends up in no scene is reported (`PLANNER_CAST_MEMBER_UNSCENED`, WARNING) rather than quietly dropped, and an empty cast is an `INFO` (`PLANNER_CAST_EMPTY`) because a piece with no declared cast is legitimate. |
| `world-binding` | A scene's world is the beat's own `worldId`, else the world that claims that beat key, else the project's only declared world. Several worlds with no claim leaves the scene **unbound** and warns (`PLANNER_WORLD_AMBIGUOUS`, WARNING): binding "the first one" would be an arbitrary creative decision dressed up as a rule. |
| `visual-dna-binding` | The version-level aesthetic contract: the input's `visualDnaId`, else the project's only visual DNA snapshot. No snapshot warns `PLANNER_DNA_MISSING` and several warn `PLANNER_DNA_AMBIGUOUS` — both WARNINGs; the plan is left without a binding rather than guessed, and 4A validation judges it (`VISUAL_DNA_MISSING`) exactly as it judges a hand-authored plan. |
| `duration-allocation` | Budget = `options.totalDurationMs`, or `scenes × sceneDurationMs` when unset. Fixed-duration beats are honoured exactly; if they alone exceed an *explicit* budget (or the ceiling) the run is refused (`PLANNER_DURATION_OVER_BUDGET`, ERROR), and if they only exceed the *implied* budget the budget is raised to fit, reported as `PLANNER_DURATION_BUDGET_RAISED` (INFO). The rest is split over the unfixed scenes as `floor(remaining × weight / totalWeight)` with weight `establish 3 / develop 2 / resolve 2`, and the flooring remainder is distributed **one millisecond at a time, heaviest scene first**, so the parts always reconcile to the total. A share below `minSceneDurationMs` is raised to that floor and the plan grows, reported as `PLANNER_DURATION_FLOORED`; a total above `maxTotalDurationMs` is an error (`PLANNER_DURATION_BUDGET_EXCEEDED`). Budget adjustments are notices, never silent edits. |
| `capability-adaptation` | Establishes the envelope: which of `imageGeneration` / `videoGeneration` / `referenceImages` / `batchGeneration` at least one declared candidate supports. With **no** candidates the rule records a `SKIPPED` step and assumes nothing — provider *registry* membership is the service's business and the Phase 4A executability gate keeps that job. No new capability model is introduced here: the engine reads the same `ProviderCapabilities` declarations 4A already uses and derives each spec's `requiredCapabilities` the way 4A derives them. |
| `generation-spec-planning` | One spec per scene per requested kind, `specNumber` dense in the order the kinds were requested. The capability decisions are applied *inside* this rule on purpose: a spec's declared capabilities must equal its own shape, so adapting afterwards would produce exactly the contradiction 4A rejects — both rule ids keep separate trace steps. A kind no candidate serves is an **error that refuses the run** (`PLANNER_KIND_UNAVAILABLE`), never a silently shortened spec list; `outputCount > 1` without `batchGeneration` is clamped to 1 with a WARNING, and references are omitted without `referenceImages` with an INFO (`PLANNER_REFERENCES_SKIPPED`). A scene left with no spec for any other reason is an error (`PLANNER_SCENE_UNSPECIFIABLE`). Video carries `durationMs` equal to its scene target, every spec carries the option's `aspectRatio`, and the brief's constraints travel as labelled `"<KIND>: <value>"` constraint lines. |
| `continuity-linking` | The seam between scenes, stated in the scene plan: the first scene records `Opens the piece: <purpose>.`, every later scene records `Continues from scene plan <key> ("<title>").` and references the previous scene plan, and every non-final scene records `Leads into scene plan <key> ("<title>").`. Then `requiredReferences` names the artefacts that carry it — previous scene plan, world, DNA, cast. These are **always** authored, even when no provider supports `referenceImages`: a scene-plan reference is a statement about the story's continuity, a spec reference is a request to a provider, and a provider limitation must not rewrite the creative record. |
| `planned-output-manifest` | `plannedOutputs` per scene: one `{ kind, count, note: "beat <key>" }` entry per spec that exists. A plan promising zero outputs anywhere is an error (`PLANNER_NO_OUTPUTS_PLANNED`). The manifest is what 4A compares the plan's promises against, and `plan-integrity` requires its totals to equal the specs' totals. |
| `plan-integrity` | The self-check before anything is written: dense unique numbering and keys, unique ids and spec ids, ≥ 1 spec per scene, duration floor, total ceiling, cast limited to declared characters of the plan, `requiredCapabilities` exactly equal to the derived set, video duration equal to its scene target, output counts within `outputCountPerSpec`, and manifest totals equal to spec totals. Any failure is an error (`PLANNER_INTEGRITY_FAILURE`) and refuses the run. |

### The instruction template

Spec instructions are assembled by a fixed template from the bound records — never by a language model, and
never paraphrased afterwards:

```
[<kind>] <scene title> — <narrative purpose>.
Look: <style>; <renderingStyle>; <lighting>; <composition>; <cameraLanguage>; palette: <p1, p2>; mood: <atmosphere>.
Setting: <world name> — <world environment>.
Cast: <name> as <role>, …
Delivery: <brief.style>, <brief.tone> tone, target <durationTargetMs>ms[ scene], aspect <ratio>.
Reference material: world <name>, visualDna <name>, character <name>, …
```

An absent field contributes nothing — not even its label — so a plan with no world says nothing about setting
and a project with no DNA says nothing about look. Each quoted passage keeps the operator's own text, with a
single sentence terminator appended if it had none. Because the template reads only normalized input, the same
input re-plans to the same bytes.

## 4. Canonical normalization and fingerprints

`normalizePlannerInput` runs **before** any rule and **before** both fingerprints. It is documented in the
header of `packages/services/src/planner/normalize.ts`; the rules in brief:

1. **Text**: trim, and collapse internal whitespace runs to single spaces. No case folding, no punctuation
   edits, no paraphrase — the operator's prose survives verbatim.
2. **Empty optionals**: `""`, `"  "`, and an omitted field are the same input.
3. **Identifiers**: trimmed only; never case-folded or reformatted.
4. **Order**: meaningful order (beats, cast, themes, constraints) is preserved exactly. Non-meaningful
   order (capability keys, provider candidates, duplicate references) is sorted or deduplicated, keeping the
   first occurrence.
5. **Numbers**: durations floor to whole milliseconds; counts must be positive integers; unrepresentable
   values are input errors, never silent clamps.
6. **Defaults applied before hashing**: an omitted option and an explicit default fingerprint identically.
7. **Capability vocabulary**: unknown capability keys are input errors.
8. **Irrelevance removal**: only fields a rule can read survive (e.g. a world's `rules` list is not plan input).

Fingerprints use `canonicalize` / `fingerprintJson` in `packages/core/src/canonical-json.ts`: recursively
sorted object keys, array order preserved, no insignificant whitespace, UTF-8, SHA-256 hex, namespaced
(`flowforge:planner-input:v1`, `flowforge:planner-output:v1`, `flowforge:planner-id:v1`) so a digest can
never be mistaken for another key type.

**The input fingerprint hashes the `fingerprintableView` projection**, which excludes the *write-policy* and
*reporting* options `replan` and `includeTrace` (and the service's `asOf`): how a run writes must not change
*what* was planned, or an unchanged re-plan would look like new content and fork a version for a no-op.
`seed` **does** participate, because it shifts cast assignment — it is content, not policy.

## 5. Options reference

| Option | Default | Effect |
| --- | --- | --- |
| `planTitle` | `"<brief title> plan"` | Plan title; part of plan identity (§6). |
| `totalDurationMs` | `scenes × sceneDurationMs` | Duration budget for the whole plan. |
| `developmentScenes` | `2` | Number of derived develop beats when no explicit beats exist. |
| `sceneDurationMs` | `5000` | Default per-scene target when no budget is given. |
| `minSceneDurationMs` | `1000` | Floor per scene. |
| `maxTotalDurationMs` | `3600000` | Ceiling checked by `duration-allocation` and `plan-integrity`. |
| `aspectRatio` | `"16:9"` | `W:H` with positive integer sides, applied to every spec. |
| `outputCountPerSpec` | `1` | Outputs per spec; `> 1` also requires `batchGeneration`. |
| `defaultOutputKinds` | `["image"]` | Kinds for a beat that names none. |
| `seed` | `0` | Deterministic variation knob: shifts the cast rotation and forks the fingerprint, so a re-plan with a new seed is a new plan rather than a collision with the old one. Must be an integer in `0…4294967295`; anything else is an input error, never a clamp. |
| `replan` | `"new-version"` | Write policy, §7. **Excluded** from the input fingerprint. |
| `includeTrace` | `true` | When `false` the rules record no trace steps at all, so `planner_trace_json` is persisted empty of detail — the plan content is unaffected. **Excluded** from the input fingerprint. |

## 6. Identity: which plan, and which rows

Both derivations live in `deterministic-ids.ts`. `plannerId(inputFingerprint, kind, path)` folds the namespace
`flowforge:planner-id:v1`, the input fingerprint, the kind, and the path into one SHA-256 and formats the
digest as a **UUID-shaped deterministic id** (the version and variant nibbles are fixed so the value is a
well-formed UUID). It is deliberately indistinguishable in *shape* from a `randomUUID()` value while being
fully derived: no randomness, and no collision across kinds, because the kind is inside the digest.

- **Plan identity** — `planIdentityId({ projectId, briefId, title })` (namespace
  `flowforge:planner-plan-identity:v1`) answers *which plan does this run target* without running the engine.
  It is deliberately **not** a function of the seed or the prose: re-planning the same piece with a new seed
  lands on the same plan, and the fingerprints say whether anything changed.
- **Row identity** — inside a run, every id is `plannerId(inputFingerprint, kind, path)` for the rule's own
  path (`<beatKey>:<sceneKey>` for a scene, `<sceneKey>/<index>/<kind>` for a spec). The service re-derives
  each row id through `authoringId(inputFingerprint, planVersionId, kind, path)` — **version-scoped**, because
  a row id is a primary key and two versions of one plan legitimately hold the same scene — while content
  fields such as `sceneKey`, `durationTargetMs`, `instructions`, and `requiredCapabilities` come from the run
  unchanged. `scenePlan`-kind references (continuity, `requiredReferences`) are re-pointed from drafted ids to
  row ids: a translation of identity, never of content.

## 7. The service seam: policies, idempotency, and what is written

`PlannerService.plan(PlanProductionCommand)` resolves the input from the read side (project, brief,
definitions, provider declarations), runs the engine, and only for a `SUCCESS` run authors the plan — through
the **existing 4A methods** (`createPlan`, `createPlanVersion`, `setStory`, `setCast`, `addScenePlan`,
`addGenerationSpec`, `validate`, `approve`, `markExecutable`). There is no second write path, so
planner-authored rows are bound by exactly the rules, content hashing, and trigger protection a
human-authored plan gets.

Target resolution, in order:

1. No plan yet → `createPlan` (one version, `DRAFT`), `created: true`.
2. Plan exists with no usable current version → `createPlanVersion` into it, `created: true`.
3. **Content-based reuse**: the current version's recorded `inputFingerprint`, `outputFingerprint`, and
   `contentHash` all match this run (and the stored content hash still recomputes) → `reused: true`, **zero
   writes**, and the reported validation view is the stored one. Re-running a completed plan is a no-op.
4. `replan: "fail"` → `IDEMPOTENCY_CONFLICT` naming whether the content was identical or not.
5. `replan: "in-place"` → legal only against an **editable** (`DRAFT`/`VALIDATED`) version. If that version
   already carries provenance, then the content necessarily changed, and provenance is write-once, so the run
   refuses with `IDEMPOTENCY_CONFLICT` rather than rewriting history. If it holds hand-authored scene plans
   with no provenance, the run also refuses — those rows are work the planner cannot rebuild. Otherwise (an
   empty, unprovenanced version) the planner authors into it.
6. `replan: "new-version"` (default) → `createPlanVersion` with `predecessorVersionId` set, `created: true`.

After authoring, the service records provenance (`setPlanVersionProvenance`) and then **revalidates the
stored rows**, because the authoritative evidence is about rows, not about a draft. If the stored aggregate
fails where the draft passed, the outcome is downgraded to `VALIDATION_FAILURE` with the notice
`PLANNER_PERSISTED_VALIDATION_MISMATCH`, and the version is left an editable `DRAFT` — recoverable,
unapproved, and reported loudly rather than quietly accepted. With `approve: true` the same call additionally
approves (reviewer defaults to `deterministic-planner`) and, when `providers` are named, marks the version
`EXECUTABLE`.

A `dryRun` runs the engine and reports the draft, findings, notices, trace, and both fingerprints — and writes
nothing at all, including provenance.

## 8. Provenance (additive v5 migration, extended by v6)

`production_plan_versions` gained seven nullable columns (schema v5): `planner_version`,
`planner_rules_version`, `planner_seed`, `planner_input_fingerprint`, `planner_output_fingerprint`,
`planner_content_hash`, `planner_trace_json`.

- They are **outside** `version.contentHash`: provenance describes authorship, not creative content, so
  recording it never invalidates the plan or its validation evidence.
- **Write-once, at the version row**: a trigger refuses any `UPDATE` that changes a recorded value. Provenance
  is therefore immutable for the life of that `ProductionPlanVersion`; the way to record a new planner run is
  a new version.
- **Complete-set**: a trigger refuses a partially recorded set (all seven arrive together or not at all), on
  both `INSERT` and `UPDATE`.
- `planner_content_hash` is the version's content hash *at planning time*; the read model compares it with the
  live hash to answer "planned by X and unchanged since" versus "edited after planning".
- A version without provenance is **not** an error: `plan inspect` reports `planner.planned: false`,
  `detail: "authored by hand"`.
- `revise()` copies content into a new version and deliberately does **not** copy provenance — a hand-edited
  copy must not claim planner authorship.
- `DETERMINISTIC_PLANNER_VERSION` (`deterministic-planner-v1`) is distinct from the validator version
  (`planning-deterministic-v1`) and is stored per version, so a future planner version cannot silently
  reinterpret an old plan — it can only produce new ones.

## 9. The execution seam (service-level only)

`mapPlanToJobs(snapshot, { providers, allowUnapproved?, priority?, maxAttempts? })`
(`packages/services/src/plan-execution.ts`) turns an approved snapshot into `CreateGenerationJobIntent`s:

- `sceneId = plannerId("plan:<planId>", "execution-scene", sceneKey)`;
  `jobKey = plannerId("job:<scope>", kind, "<sceneKey>/<specNumber>")`, where
  `scope = version.plannerOutputFingerprint ?? version.contentHash`;
- parameters `{ aspectRatio ?? "16:9", outputCount, durationMs? }`;
- blockers `["PLAN_NOT_APPROVED"]` unless the version is approved (or `allowUnapproved` is set); provider
  selection itself is the 4A execution preview's decision, which this function consumes rather than repeats;
- a spec with no capable provider is reported in `skipped` with reason `NO_CAPABLE_PROVIDER`, never silently
  dropped;
- the result is `{ planId, planVersionId, versionNumber, status, mappingScope, blockers, intents, skipped,
  unboundReferenceCount }`, and it **emits intents only** — no `GenerationService` call, no queue write, no
  job row.

**Phase 4B ships no CLI command that executes a plan.** The mapping exists at service level and is proven by
deterministic tests; wiring it to a submit call is a later phase's decision. `flowforge plan preview` stays the
read-only view of what would be submitted.

## 10. CLI reference

```
flowforge planner rules [--json]
    Prints the registry (ids, order, summaries, reads), both versions, and the defaults — what the engine will do.

flowforge planner run --project-id ID [--brief-id ID] [--plan-title TEXT]
                      [--story-json JSON] [--cast-json JSON] [--worlds-json JSON]
                      [--visual-dna-id ID] [--options-json JSON]
                      [--seed N] [--scenes N] [--duration-ms N]
                      [--providers CSV] [--dry-run] [--approve] [--reviewer NAME]
```

- `--scenes N` sets `developmentScenes`, `--duration-ms N` sets `totalDurationMs`, `--seed N` sets `seed`, and
  a flat flag overrides the same key inside `--options-json` — one knob can be changed without rewriting them
  all.
- Exit `0` on `SUCCESS`, `3` (`EXIT_BLOCKED`) on any failure outcome; the JSON payload is printed either way,
  so a failure stays machine-readable.
- A failure writes nothing, and `nextAction` says so.
- `--dry-run` reports `plan: null` plus the fingerprints the real run would record — verified identical to the
  subsequent write's fingerprints.
- `plan inspect` / `plan versions` show the planner view (`planned`, `plannerVersion`, `rulesVersion`, `seed`,
  `traceSteps`, `contentMatchesProvenance`, `detail`).
- There is **no** `planner execute` / `planner submit` / `planner queue` command, and tests assert that
  boundary stays closed.

## 11. Notices

`PLANNER_INPUT_INVALID`, `PLANNER_STORY_INCOMPLETE`, `PLANNER_BEATS_EMPTY`, `PLANNER_BEAT_KEY_UNKNOWN`,
`PLANNER_CHARACTER_UNKNOWN`, `PLANNER_CAST_EMPTY`, `PLANNER_CAST_MEMBER_UNSCENED`, `PLANNER_BRIEF_UNCONSTRAINED`,
`PLANNER_WORLD_AMBIGUOUS`, `PLANNER_DNA_MISSING`, `PLANNER_DNA_AMBIGUOUS`, `PLANNER_DURATION_BUDGET_EXCEEDED`,
`PLANNER_DURATION_BUDGET_RAISED`, `PLANNER_DURATION_FLOORED`, `PLANNER_DURATION_OVER_BUDGET`,
`PLANNER_KIND_UNAVAILABLE`, `PLANNER_REFERENCES_SKIPPED`, `PLANNER_BATCH_UNAVAILABLE`,
`PLANNER_SCENE_UNSPECIFIABLE`, `PLANNER_NO_OUTPUTS_PLANNED`, `PLANNER_INTEGRITY_FAILURE`,
`PLANNER_PERSISTED_VALIDATION_MISMATCH`.

Only `ERROR` notices refuse the run; `WARNING` and `INFO` notices travel with the result and the trace so an
operator can see what the engine decided and why. Validator findings keep their own 4A code space (`PLAN_*`,
`VISUAL_DNA_MISSING`, `CAPABILITY_*`) and are never relabelled as planner notices. Service-layer failures use
the existing `ApplicationError` codes (`VALIDATION_FAILED`, `IDEMPOTENCY_CONFLICT`, `PLAN_NOT_EDITABLE`,
`PLAN_NOT_APPROVED`, `PLAN_CAPABILITY_UNMET`, `PERSISTENCE_REJECTED`, `PLANNING_NOT_CONFIGURED`,
`PROVIDER_NOT_CONFIGURED`, `NOT_FOUND`); no new error-code space is introduced.

## 12. How determinism is tested

| Property | Test |
| --- | --- |
| Byte-identical repeat runs; `asOf` invisible to fingerprints | `packages/services/test/planner-engine.test.mjs` |
| Purity: no randomness/clock/I/O/model imports in `src/planner` | engine test, source scan (comments stripped first) |
| Capability adaptation, duration partition/floor/ceiling, scene-key slugs and collisions, continuity, manifest, seed shifting only cast rotation, documented defaults | engine test |
| Identity derivations and `planIdentityId` stability | engine test |
| Zero-write reuse, new-version fork (same plan, new version), `in-place` legality and its two refusals, `fail` policy, dry-run purity, nothing-written-on-failure, recorded provenance, edited-version-stops-claiming, invalid input reported not thrown | `packages/services/test/planner-service.test.mjs` |
| A version edited after planning stops claiming planner authorship (`contentMatchesProvenance`), and write-only knobs do not change what the plan is | service tests |
| `mapPlanToJobs` determinism, "creates nothing", and refusal to map an unapproved version | service test |
| Columns nullable, outside the content hash, write-once, complete-set, no provenance on copies | `packages/storage/test/planner-provenance.test.mjs` |
| Canonical JSON ordering/stability, fingerprint namespaces | `packages/core/test/canonical-json.test.mjs` |
| Operator surface (rules, dry run, authored version, failure exit codes, no execution command) | `apps/cli/test/planner-cli.test.mjs` |
| An AI-proposed plan is the same plan a hand-authored equivalent produces (same input and output fingerprints, same rows), with AI metadata outside both | `packages/services/test/ai-planner.test.mjs`; see [ai-planning.md](./ai-planning.md) §12 for the rest of that map |

## 13. Changing the planner

1. A rule whose *decisions* change requires bumping `PLANNING_RULES_VERSION` in `@flowforge/core` — a
   behaviour-preserving refactor does not. Existing versions keep naming the version that produced them;
   nothing reinterprets them.
2. Add a rule to `PLANNER_RULES` (registry order *is* the algorithm), give it `reads`, have it record a trace
   step, and document it in §3 above. The CLI test pins the registry ids and their order, so adding a rule is a
   reviewed change to all three at once: code, `planner rules`, and this document.
3. Never introduce I/O, randomness, a clock, a model, or a provider instance into `src/planner`; the purity
   scan is not negotiable. Anything the rules must know belongs in `PlannerInput` and in normalization.
4. Anything that changes creative content must be inside the input fingerprint; anything that only changes how
   a run writes must stay outside it (see `fingerprintableView`).
5. Keep provenance write-once. If a future phase needs to re-plan into a version that already carries it, that
   is a new version, not an update — the trigger is the guarantee, not an obstacle.
6. A new *input channel* needs the same treatment as any other `PlannerInput` field: type it, normalize and
   bound it, fold it into the fingerprint, keep it out of `fingerprintableView`'s exclusions only if it changes
   content, and add a golden that shows an omitted-channel input is unchanged. Phase 4C did exactly this for
   `StoryBeatInput.continuityNote` and judged `PLANNING_RULES_VERSION` not to move, because no rule's decision
   changed and every input that omits the field produces byte-identical output — the golden suite is the
   evidence for that judgement, not the intent behind it. A change to what a rule *decides* is a different
   matter and always bumps the version.

## 14. Who else feeds this engine

`PlannerInput` is the only door into the rules. Phase 4C's AI planner is a *producer* of that door's contents —
it reads the brief and definitions, asks a model for a structured proposal, refuses anything malformed or
unresolvable, and calls `PlannerService.plan()` with planner input like any other caller. The engine gains no
knowledge of models, adapters, providers, or prompts, and its purity scan still passes: nothing in
`src/planner` imports I/O, and the AI code lives in `packages/services/src/ai-planner/` and
`providers/openai-chat`. The contract, the proposal schema, provenance, and the fail-closed rules are in
[ai-planning.md](./ai-planning.md).
