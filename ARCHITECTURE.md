# FlowForge Architecture

- **Baseline audit:** 2026-10-04, commit `f8b7019c1b924bc4a25b6642c5e1dc18e63578ef`.
- **Current status:** Phase 1 mock-backed slice is implemented; Phase 2 Google Flow browser provider is implemented and fake-tested; Phase 3 adds the application-service layer and the operator CLI on top of them; Phase 4A adds the creative planning domain (briefs, versioned production plans, story, cast, worlds, Visual DNA, scene plans, generation specs, deterministic validation, capability gating) above that spine without touching it; Phase 4B adds the **deterministic planner engine** that authors those contracts as ordinary plan versions (2026-10-05).
- **Live-provider status:** no authorized CDP/browser session was available. Real Flow submission, status, correlation, and download are **BLOCKED / NOT RUN** and are not claimed as passing.

## Executive summary

FlowForge is a provider-neutral creative-production system. The local project graph and persisted workflow metadata—not a provider's workspace—are canonical. Phase 1 now exercises a complete local path:

```text
Project → SceneVersion → idempotent Job → durable SQLite Queue
        → provider-neutral Worker → MockGenerationProvider
        → filesystem Asset → deterministic QC → Review → selected version
```

The core, SQLite migrations/repository, queue/worker, filesystem asset store, QC, MockProvider, and CLI remain the proven local path. Phase 2 adds an isolated `GoogleFlowProvider`, generic browser-gateway operations, fake-based gateway/provider/queue tests, and an opt-in live smoke script. The Flow adapter currently implements one visible single-image workflow and reuses the existing queue, asset import, and deterministic QC. It is **not live-validated**: no authorized browser session was available, so real Flow selectors and behavior remain unverified.

Phase 4A adds a **planning domain**, not an AI planner. Creative intent becomes durable and versioned:
`CreativeBrief` snapshots feed a `ProductionPlan` whose numbered versions carry a story, cast, world and
Visual DNA references, ordered `ScenePlan`s, and provider-neutral `GenerationSpec`s. Each version walks an
explicit `DRAFT → VALIDATED → APPROVED → EXECUTABLE` lifecycle decided by a pure deterministic validator
and by the *existing* provider capability model, and approval is bound to a content hash so edited content
can never be approved by old evidence. Planning never creates a scene, a job, a queue item, or a provider
call: `plan preview` derives the exact Phase 3 commands a later phase would issue. Phase 4B (deterministic
planner engine) and Phase 4C (optional AI planner adapter) are the only layers that may *author* this data,
and both consume the same contracts. The model, lifecycle, validation rules, persistence, and CLI are
documented in [docs/planning-domain.md](./docs/planning-domain.md).

Phase 4C puts an optional **AI planner adapter** in front of that engine: `AiPlannerService` reads the same
brief and definitions, asks a provider-neutral `AIPlanner` port for a `PlanningProposal`, refuses anything
that is not a schema-valid proposal for this project, translates names into ids, and hands the result to
`PlannerService` — the only author of plan rows. The adapter holds no repository, queue, worker, browser, or
credential store, so it can propose and nothing else; invalid output ends the run with nothing written, and a
deterministic re-plan happens only when the operator asks for it. The version records which adapter, model,
schema version, and digests produced it in additive v6 columns that sit outside the plan's content hash. The
port, proposal schema, provenance, security, and failure model are in [docs/ai-planning.md](./docs/ai-planning.md).

Phase 4B adds the **deterministic planner**: `runPlanner(PlannerInput) → PlannerRun` in
`packages/services/src/planner/` turns an explicit brief + story + project definitions + provider capability
declarations into a complete plan draft through a frozen registry of 12 named, versioned rules — no LLM, no
randomness, no clock, no I/O, no provider instance, and no queue submission. `PlannerService` then authors
that draft as an ordinary plan version using only the 4A service methods, records write-once provenance
(planner version, rules version, seed, input/output fingerprints) in additive v5 columns, and reuses the
existing content-based idempotency: an identical re-run writes nothing. `mapPlanToJobs` emits the exact Phase 3
commands a later phase would submit and submits none of them; there is no CLI execution command. Contracts, the
rule catalogue, canonical normalization and fingerprints, replan policies, and the determinism test map are in
[docs/planner-engine.md](./docs/planner-engine.md).

