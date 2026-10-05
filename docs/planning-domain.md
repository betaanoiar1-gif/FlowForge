# Creative planning domain (Phase 4A)

FlowForge plans before it generates. Phase 4A adds the **planning domain** — the structured
representation of creative intent that sits *above* the execution spine built in Phase 3, without
touching it.

```text
Creative Intent
   ↓
Creative Brief          → Production Plan (versioned aggregate)
                            ├─ Story / Concept
                            ├─ Characters (project identities, reusable)
                            ├─ Worlds
                            ├─ Visual DNA
                            └─ Scene Plans ──→ Generation Specifications
   ↓                                                 ↓
Planning Validation ──→ Approval ──→ Executability ─┤   (explicit, deterministic)
                                                     ↓
                              Phase 3: Scene / SceneVersion → GenerationService
                                     → durable queue → provider → assets / QC / review
```

**Phase 4A is a domain foundation, not an AI planner.** No phase of the planning path contains an agent, an
autonomous planning loop, or a provider call that decides anything: where a model is involved (Phase 4C), it
returns a proposal that the domain's own validator and lifecycle may refuse, and the refusal is the end of the
run. Planning data becomes
durable, versioned, validatable, and executable. Phase 4B then added the *authoring* half — a
deterministic rule engine, still with no model and no provider call — and this document stays the
authority for the aggregate it writes into; the engine itself is specified in
[planner-engine.md](./planner-engine.md). Phase 4C adds an optional **AI proposal adapter** in front of that
engine: a provider-neutral port returns a schema-validated proposal, which is translated into the same
`PlannerInput` and planned by the same rules. It author nothing directly — it writes no SQL, calls no queue,
opens no browser, and cannot make a domain decision the aggregate would not make on its own; a proposal naming
an unknown character, an invented constraint, or an unsatisfiable capability ends the run with nothing
written. The boundary, the proposal schema, and the provenance rules are in
[ai-planning.md](./ai-planning.md); this document stays the authority for the aggregate both phases write into.

## 1. Domain model

All planning types live in `@flowforge/core` (`packages/core/src/planning.ts`) beside the existing
contracts so that storage, services, and the CLI share one vocabulary.

| Concept | Type | Meaning |
| --- | --- | --- |
| Creative intent snapshot | `CreativeBrief` | title, concept, objective, audience, tone, style, constraints, version. The single place a human/upper-layer intent is recorded. |
| Narrative interpretation | `PlanStory` | premise, structure, themes, beginning/development/end of one plan version. |
| Recurring identity | `CharacterRecord` (extended) | stable identity reused across scene plans; now carries `traits` and `visualIdentity`. |
| Environment context | `WorldDefinition` | name, description, environment, rules, visual identity. |
| Cross-shot aesthetic contract | `VisualDnaDefinition` | style, palette, lighting, composition, camera language, rendering style, atmosphere, consistency rules. |
| Structured narrative unit | `ScenePlan` | order, narrative purpose, description, duration target, participating characters, world, Visual DNA, continuity constraints, required references, planned outputs. |
| Execution-ready intent | `GenerationSpec` | kind, instructions, output count, aspect ratio, duration, references, constraints, capability requirements. |
| Aggregate identity | `ProductionPlan` | a project-owned plan with numbered versions. |
| Editable unit | `ProductionPlanVersion` | the lifecycle carrier: story, cast, scene plans, specs, validation evidence. |

**Two decisions about existing concepts.** `Character` already existed (Phase 0/1 persistence,
`characters` table). It is *extended* with trait/visual-identity columns rather than duplicated by a
second "planning character" type, because a recurring identity must be one thing in the system. The
per-plan `role` therefore lives on the plan-version cast link, not on the identity row.
Likewise `ScenePlan` is a new concept, deliberately **not** the executable `Scene`/`SceneVersion`:
creating a scene plan never creates a scene, a job, a queue item, or an asset.

`GenerationSpec` is the only planning type that touches provider vocabulary, and only through the
existing `ProviderCapabilities` model: its `requiredCapabilities` are `keyof ProviderCapabilities`
values (see §5). There is no second "supportsX" system.

## 2. Aggregate boundaries

```text
CreativeBrief           project-scoped, immutable versioned snapshots      (aggregate: none — a record)
WorldDefinition         project-scoped, immutable versioned snapshots
VisualDnaDefinition     project-scoped, immutable versioned snapshots
CharacterRecord         project-scoped identity + per-version cast role     (shared with execution)
ProductionPlan ─────────────── one aggregate, project-scoped
  └─ ProductionPlanVersion ─── the consistency boundary (lifecycle + content hash live here)
       ├─ PlanStory            exactly one
       ├─ cast links           0..n characters with a role
       ├─ ScenePlan            1..n, unique scene key and unique order per version
       │    ├─ cast links, required references, continuity, planned outputs
       │    └─ GenerationSpec  0..n (a scene plan with no spec cannot become executable work)
       └─ PlanValidation       append-only evidence rows
```