Phase 3 adds `packages/services` between that durable engine and the operator. The services validate a command, delegate each state change to the single component that already owns it, and project stored state into read models; they own no queue, storage, retry algorithm, provider selection, browser access, or asset-byte handling. `apps/cli` grew subcommands over those services, so the durable engine is operable end to end: project → scene → version → request → queue → provider → asset → QC → review → selection → production-ready scene. There is still no web UI, HTTP API, or worker daemon.

Public research and implementation status are recorded in [FEATURE_MATRIX.md](./FEATURE_MATRIX.md). The staged plan is in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md), runnable Phase 1 details in [docs/vertical-slice.md](./docs/vertical-slice.md), Phase 2 details in [docs/google-flow-provider.md](./docs/google-flow-provider.md), Phase 3 service/operator design and commands in [docs/application-services.md](./docs/application-services.md), Phase 4A planning domain in [docs/planning-domain.md](./docs/planning-domain.md), the Phase 4B deterministic planner in [docs/planner-engine.md](./docs/planner-engine.md), the Phase 4C AI planning boundary in [docs/ai-planning.md](./docs/ai-planning.md), browser mechanics in [docs/browser-gateway.md](./docs/browser-gateway.md), and trade-offs in [DECISIONS.md](./DECISIONS.md).

## 1. Current repository map

The pnpm workspace retains TypeScript/ESM, strict checking, and SQLite. It now contains the original browser foundations plus the Phase 1 packages and CLI.

```text
apps/
  cli/                        operator subcommands plus the mock-backed vertical-slice command
  browser-gateway/            existing local CDP diagnostics and smoke scripts

packages/
  core/                       typed entities, statuses, provider port, canonical JSON/fingerprints,
                                and planner/validator version constants
  storage/                    SQLite v6 migrations and transactional repositories (execution + planning state)
  queue/                      durable claim/lease/recovery worker
  services/                   application services: validation, orchestration, read models (execution +
                                planning), the deterministic planner engine, the AI planning orchestration
                                (schema validation, translation, provenance), and the read-only
                                plan→execution mapping
  assets/                     filesystem asset bytes and streaming SHA-256
  qc/                         deterministic file/MIME/image QC
  browser/                    Playwright/CDP gateway for a user-controlled session
  events/                     initial event vocabulary, not a durable outbox

providers/
  mock/                       deterministic, file-backed Phase 1 provider
  google-flow/                visible-UI single-image provider; live UI unverified
  openai-chat/                Phase 4C AI planning adapter behind the AIPlanner port; structured output only
```

| Package | Current responsibility | Important limit |
| --- | --- | --- |
| `packages/core` | Project/scene/version/job/attempt/queue/asset/QC/review contracts; planning contracts (brief, plan version, story, cast, world, Visual DNA, scene plan, generation spec, validation finding/record, planner trace step) with the plan-version transition table, the canonical JSON/fingerprint helpers, and the `DETERMINISTIC_PLANNER_VERSION`/`PLANNING_RULES_VERSION` constants, and the Phase 4C planner port with its versioned proposal schema (`AIPlanner`, `AIPlanningRequest`/`AIPlanningResponse`, `PlanningProposal`, `AI_PLANNING_SCHEMA_VERSION`, `AI_PROPOSAL_LIMITS`, `PlanAiProvenance`, `AIPlannerErrorCode`) and trace stages; explicit provider capabilities; provider-neutral async methods; request context may be passed to lookup/status/download for safe reconciliation; job, scene, and project status transition tables. | No API schema layer, UI, or workflow-agent tools; no Flow/browser concepts; no planner, adapter, LLM, or heuristic authoring logic; the domain names no model vendor, and owning a port is not owning a proposal decision. |
| `packages/storage` | SQLite WAL, foreign keys, busy timeout, versioned migrations, projects/scenes/immutable scene versions, canonical generation identity, queue items/leases, attempts, asset versions, QC, review, selection, guarded scene/project status writes, and operator listing filters; the Phase 4A planning tables, lifecycle triggers, content hashing, plus the Phase 4B v5 planner-provenance columns and their write-once/complete-set triggers, and the Phase 4C v6 AI-proposal provenance columns (ten nullable `ai_*` columns with the same complete-set and write-once enforcement, `ai_response_fingerprint` free to be NULL or back-filled), and `SqlitePlanningRepository`; retains character and legacy asset methods. | SQLite remains a local/single-worker store; no event log/outbox or distributed concurrency. |
| `packages/queue` | Atomic claim, lease heartbeat, expired-lease recovery, same-attempt provider lookup, retry classification, file import/QC, and transactional finalization/ack. | Current worker accepts one distinct output; no background daemon/service. |
| `packages/services` | Typed application services (`Project`, `Scene`, `Generation`, `Queue`, `Review`, `Production`) over the existing repository/queue/worker; command validation, capability admission, derived production readiness, and operator read models; the Phase 4A planning services (briefs, definitions, plans, validation, reads) including the pure deterministic validator and the capability gate; and the Phase 4B deterministic planner (pure 12-rule engine), `PlannerService`, and the read-only `mapPlanToJobs` seam; and the Phase 4C AI planning layer — `AiPlannerService`, the proposal schema validator, `translateProposal`, and the namespaced request/proposal/response digests. | Owns no SQL, queue, retry, provider, browser, or asset-byte logic; cannot bypass a repository transition guard; validation and approval never execute anything. The AI layer owns no transaction and no lifecycle write, delegates authoring to `PlannerService`, and treats an adapter answer as untrusted data: it may build planner input, never a plan. |
| `packages/assets` | Safe local path construction, atomic file publication, integrity checking, streaming SHA-256, bytes outside SQLite. | No object-store backend or retention/garbage-collection service. |
| `packages/qc` | Deterministic existence, readability, MIME/signature, size, checksum, and supported image dimensions. | No semantic continuity QC, video/audio probe, or unsupported-format dimension guess. |
| `providers/mock` | `SUCCESS`, `TRANSIENT_FAILURE`, `PERMANENT_FAILURE`, `TIMEOUT`, and `DUPLICATE_RESULT`; request-key manifests and deterministic local image bytes. | Proves the orchestration contract only; it is not a generative model. |
| `providers/google-flow` | Provider-port implementation for one visible single-image path; central Flow semantic targets, manual session/auth status, durable non-secret recovery manifest, visible correlation, and browser download. | Fake-tested only. No live Flow behavior passed; video/references/settings/batch are unsupported. |
| `providers/openai-chat` | The shipped `AIPlanner` adapter: builds a bounded chat-completions request with a strict JSON-schema response format, maps transport and provider failures onto the domain's `AI_*` codes, and returns the model's document for validation. | Reads its key from an environment variable by name at call time; stores and returns nothing credential-shaped, caps response bytes and time, retries nothing, and has no write, queue, browser, or execution path. A live endpoint is an optional manual smoke, never a build or test dependency. |
| `packages/browser`, `apps/browser-gateway` | Provider-neutral Playwright/CDP gateway with stable tab selection, observe/wait, click dispatch, guarded fill, hover, upload/download events, and redacted diagnostics; fake transport tests. | Fake transport tests do not validate real Chrome or Flow. Visible page text is sensitive application data and callers must not log it. |
| `packages/events` | Existing event type vocabulary. | No persisted event stream, transactionally written outbox, or dispatcher. |

## 2. Phase 1 domain and persistence

### Project graph

`Project` owns `Scene` identity. A `SceneVersion` is an immutable prompt/reference/metadata snapshot with an optional parent and version number. `scenes.current_version_id` is an explicit pointer, not an in-place edit. Repeating creation by stable version ID/content returns the existing snapshot without reselecting an older version.

A new `GenerationJob` pins the exact project, scene, and scene version, plus provider, request parameters, prompt, and references. Its canonical identity is SHA-256 of the stable request data. A SQLite unique index prevents duplicate logical jobs; job creation and its queue item are committed in the same transaction. Per-attempt keys append a stable attempt number to the logical key.