A `production_plans.current_version_id` pointer records which version the plan currently means;
`production_plan_versions.predecessor_version_id` records where each version came from. Nothing
outside this aggregate references a scene plan, so execution mapping is the only bridge downward.

## 3. Lifecycle

`PLAN_VERSION_STATUS_TRANSITIONS` in core mirrors the Phase 3 style: a frozen table plus an assert
function, so invalid transitions are impossible rather than discouraged.

```text
DRAFT ──→ VALIDATED ──→ APPROVED ──→ EXECUTABLE
  ↑            │             │            │
  └────────────┴─────────────┴────────────┴──→ ARCHIVED   (terminal)
```

| Transition | Trigger | Guard |
| --- | --- | --- |
| `DRAFT → VALIDATED` | `PlanningValidationService.validate` | deterministic validator returned no `ERROR` finding for the **current** content hash |
| `VALIDATED → DRAFT` | `ProductionPlanService.revise` or `reopen` | edits after validation must be re-validated; the evidence row stays for audit |
| `VALIDATED → APPROVED` | `approve` | status is `VALIDATED`, a `PASSED` evidence row exists for the current content hash, reviewer recorded |
| `APPROVED → EXECUTABLE` | `markExecutable` | status `APPROVED`, evidence still current, ≥1 scene plan with ≥1 spec, every required capability satisfiable by at least one explicitly configured provider |
| `any non-terminal → ARCHIVED` | `archive` | explicit operator choice; content is preserved |
| `APPROVED/EXECUTABLE → DRAFT` | `revise` | **copies** children into a new version number; the approved version is never mutated |

Persistence enforces the same rules as a backstop: content tables carry
`UPDATE ... WHERE status NOT IN ('DRAFT','VALIDATED')` guards and approved/archived rows raise on
any update or delete (same trigger philosophy as `scene_versions`). Editing an approved version is
therefore impossible at the service layer *and* at the database layer.