An accepted output is represented by `Asset` + immutable `AssetVersion`, linked to project/scene/scene version/job/attempt/provider and carrying storage path, MIME, size, checksum, output index, available dimensions, and metadata. `QCResult` refers to the asset version; `Review` refers to that same exact asset version. The scene's selected asset-version pointer is distinct from both generation and approval.

### SQLite migrations

`packages/storage/src/migrations.ts` owns forward-only `PRAGMA user_version` migrations through schema version 6 (v4 is the additive planning domain: eleven tables, two `characters` columns, and lifecycle/immutability triggers; v5 adds seven nullable planner-provenance columns to `production_plan_versions` — planner version, rules version, seed, input/output fingerprints, content hash, trace — with triggers that enforce a complete set and refuse any rewrite of recorded provenance; v6 adds ten nullable AI-proposal provenance columns — adapter, adapter version, provider, model, schema version, path, three digests, and a fallback flag — under the same complete-set and write-once rules, with the response digest free to be NULL because a refused answer has nothing to digest). Fresh database creation, schema-v2 forward upgrade, and legacy-schema upgrade are tested. Existing project/scene/character/job/queue-entry/asset tables are retained. Legacy completed jobs are mapped to succeeded; ambiguous active work is marked failed with an explanation and is not auto-enqueued. Where the legacy scene exists, migration creates a scene-version snapshot for provenance.

Database constraints/triggers protect logical job uniqueness, scene-version immutability/ownership, generation/asset provenance links, asset-version and QC immutability, and the terminal nature of review decisions. New jobs and assets are also checked in repository methods before writes. No migration drops or recreates user tables.

## 3. Durable queue and worker recovery

Queue status, priority, availability time, claim time, lease deadline, worker ID, claim count, acknowledgement, and last error persist in `queue_items`. Claiming runs in an immediate transaction. Attempt creation is in the same claim transaction; retries and lease recovery preserve the active attempt rather than incrementing its number. A heartbeat extends an unexpired lease, and every state-changing provider/finalization method checks that the worker still owns that lease.

The worker records the attempt before provider calls and follows this order:

1. If an attempt already has a provider job ID, query its status.
2. Otherwise, ask `findGeneration(providerRequestKey, request)` first. The optional generic request context lets an adapter correlate visible state without keeping another plaintext prompt copy.
3. Only if lookup proves no provider generation exists does it call `createGeneration` with the same stable key. An ambiguous lookup throws a typed `submissionUnknown` error and keeps the same attempt.
4. Persist the provider job ID, query status, and—on success—download the result with the same generic request context.
5. Import the artifact to a deterministic external-file path, validate it, then atomically write asset/version/QC/pending-review/attempt-success/job-success/queue-ack metadata.

A crash after remote acceptance but before SQLite records the provider ID is recovered by the provider lookup on the same request key. A crash after file publication but before DB finalization reuses the integrity-checked deterministic path. A crash after finalization cannot split job success from queue acknowledgement. A stale worker cannot renew or finalize a lease after recovery assigned a new claim.

Queue delivery is at-least-once, not a claim of exactly-once external effects. Safety after ambiguous submission depends on the provider implementing request-key lookup/idempotency. The MockProvider does. A future adapter unable to determine prior state is never supposed to submit a new attempt blindly; bounded same-attempt recovery ends as a visible terminal error that cannot be blindly retried.

### Status and retry model

The job lifecycle is deliberately small: `QUEUED → CLAIMED → RUNNING → SUCCEEDED|FAILED|CANCELLED`. Attempts separately record `CLAIMED`, `RUNNING`, `SUCCEEDED`, `FAILED`, or `CANCELLED`; their provider request/job IDs and recovery count remain persisted. Retryable provider failures schedule the queue item for a later time and create a new numbered attempt when claimed. Uncertain status/result recovery keeps the current attempt.

The initial policy is one local worker. There is no broker, Redis, Kafka, cloud queue, microservice, or distributed database.

## 4. Provider boundary and safety

`GenerationProvider` has a neutral capability record and operations for `findGeneration`, `createGeneration`, `getGenerationStatus`, `downloadResult`, and `cancelGeneration`. Lookup/status/download may receive the same provider-neutral `GenerationProviderRequest` already held by the queue. `MockGenerationProvider` ignores that optional context and remains file-backed so its request-key manifest/result survive repository and worker restarts. Provider errors distinguish retryability and uncertain submission.

`GoogleFlowProvider` is isolated behind that port and uses only `BrowserGateway` visible controls. Its declared capability is one image at a time; video, references, frames, and batch capabilities are false, and non-default settings are rejected. The provider checks manual auth/access status, rejects an empty request prompt or unsupported request, refuses to overwrite a prompt editor that already contains text, writes a recovery manifest before Generate, and correlates only a unique prompt occurrence plus one newly visible accessible image element (video output is not accepted) or a visible active-generation signal. The manifest stores a one-way prompt hash and UI fingerprints, not the plaintext prompt, cookies, or browser storage. Downloads hover the correlated media and require a unique visible Download control. The existing queue then imports the file and runs the same deterministic QC as MockProvider.

Provider error codes distinguish manual authentication/access blocks, changed UI/session state, click timeouts with unknown submission, ambiguous correlation, download failures, and correlated generation failures. A timeout is not a provider failure by itself: uncertain outcomes retain the current attempt so the next lookup inspects the persisted request before any new submission. The queue's durable classification and retry vocabulary are unchanged (`UNCERTAIN_PROVIDER_STATE` defers on the same attempt, bounded recovery terminates visibly, and `retryFailedJob` still refuses a blind resubmission of uncertain work); provider codes remain at the provider boundary rather than becoming a second retry engine. FlowForge supports local queue cancellation. Remote Google Flow cancellation is deliberately unavailable for in-flight work; the adapter never clicks a generic Stop/Cancel control without an unambiguous, tested per-attempt ownership signal.

Fake browser/provider/queue-contract tests pass. They do not validate actual Google Flow UI behavior. Live submission, status, result correlation, and download are **BLOCKED / NOT RUN** because there was no authorized CDP session. If an active/complete result cannot be uniquely associated with the current attempt, the provider raises a typed uncertain error; the queue retains the same attempt and never guesses or blindly resubmits. UI assumptions live only in the provider package. No provider-specific fields were added to core domain types.

Browser use is limited to a user's authorized, manually authenticated session and visible legitimate UI workflows. No authentication/CAPTCHA bypass, cookie/token extraction, private API, hidden endpoint, or provider-restriction evasion is permitted. Access/security challenges and changed/ambiguous UI stop for user action.

## 5. Asset, QC, review, and selection

The filesystem store writes bytes outside SQLite under a deterministic project/scene/job/output path. It uses temporary files and atomic hard-link creation rather than replacing conflicting bytes; existing paths are re-hashed before reuse. SQLite stores provenance/metadata and the SHA-256, not binary media.

QC version `deterministic-v1` validates regular-file existence, readability/non-empty bytes, detected-vs-expected MIME, byte count, SHA-256, and image dimensions. PNG chunks/CRC and decompressed pixel length are checked; dimensions are parsed for PNG, JPEG, GIF, WebP, and BMP. QC is intentionally not semantic: style, prompt adherence, continuity, codec, and duration have no fake pass. Unsupported image dimensions are `NOT_EVALUATED`; media QC is not selected unless all evaluated requirements pass. Current maximum QC input is 128 MiB.

A stored asset version receives `PENDING` review. A decision is explicitly `APPROVED` or `REJECTED` and terminal. Selection requires the exact asset version's approval and passing QC; selecting it updates the scene's current scene-version and selected asset-version pointers together. Neither generation nor review approval silently selects a version.

## 6. Application services and operator surface (Phase 3)

`packages/services` is the composition layer, created by `createApplication(repository, { queue, worker, workerProviderId, providers, defaultMaxAttempts, now })`. `ProjectService`, `SceneService`, `GenerationService`, `QueueService`, `ReviewService`, and `ProductionService` each take the same narrow `JobRepository` port (a structural `Pick` of `SqliteJobRepository`), so a service cannot reach a write that has not been reviewed. `QueueService` drives `LocalQueueWorker.runUntilIdle`; nothing in the layer claims, renews, retries, or finalizes work itself.