**Staleness is derived, never trusted blindly.** Every content edit recomputes
`content_hash` (canonical JSON of the version's children, SHA-256). A validation whose recorded hash
differs from the version's current hash is stale, so an approval attempt after an edit fails with a
typed error rather than silently approving changed content.

## 4. Versioning

`planId + versionNumber` identifies a plan version (`UNIQUE(plan_id, version_number)`).
`revise(planId)` copies the current version's story, cast, scene plans, and specs into a new version
(`version_number + 1`, `predecessor_version_id` set, status `DRAFT`). Child rows get new IDs, and the
stable `sceneKey` is what carries identity across versions, so a scene plan in version 3 is
traceable to its predecessor in version 1 without resurrecting the same row. Nothing is deleted: an
approved version keeps its exact content, findings, and hash forever. Briefs, worlds, and Visual DNA
versions are immutable snapshots referenced by ID, so a plan version's inputs are reproducible even
after a newer brief/world/DNA version is created.

## 5. Validation and the provider-capability boundary

`validatePlanVersion(snapshot)` (`packages/services/src/plan-validation.ts`) is a **pure,
deterministic function** over a `PlanVersionSnapshot`. No clock, no randomness, no I/O, no provider
instance. It returns findings:

```ts
{ code: PlanningFindingCode; severity: "ERROR" | "WARNING"; message: string;
  subject: {
    kind: "plan" | "planVersion" | "brief" | "story" | "scenePlan" | "generationSpec" | "world" | "visualDna" | "character";
    id: string;
  };
  details?: Record<string, unknown>; }
```

| Code | Severity | Detected |
| --- | --- | --- |
| `PROJECT_OWNERSHIP_MISSING` | ERROR | plan, version, or snapshot project ownership does not match |
| `BRIEF_UNUSABLE` | ERROR | brief missing, wrong project, or not `ACTIVE` (a superseded snapshot cannot validate) |
| `BRIEF_FIELD_MISSING` | ERROR | required brief fields empty |
| `BRIEF_CONSTRAINT_INVALID` | ERROR | a constraint has an unknown `kind` or an empty `value` |
| `STORY_MISSING` | ERROR | version has no story row |
| `STORY_FIELD_MISSING` | ERROR | premise empty, or a declared beginning/development/ending is empty |
| `SCENE_PLANS_EMPTY` | ERROR | no scene plans — blocks an empty executable plan |
| `SCENE_ORDER_CONFLICT` | ERROR | duplicate `scene_number` within the version |
| `SCENE_KEY_DUPLICATE` | ERROR | duplicate `sceneKey` within the version |
| `SCENE_REQUIRED_FIELDS_MISSING` | ERROR | empty title or narrative purpose |
| `SCENE_DURATION_INVALID` | ERROR | `durationTargetMs` present but not a positive safe integer |
| `CHARACTER_UNKNOWN_REFERENCE` | ERROR | cast or scene cast references an ID outside the project |
| `CHARACTER_NOT_IN_CAST` | ERROR | a scene uses a character the version did not declare |
| `CHARACTER_PROFILE_INCOMPLETE` | ERROR | a cast character has no traits or no visual identity, so nothing reproducible could be generated from it |
| `WORLD_UNKNOWN_REFERENCE` | ERROR | scene plan references a world that is not a definition of this project |
| `WORLD_PROFILE_INCOMPLETE` | ERROR | world has neither a description nor an environment |
| `VISUAL_DNA_MISSING` | ERROR | a scene plan resolves no Visual DNA at all — it overrides nothing and the version has no default |
| `VISUAL_DNA_NOT_IN_PROJECT` | ERROR | the referenced DNA (scene-level override or the version's default) is not a definition of this project |
| `VISUAL_DNA_INCOMPLETE` | ERROR | missing `style`, `palette`, `lighting`, `composition`, `cameraLanguage`, `renderingStyle`, or `atmosphere` |
| `SCENE_WITHOUT_GENERATION_SPEC` | ERROR | scene plan has no spec, so nothing could be executed |
| `GENERATION_SPEC_WITHOUT_SCENE_PLAN` | ERROR | spec whose scene plan reference is missing or belongs to another version |
| `GENERATION_SPEC_INVALID_VALUE` | ERROR | empty instructions; non-positive, non-integer, or duplicated output count; output count above 32; malformed aspect ratio (`PLAN_ASPECT_RATIO_PATTERN`, required for image and video specs); duration below 250 ms on any spec that sets one; duration set on a non-video spec; an empty or non-string constraint |
| `GENERATION_SPEC_UNKNOWN_CAPABILITY` | ERROR | requirement not a `keyof ProviderCapabilities` |
| `GENERATION_SPEC_CAPABILITY_MISMATCH` | ERROR | the declared requirements contradict the spec shape: an `image` spec that does not require `imageGeneration`, a `video` spec that does not require `videoGeneration`, a spec carrying references without `referenceImages`, or `outputCount > 1` without `batchGeneration` |
| `CAPABILITY_UNAVAILABLE` | ERROR | with `providers` supplied: no configured provider declares the required capability |
| `DANGLING_PLANNING_REFERENCE` | ERROR | a required reference (`character`/`world`/`visualDna`/`scenePlan`/`asset`) does not resolve inside the plan version; `assetVersion` references are only resolvable after execution, so they are not dangling |
| `SCENE_CONTINUITY_EMPTY` | WARNING | continuity list empty for a plan with more than one scene plan |
| `PROVIDER_CAPABILITY_CHECK_SKIPPED` | WARNING | no provider capability declarations supplied, so satisfiability is unchecked rather than assumed |

`approve` and `markExecutable` add their own typed errors (`PLAN_VALIDATION_REQUIRED`,
`PLAN_NOT_APPROVED`, `PLAN_CAPABILITY_UNMET`) rather than inventing validator codes: a gate that is
not a structural property of the plan is not a finding.

Severity semantics match Phase 3's QC conventions: an `ERROR` blocks validation, a `WARNING` is
recorded and shown but never blocks an approval. Findings are sorted by severity, code, subject kind,
and subject ID, so the same input always renders the same report.

Capability integration reuses the existing model end to end:

- Valid keys come from `PROVIDER_CAPABILITY_KEYS` in core, derived from `ProviderCapabilities`.
- `markExecutable` accepts `providers: string[]` (provider IDs) and resolves them through the same
  `ProviderRegistry` used by `WorkerService` — one capability source, no provider-side change.
- Admission produces **structured** results (`ExecutionPreviewItem.acceptable/reason`, capability
  coverage rows), never a silent downgrade, and validation/enqueueing never constructs a provider
  client: checking a plan against Flow's declared capabilities requires no session, no browser, and
  no credentials.

## 6. Planning/execution separation

No planning write touches `generation_jobs`, `queue_entries`, or `queue_items`. The path from an
executable plan to work is explicit and one-directional:

```text
plan create → validate → approve → markExecutable
  → ProductionPlanService.executionPreview(planId)     (pure read model)
  → operator/upper layer calls existing services:
       ProjectService.createScene / createSceneVersion  (prompt from the spec instructions)
       GenerationService.requestGeneration               (parameters from the spec)
  → existing durable queue → provider → asset/QC/review
```

`executionPreview` proves the boundary by deriving, per spec, the exact `CreateSceneVersion` +
`RequestGenerationCommand` inputs it would produce (title, prompt, mode, output count, aspect ratio,
duration, references, capability requirements, candidate providers). **Phase 4A does not execute a
plan** and there is no second execution engine: the queue, worker, leases, and retry policy stay the
only path to a provider. Phase 5 later added the one command allowed to cross that line — `plan execute`, which
*materializes* durable queued work through the services above and still runs nothing itself
([docs/plan-execution.md](./plan-execution.md)).

## 7. Persistence

SQLite v4 (`packages/storage/src/migrations.ts`), additive: `ALTER TABLE ... ADD COLUMN` for the two
new `characters` columns, plus new tables. No `DROP`, no `DELETE`, no row rewriting, no table
recreation; migration of an existing v3 database is forward-only and repeatable (idempotent DDL,
same `BEGIN IMMEDIATE` + `user_version` discipline as v2/v3).

Phase 4B extends the same file with **v5**, also additive: seven nullable provenance columns on
`production_plan_versions` (`planner_version`, `planner_rules_version`, `planner_seed`,
`planner_input_fingerprint`, `planner_output_fingerprint`, `planner_content_hash`,
`planner_trace_json`), deliberately outside `content_hash` so recording authorship never invalidates
validation evidence. Triggers make the set complete-or-empty and **write-once**: an `UPDATE` that
changes recorded provenance is refused at the SQL level, and `revise()` copies content but not
provenance, so a hand-edited version cannot claim planner authorship.

Phase 4C extends it again with **v6**, also additive: ten nullable AI-proposal provenance columns on
`production_plan_versions` (`ai_adapter`, `ai_adapter_version`, `ai_provider`, `ai_model`, `ai_schema_version`,
`ai_path`, `ai_request_fingerprint`, `ai_proposal_fingerprint`, `ai_response_fingerprint`, `ai_fallback`) with
the same complete-set and write-once triggers, and `ai_response_fingerprint` deliberately exempt from both
rules: a refused answer legitimately has no response to digest, and a digest of an archived response may be
back-filled later, which is an addition rather than a rewrite of who was asked. The columns sit outside
`content_hash` like v5's, so an adapter's identity can never make a plan look edited or invalidate evidence.

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `creative_briefs` | immutable intent snapshots | `UNIQUE(project_id, version_number)`, `supersedes_brief_id` self-FK, no-update/no-delete triggers |
| `production_plans` | aggregate identity + `current_version_id` | `UNIQUE(project_id, idempotency_key)` (partial), parent-match + current-version triggers |
| `production_plan_versions` | lifecycle + content hash carrier | `UNIQUE(plan_id, version_number)`, status `CHECK`, immutability triggers for `APPROVED`/`ARCHIVED` |
| `plan_stories` | story per version | `UNIQUE(plan_version_id)` |
| `worlds`, `visual_dna` | project-scoped immutable definitions | `UNIQUE(project_id, name, version_number)` |
| `scene_plans` | planned units with `world_id`, `visual_dna_id` | `UNIQUE(plan_version_id, scene_number)`, `UNIQUE(plan_version_id, scene_key)`, partial-unique `idempotency_key` |
| `plan_version_characters` | version cast with `role` | `PRIMARY KEY(plan_version_id, character_id)` |
| `scene_plan_characters` | participating cast, ordered | `PRIMARY KEY(scene_plan_id, character_id)`, `UNIQUE(scene_plan_id, position)` |
| `generation_specs` | provider-neutral intent | `UNIQUE(scene_plan_id, spec_number)`, kind `CHECK`, partial-unique `idempotency_key` |
| `plan_validations` | append-only validation evidence | `UNIQUE(plan_version_id, validator_version, content_hash)`, no-update/no-delete triggers |

Three persistence details are worth stating because they are what makes the constraints hold:

- **Aggregate insert order.** `createPlanWithInitialVersion` inserts the plan with
  `current_version_id = NULL`, inserts version 1, then repoints the plan. The
  `production_plan_current_version_must_belong_to_plan` trigger can only validate a pointer whose
  target already exists, so the pointer is the last write of the transaction — and it is enforced
  even against raw SQL that tries to point a plan at another plan's version.
- **Child guards.** A generated family of triggers
  (`<table>_requires_editable_plan_version_{insert,update,delete}`) refuses any insert, update, or
  delete against `scene_plans`, `scene_plan_characters`, `generation_specs`, and the cast/story links
  whose owning version is `APPROVED` or `ARCHIVED`. Status changes never rewrite creative content, and
  the guard is keyed on the version's live status, so a direct SQL write from outside the repository
  is refused too (38 triggers in v4; verified in `packages/storage/test/planning.test.mjs`).
- **Evidence recency.** "Latest validation" is ordered by `created_at, rowid` — append order — and
  never by the random row id. Approval and staleness are decided by whichever row that query returns,
  so two validations inside the same millisecond (or under a fixed test clock) must still rank
  deterministically. `plan_validations` mirrors `qc_results`: immutable evidence rows, uniqueness per
  subject + validator + content state.

**Persistence decision.** Planning data is stored in normalized relational tables with foreign keys
and uniqueness constraints, *not* as an opaque JSON blob on `production_plans`: version semantics,
reference integrity, and per-child idempotency must be enforced by the database, and the operator
read models need to query scenes/specs/casts directly. Only genuinely leaf payloads
(constraints, palette, continuity statements, planned outputs, findings) are JSON columns, encoded
with the existing canonical `stableJson` so hashes are stable across writes. `plan_validations`
follows the `qc_results` precedent (immutable evidence rows, `UNIQUE` per subject+validator+state).
Aggregate writes are transactional, so a plan version is never half-saved and no read observes a
partially applied edit.

## 8. Idempotency

One convention, inherited from Phase 1/3 (`canonicalize` → `stableJson` → SHA-256), with a
planning-scoped prefix so planning keys can never collide with generation keys:

Every new idempotency key is derived with the existing `createIdempotencyKey` helper prefixed with
`plan:`, stored in a partial-unique `idempotency_key` column, and looked up inside the same
transaction as the insert. No new hashing scheme and no new collision semantics:

| Operation | Key material (`plan:` prefix) | Stored / behaviour on duplicate |
| --- | --- | --- |
| `brief create` | `brief:<projectId>:<normalizedJson(title, concept, objective, audience, tone, style, constraints)>` | `creative_briefs.idempotency_key`; returns the existing snapshot, `created: false` |
| `world create` | `world:<projectId>:<name>:<normalizedJson(definition)>` | `worlds.idempotency_key`; returns the existing definition |
| `visual DNA create` | `visual-dna:<projectId>:<name>:<normalizedJson(definition)>` | `visual_dna.idempotency_key`; returns the existing definition |
| `plan create` | `plan:<projectId>:<briefId>:<title>` | `production_plans.idempotency_key`; returns the existing plan **and its current version**, `created: false` |
| `scene plan add` | `scene-plan:<planVersionId>:<sceneKey ?? title>:<title>` | `scene_plans.idempotency_key`; returns the existing scene plan |
| `generation spec add` | `spec:<normalizedJson(spec)>` | `generation_specs.idempotency_key`; returns the existing spec |
| `validate` | `plan-validation:<planVersionId>:<validatorVersion>:<contentHash>` | `UNIQUE(plan_version_id, validator_version, content_hash)`; reuses the recorded evidence row and reports `evidenceReused: true` |

Same identity ⇒ same key ⇒ reused row, which is why re-running an authoring command is safe for an
operator and for tests. Different identity ⇒ different key ⇒ a new row, so a *changed* draft is never
collapsed into the old one — a revalidated version with edited content records a second evidence row
rather than mutating the first. Lifecycle transitions are compare-and-set on the previous status
(`UPDATE … WHERE id = ? AND status = ?`), the same recoverability rule Phase 3 uses for scene and
project statuses, so two concurrent approvals cannot both land.

## 9. Services

`packages/services/src/planning.ts` adds five services over one narrow port
(`PlanningRepositoryPort`, `Pick<SqlitePlanningRepository, …>`), following the Phase 3 philosophy:
validate, orchestrate, project — and delegate every write to exactly one durable owner.

| Service | Responsibility |
| --- | --- |
| `CreativeBriefService` | versioned intent snapshots, current-brief resolution, listing |
| `PlanningDefinitionService` | project definitions: characters (extended identity), worlds, Visual DNA |
| `ProductionPlanService` | plan/version creation and revision, story, cast, scene plans, specs, lifecycle transitions (`approve`, `markExecutable`, `reopen`, `archive`), `currentVersionId` pointer, execution preview |
| `PlanningValidationService` | run the deterministic validator, persist evidence, expose the report and staleness |
| `PlanningReadService` | read models: version list, nested inspection, validation report, execution preview, project planning overview, next action |

The services do **not** own SQL, asset bytes, queue claims, or provider calls — all of those remain
with `packages/storage`, `packages/assets`, `packages/queue`, and the provider adapters. Because they
need no provider access, the planning domain works with no browser session, no Google Flow auth, and
no network at all.

`createApplication` gains an optional `planning` dependency: existing callers and tests are
unaffected, and any planning access without it fails with `PLANNING_NOT_CONFIGURED` instead of a
`TypeError`. There is **no event bus**: the planning services call each other directly, and
`packages/events` stays unused (deliberate; see DECISIONS D-033).

## 10. Operator read models

The CLI renders the same data humans and scripts consume:

- plan **version** (number, ID, status, content hash, predecessor, whether it is the plan's current
  pointer)
- **validity** (latest findings with error/warning counts, `validatorVersion`, `recordedAt`,
  `isCurrent` — true only when the evidence hash still equals the version's content hash)
- **approval state** (version status, reviewer, decided timestamp, which evidence row was approved)
- **executability** (executable flag, the providers recorded at that moment, per-spec capability
  coverage with candidate providers and unsatisfied capabilities, plus remaining blockers)
- **planner provenance** (Phase 4B: `planned`, `plannerVersion`, `rulesVersion`, `seed`, `traceSteps`,
  `contentMatchesProvenance`, and a `detail` sentence). Absent provenance is reported as
  `authored by hand`, never as an error; a mismatch between the recorded content hash and the live one
  is reported as "edited after planning", which is information an operator needs, not a failure.
- **AI proposal provenance** (Phase 4C: `version.ai` — `adapter`, `adapterVersion`, `provider`, `model`,
  `schemaVersion`, `path` (`ai-adapter` | `deterministic-fallback`), `fallback`, and the three digests). A
  version nobody proposed with a model has no `ai` object at all; a fallback version says so explicitly, so an
  audited plan never hides that a model was tried first. The AI stages ride in `plannerTrace` with the rule
  steps, in execution order — one trace per version, never two.
- remaining **validation errors**, full finding list with subjects
- number of **scene plans**, **generation specs**, cast, worlds, and DNA snapshots
- **next action** (`AUTHOR_PLAN`, `VALIDATE_PLAN`, `REVALIDATE_PLAN`, `APPROVE_PLAN`,
  `MARK_EXECUTABLE`, `EXECUTE_VIA_PHASE_3`, `PLAN_ARCHIVED`) and derived **blockers**
  (`PLAN_ARCHIVED`, `PLAN_HAS_NO_SCENES`, `PLAN_HAS_NO_GENERATION_SPECS`, `VALIDATION_MISSING`,
  `VALIDATION_STALE`, `VALIDATION_FAILED`, `PLAN_NOT_APPROVED`, `PLAN_NOT_EXECUTABLE`,
  `CAPABILITY_UNAVAILABLE:<specId>`)

`VALIDATION_MISSING` and `VALIDATION_STALE` are deliberately distinct: a plan that was never
validated is authored work in progress, while a plan whose evidence no longer matches its content is
work that must be re-validated before approval. Read models never throw for absent evidence —
`PlanningReadService.validationView` returns `null`, and only the paths that genuinely require
evidence (`validate`'s report, `approve`, `markExecutable`) call `requireValidationView`. The
execution preview adds `PLAN_NOT_VALIDATED` as its own refusal reason, because a preview is a
read-side gate, not a lifecycle state.

## 11. CLI

Thirty commands, added to the existing `COMMANDS` table (`apps/cli/src/planning-commands.ts`), each
delegating to a service method — the CLI contains no SQL and no direct writes, and renders the same
read models for humans and `--json`. Phase 4B adds two more in a `planner` group
(`apps/cli/src/planner-commands.ts`): `planner rules` prints the engine's frozen rule registry, and
`planner run` plans a project's current brief into an ordinary plan version (`--dry-run`, `--approve`,
`--providers`, `--seed`, `--scenes`, `--duration-ms`). Phase 4C adds one verb to that group —
`planner ai-run`, which asks the configured adapter for a proposal and plans whatever survives validation
(plus `--ai-adapter`, `--ai-model`, `--ai-base-url`, `--ai-key-env`, `--guidance-json`, `--trace`, and
`--fallback deterministic`). There is deliberately **no** `planner execute` and no AI execution variant: both
phases stop at the plan, and the CLI tests assert the absence so it stays that way. Global flags, exit codes (0 ok, 1 error, 2 usage error,
3 operator-blocked), and reviewer defaulting are unchanged from Phase 3.

```bash
# intent and project definitions
flowforge brief create --project-id P --title T [--concept TEXT] [--objective TEXT]
                       [--audience TEXT] [--tone TEXT] [--style TEXT] [--constraints-json JSON]
flowforge brief current|list --project-id P            flowforge brief show --brief-id ID
flowforge definition character-create --project-id P --name N [--traits-json JSON] [--visual-identity-json JSON]
flowforge definition world-create --project-id P --name N [--environment TEXT] [--rules-json JSON]
flowforge definition dna-create --project-id P --name N --style S [--palette-json JSON] [--lighting TEXT] …
flowforge definition list --project-id P                # characters, worlds, dna for a project

# the aggregate
flowforge plan create --project-id P --brief-id B --title T [--visual-dna-id ID] [--plan-id ID]
flowforge plan status --plan-id PLAN [--version N]      # version, validity, approval, executability, blockers, next action
flowforge plan inspect --plan-id PLAN [--version N]     # nested tree: brief, story, cast, worlds, DNA, scenes, specs, findings
flowforge plan list --project-id P                      flowforge plan versions --plan-id PLAN
flowforge plan overview --project-id P                  # briefs + characters + worlds + DNA + plans in one view

# lifecycle, each step explicit
flowforge plan validate --plan-id PLAN [--version N]    # runs the validator, records evidence; exit 3 when findings block
flowforge plan report --plan-id PLAN [--version N]      # the recorded report, without re-running the validator
flowforge plan approve --plan-id PLAN [--version N] [--reviewer NAME]
flowforge plan executable --plan-id PLAN [--version N] [--providers mock,google-flow]   # capability gate
flowforge plan preview --plan-id PLAN [--version N]     # execution mapping, never executes
flowforge plan execute --plan-id PLAN [--dry-run] …     # Phase 5: materializes queued work (see docs/plan-execution.md)
flowforge plan execution --plan-id PLAN                  # Phase 5: read-only state of one materialization
flowforge plan executions --plan-id PLAN                 # Phase 5: every materialization of a version
flowforge plan revise --plan-id PLAN [--note TEXT]      # copy the current version into a new DRAFT
flowforge plan reopen --plan-id PLAN                     # VALIDATED -> DRAFT after edits
flowforge plan archive --plan-id PLAN                    flowforge plan set-current-version --plan-id PLAN --version N

# authoring children (so an operator and the tests can drive the whole lifecycle)
flowforge plan story set --plan-id PLAN --premise TEXT [--structure TEXT] [--themes-json JSON] …
flowforge plan cast set --plan-id PLAN --cast-json '[{"characterId":"…","role":"lead"}]'
flowforge plan scene add --plan-id PLAN --scene-key K --title T [--scene-number N] [--world-id ID]
                         [--narrative-purpose TEXT] [--duration-target-ms N] [--continuity-json JSON]
                         [--references-json JSON] [--planned-outputs-json JSON] [--cast-json JSON]
flowforge plan scene cast --scene-plan-id ID --cast-json JSON      flowforge plan scene remove --scene-plan-id ID
flowforge plan spec add --scene-plan-id ID --kind image|video|audio|text --instructions TEXT
                        [--output-count N] [--aspect-ratio 16:9] [--duration-ms N]
                        [--capabilities-csv imageGeneration,referenceImages] [--references-json JSON]
                        [--constraints-json JSON]
flowforge plan spec remove --spec-id ID
```

Two flag conventions are new and documented here because they extend, not replace, Phase 3's:
`--providers CSV` selects which configured providers may satisfy a plan's capability requirements
(`--provider` stays the single-provider selector for generation and worker commands), and `--version N`
targets a specific plan version on any lifecycle or read command — without it the command addresses
the plan's current version. Structured authoring payloads use `--*-json` flags parsed by the existing
`parseJsonOption`, so a malformed payload is a usage error (exit 2) before any service is called.
Rejections are typed: `PLAN_NOT_EDITABLE` and `PLAN_VALIDATION_REQUIRED` surface as exit 3 with
`{ok:false, code, message, details}`, exactly like Phase 3's blocking states.

## 12. Phase 4B/4C boundaries and prohibited scope

- **4A (this phase)**: durable model, versioning, lifecycle, deterministic validation, capability
  gate, execution preview, persistence, CLI, read models.
- **4B — Planner Engine** (*delivered*): deterministic authoring (brief → plan tree) through the 4A
  contracts only. It writes via `ProductionPlanService` and its sibling plan methods, records write-once
  provenance, reuses an identical version instead of writing, and exposes no execution command —
  `mapPlanToJobs` emits Phase 3 command intents for tests, and submitting them stayed an explicit later
  decision (delivered by Phase 5, which submits only through the existing services, in one transaction). Specification: [planner-engine.md](./planner-engine.md).
- **4C — AI Planner Adapter** (*delivered*): an optional adapter behind the domain's `AIPlanner` port
  returning schema-validated planning data, which flows through normalization, the 4B engine, and the 4A
  validator like any other input. It adds no agent, no autonomous planning, no provider-implementation change
  to Google Flow, no browser-automation change, no video generation, no publishing, no analytics, no queue,
  daemon, or event-bus change, and no web UI; the adapter owns no transaction, no lifecycle write, and no
  execution path, and only the AI verb reads a credential variable. Specification:
  [ai-planning.md](./ai-planning.md).
- **Phase 5 — Plan → executable work → durable execution** (*delivered*): one service and one transaction
  materialize an `EXECUTABLE` version into `Scene` + `SceneVersion` + `GenerationJob` + queue items, with a
  readiness gate that writes nothing when it refuses, a deterministic execution fingerprint that makes re-running
  idempotent, and execution left entirely to the existing queue, worker, provider registry, QC, and review path.
  Three thin commands only (`plan execute`, `plan execution`, `plan executions`). Specification:
  [plan-execution.md](./plan-execution.md).

## 13. Verified operator walkthrough

The lifecycle is exercised end to end by `apps/cli/test/planning-cli.test.mjs` and
`packages/services/test/planning.test.mjs`; the sequence below is what those tests assert, in the
order an operator would type it, against a fresh `--data-dir`. Every value is deterministic (fixed
provider capabilities, no clock reads, no network).

| Step | Command | Observed result |
| --- | --- | --- |
| intent | `brief create …` | `created: true`; re-running prints `(existing snapshot reused)` |
| definitions | `definition character-create`, `world-create`, `dna-create` | one row each, `ACTIVE` v1 |
| aggregate | `plan create --project-id … --brief-id … --title … --visual-dna-id …` | `plan-1` with `v1 DRAFT`; re-running prints `(existing plan reused — same project, brief, and title)` |
| empty state | `plan status` | `counts: 0 scene plan(s), 0 generation spec(s) …`, `validity: never validated`, `next action: AUTHOR_PLAN`, blockers `PLAN_HAS_NO_SCENES, PLAN_HAS_NO_GENERATION_SPECS, PLAN_NOT_APPROVED, VALIDATION_MISSING`, exit 0 |
| blocked validation | `plan validate` | `validation: FAILED`, `! SCENE_PLANS_EMPTY`, `status now: DRAFT`, exit 3 |
| author | `plan story set`, `plan cast set`, `plan scene add`, `plan spec add` | each echoes the created row; still no job, no queue item |
| validate | `plan validate` | `PASSED`, `0 error(s)`, auto `DRAFT → VALIDATED`, hint `flowforge plan approve --plan-id … --reviewer NAME`, exit 0 |
| approve | `plan approve --reviewer …` | `APPROVED`, evidence id + content hash recorded, exit 0 |
| gate | `plan executable --providers mock` | `EXECUTABLE`, `spec <id> (open-01, image): capabilities imageGeneration → mock`, exit 0 |
| preview | `plan preview` | `executable: yes  blockers: none`, `Preview only: FlowForge does not create scenes, jobs, or queue entries from a plan in Phase 4A.`, per-scene `command: scene version add … then generate --output-count 1 --aspect-ratio 16:9` |
| freeze | `plan scene add` again | `{ok:false, code:"PLAN_NOT_EDITABLE", message:"Plan version … is EXECUTABLE and cannot be edited in place."}`, exit 3 |
| re-validate | `plan validate` | `content: <hash> (existing evidence reused)`, `status now: EXECUTABLE` — a revalidation never downgrades a decided version, exit 0 |
| revise | `plan revise --note "add the leap"` | `v2 DRAFT`, `copied 1 scene plan(s) and 1 generation spec(s) from v1`, identical content hash (a faithful copy hashes the same), predecessor set, current pointer moved; `plan versions` shows `v1 EXECUTABLE … v2 DRAFT` |
| gates again | `plan approve` on unvalidated v2 | `PLAN_VALIDATION_REQUIRED`, exit 3 |
| capability | `plan spec add --kind video … --capabilities-csv videoGeneration` then `plan validate` | `CAPABILITY_UNAVAILABLE` ERROR (mock declares no video) + `SCENE_CONTINUITY_EMPTY` WARNING, status stays `DRAFT`, exit 3 |
| project view | `project overview` | plan row `v2 DRAFT … validation: FAILED (1 errors, 1 warnings)  next action: VALIDATE_PLAN  blocked: CAPABILITY_UNAVAILABLE, VALIDATION_FAILED` |
| separation | `queue status` | `0 claimable now, 0 claimed, 0 acked, 0 failed, 0 cancelled`, `jobs by status: none` — planning created nothing executable |

Immutability is additionally verified against raw SQL, bypassing the repository entirely, on an
`APPROVED` version: updating or deleting a scene plan or generation spec raises
`cannot add|remove|edit … of a non-draft plan version`; deleting the version raises
`approved plan versions cannot be deleted`; updating or deleting `plan_validations` raises
`plan validation evidence is immutable`; pointing a plan at another plan's version raises
`production plan current version must belong to the plan`; editing a brief snapshot raises
`creative brief snapshots are immutable`. Row counts are unchanged after every refusal.