Command behaviour is deliberately thin: `GenerationService.requestGeneration` checks that the project, scene, and scene version exist and are related, that a provider is registered, and that the request stays inside that provider's declared capabilities, then calls the one repository method that computes the canonical idempotency key and inserts job plus queue item in a single immediate transaction. A repeated command therefore reports `created: false` and reuses the stored job rather than queueing a second submission. Cancellation is delegated to the repository's transition guard, or to the worker (which best-effort contacts its own provider) only when that worker serves the job's provider. Retry pre-checks the same durable evidence used by `retryFailedJob` — including the uncertain-submission block — and then delegates.

Queries are read-only compositions of repository reads: `ProjectOverview`, `SceneListItem`/`SceneDetail`, `GenerationStatus` (job, queue item, attempts, outputs with QC and review, `nextAction`, `safeToRetry`), `QueueStatus`, `ReviewQueueItem`, `SelectionResult`, and `ProductionReadiness`. Production readiness is derived on every call from persisted evidence — current scene version, a succeeded output for that version, no open generation, an explicitly selected asset version, passing deterministic QC, explicit approval, and selection matching the current version — and reported as an ordered list of blocking codes. `READY` is the only new state write; `SceneService` refuses it, and `ProductionService.markReady` sets it only when the derived list is empty, through the guarded `SCENE_STATUS_TRANSITIONS` table in core and `updateSceneStatus` in storage. No new table or migration was needed.

`QueueService` adds one protective rule: before driving the worker it checks that every queued job's provider is one this worker serves, and otherwise refuses with `PROVIDER_COVERAGE_INCOMPLETE`. That prevents an operator from letting the durable worker convert mismatched work into permanent `PROVIDER_MISMATCH` failures.

`apps/cli` routes a leading bare word to the operator commands and keeps the Phase 1 flag-only invocation as the vertical slice. The Phase 4B planner surface (`planner rules`, `planner run`) and Phase 4C's single AI verb (`planner ai-run`) join the same command table, and no command in it executes a plan — the tests assert that `planner execute`, `planner ai-execute`, and an `--execute` flag do not exist. Human and `--json` output come from the same read model; errors carry a stable code, and exit codes are `0` ok, `1` error, `2` usage error, `3` state legitimately blocks the command. Details and the full command list are in [docs/application-services.md](./docs/application-services.md).

## 7. Creative planning domain, the deterministic planner, and the AI adapter (Phases 4A–4C)

The planning layer sits above the Phase 3 services and reuses every guarantee below it. Its shape:

```text
CreativeBrief (project-scoped immutable snapshots, versioned by content)
  └─ ProductionPlan ── current_version_id ──→ ProductionPlanVersion   (the aggregate boundary)
        ├─ PlanStory · cast links · world + Visual DNA references
        ├─ ScenePlan (unique scene key and order) ── scene cast, continuity, references, planned outputs
        │     └─ GenerationSpec (kind, instructions, output count, aspect ratio, duration, references,
        │                        constraints, requiredCapabilities: keyof ProviderCapabilities)
        └─ PlanValidation (append-only evidence: validator version, content hash, findings)
```

- **Lifecycle on the version, not the plan.** `DRAFT → VALIDATED → APPROVED → EXECUTABLE → ARCHIVED`
  with `PLAN_VERSION_STATUS_TRANSITIONS` in core and compare-and-set writes in storage; `revise` copies an
  approved version into a fresh `DRAFT` instead of mutating it, and child writes recompute `content_hash`,
  so an approval bound to changed content fails with `PLAN_VALIDATION_REQUIRED`.
- **One capability model.** A spec's `requiredCapabilities` are `keyof ProviderCapabilities` keys; the
  validator and `markExecutable` read declarations from the same `ProviderRegistry` the worker uses. No
  provider is constructed, no session is opened, and no `supportsX` flag was invented. An unsatisfiable
  plan fails with structured `CAPABILITY_UNAVAILABLE` findings or `PLAN_CAPABILITY_UNMET` detail rows.
- **Database-enforced immutability.** v4 triggers refuse insert/update/delete against children of a
  non-editable version, refuse deletion of approved versions, keep brief/world/DNA/validation rows
  immutable, and require the plan's current-version pointer to belong to that plan — verified with raw SQL
  that bypasses the repository.
- **Persistence shape decision.** Normalized relational tables with foreign keys and uniqueness (not an
  opaque JSON blob), so version semantics, reference integrity, per-child idempotency, and operator
  queries are enforceable and queryable; only leaf payloads are JSON columns, encoded with the existing
  canonical `stableJson`. Rationale and the full table list are in
  [docs/planning-domain.md](./docs/planning-domain.md) §7.
- **The planner authors, nothing else decides.** Phase 4B adds `runPlanner` — a pure function over an
  explicit `PlannerInput` (brief, story, cast and world claims, the project's `definitions`, options, and
  provider capability declarations) executing a frozen 12-rule registry, with documented canonical normalization and
  namespaced SHA-256 input/output fingerprints. Ids are derived, never drawn: plan identity from
  (project, brief, title), row identity from the input fingerprint plus the rule's path, version-scoped at
  authoring. `PlannerService` writes only through the 4A service methods, reuses the content-based idempotency
  (an identical re-run writes nothing), and records write-once provenance; a changed re-plan becomes a new version.
- **AI proposes; the domain decides.** Phase 4C adds a *route*, not an engine: `AiPlannerService` builds the
  request from reviewed reads, `validateProposal` refuses anything that is not a well-formed document of
  `ai-planning-proposal-v1` (unknown fields included), `translateProposal` resolves the proposal's names
  against the project and fails closed on an unknown or ambiguous one, and the accepted input goes through the
  same 12 rules, the same validator, the same reuse, and the same lifecycle. Plan content is unchanged by the
  route — AI metadata lives outside `content_hash` and outside the planner's input/output fingerprints, so an
  equivalent proposal is the same plan, and a different adapter identity cannot make a plan look edited.
- **Planning/execution boundary.** No planning write touches `generation_jobs` or `queue_items`, and
  `scene_plans` are not `scenes`. The bridge is a read-only execution preview plus the existing Phase 3
  commands; there is no second execution engine. `mapPlanToJobs` (4B) emits typed Phase 3 commands with
  deterministic `jobKey`s and is proven by tests only — Phase 4B ships no CLI command that executes a plan.
- **No event bus.** Planning services call each other directly through `createApplication`; `packages/events`
  stays unused, as decided in Phase 3.

## 8. Deferred work

- No web UI or HTTP API product surface, and no worker daemon: review, selection, and readiness are operator commands over the services, and execution is on demand (`queue run`), not a background loop.
- No live-validated Google Flow behavior: the single-image browser adapter is fake-tested, but real account eligibility, selectors, generation status, result correlation, and download remain untested. Authentication is manual; no provider credentials are stored.
- No multi-output persistence in one job, object storage, global deduplication, or retention/repair daemon.
- The Phase 4A planning graph (brief, plan versions, story, cast, worlds, Visual DNA, scene plans, generation specs) exists and is validated, and the Phase 4B **deterministic** planner authors it. Phase 4C delivered the AI *proposal* adapter behind that boundary, and still absent are agents, autonomous planning loops, and any automation that turns an executable plan into scenes/jobs — `mapPlanToJobs` emits command intents and is never invoked from a command, so submission remains the operator's explicit Phase 3 action. No audio, timeline, render/export, publishing, or analytics.
- No durable event/outbox system or distributed queue.
- No semantic/image similarity evaluator, video/audio codec probe, duration QC, or unsupported image-dimension guess.

These are future phases only when justified; they were not introduced as Phase 1–3 infrastructure.

## 9. Verification

The Phase 1 validation commands and exact outcomes are recorded in [docs/vertical-slice.md](./docs/vertical-slice.md). Fresh and legacy SQLite migrations were exercised with the real `better-sqlite3` native addon. TypeScript build/typecheck and deterministic tests passed as listed there. The local CLI was run twice to confirm that its repeated success run reuses the same job, asset version, and attempt. Browser/CDP runtime and any live Google Flow behavior remain untested and intentionally unused.

Phase 3 added `packages/services` (18 tests) and `apps/cli` operator tests (5), plus `packages/core` transition tests (2) and three new `packages/storage` tests for guarded status writes, reuse reporting, and operator listing filters. `corepack pnpm build`, `typecheck`, `test` (75 tests), and `vertical-slice` all pass on this checkout; no live Google Flow session was run, so provider-side behavior is still **BLOCKED / NOT RUN**.

Phase 4A adds 40 tests on top of those 75 without changing any of them: `packages/core` 5 (lifecycle
table, editability, capability-key parity, spec kinds, validator versioning), `packages/storage` 13
(migration to v4 and v3→v4 upgrade, atomic aggregate writes, ownership triggers, duplicate scene
identity, version copy and lineage, evidence append-only ranking, compare-and-set lifecycle, pointer
and brief pinning, definition versioning, story/cast uniqueness), `packages/services` 16 (lifecycle and
derived next actions, typed refusals, staleness, capability gate, planning/execution separation with a
provably empty queue, revision immutability, read models, `PLANNING_NOT_CONFIGURED`, and 31 enumerated
validator detections over hand-built snapshots), and `apps/cli` 6 (the operator walkthrough, blocked
paths, revision, read-only preview, human/JSON parity, usage errors). Final state on this checkout:
`corepack pnpm build` 11/11 packages, `corepack pnpm typecheck` 11/11, `corepack pnpm -r test` 115/115 at the end of that phase
(core 7, browser 10, qc 4, storage 20, google-flow 22, queue 7, services 34, cli 11), and
`corepack pnpm vertical-slice` reproducing the identical `selectedAssetVersionId` as Phase 3.

Phase 4B adds 50 tests without changing any earlier one: `packages/core` 6 (canonical JSON key sorting,
dropped `undefined` against kept `null`, refusal of values JSON cannot carry, insertion-order independence,
lowercase-hex `sha256Hex`, and fingerprint namespacing), `packages/storage` 7 (nullable provenance columns
outside the content hash, fresh-version semantics and lineage refusal, write-once recording that is idempotent
when repeated identically, editable-version-only writes, the database's own refusal to overwrite or half-write
provenance, and no provenance on a copied version), `packages/services` 30 (15 engine tests:
repeat-run byte identity, the purity source scan, capability/duration/continuity/manifest behaviour, identity
derivation — and 15 service tests: zero-write reuse, new-version fork, `in-place` legality, `fail` policy,
dry-run purity, recorded provenance, persisted-validation mismatch, and `mapPlanToJobs` determinism), and
`apps/cli` 7 (rules, dry run, authored version and provenance, approve to `EXECUTABLE`, failure exit codes, and
the absence of an execution command). Final state on this checkout: `corepack pnpm build` and `corepack pnpm
typecheck` clean across the workspace, `corepack pnpm test` 165/165 at the end of that phase (core 13, browser 10, qc 4, storage 27,
google-flow 22, queue 7, services 64, cli 18), and `corepack pnpm vertical-slice` passing on this checkout
exactly as Phases 1–4A left it: `SUCCEEDED` job, `ACKED` queue, `PASSED` QC, `APPROVED` review, and a repeat
run in the same data directory reusing the same job, asset version, and attempt (the identifiers themselves are
per-database, as they have been since Phase 1). Live Google Flow behavior remains **BLOCKED / NOT RUN**.

Phase 4C adds 28 tests without changing any earlier one: `packages/storage` 3 (the v6 columns outside the
content hash, all-or-nothing provenance on insert and update including the bypassed-repository case, and
write-once identity with the single permitted response back-fill), `packages/services` 18 (route equality with
a hand-authored input, unknown and ambiguous references, prose and malformed answers, schema strictness and
bounds, adapter refusals and a thrown adapter, explicit fallback, dry-run zero writes, idempotent reuse of
equivalent proposals with differing ones forked, `includeTrace:false`, provenance without secrets, AI metadata
outside the content hash, and no execution state touched), and `apps/cli` 7 — with `providers/openai-chat`'s 14
adapter-contract tests running against injected transports and a loopback socket — `corepack pnpm test`
**207/207** across 9 test suites (core 13, browser 10, qc 4, storage 30, google-flow 22, openai-chat 14,
queue 7, services 82, cli 25). No test in the workspace needs a credential or a live model. Live provider behavior remains an optional, documented manual smoke: **BLOCKED /
NOT RUN** for Google Flow execution, and unchanged for the deterministic path.
