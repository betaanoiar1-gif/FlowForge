# FlowForge Engineering Decision Log

- **Started:** 2026-10-04
- **Status note:** D-001–D-012 record Phase 0 architecture/research decisions, D-013–D-018 record Phase 1 implementation choices, D-019–D-022 record Phase 2 provider choices, D-023–D-027 record the Phase 3 application-service and operator-surface choices, and D-028–D-035 record the Phase 4A creative planning domain, and D-036–D-042 record the Phase 4B deterministic planner engine, and D-043–D-049 record the Phase 4C AI planner adapter. and D-050–D-057 record the Phase 5 plan-materialization bridge to durable execution. Implemented behavior and validation status are described in [ARCHITECTURE.md](./ARCHITECTURE.md), [docs/vertical-slice.md](./docs/vertical-slice.md), [docs/google-flow-provider.md](./docs/google-flow-provider.md), [docs/application-services.md](./docs/application-services.md), and [docs/planning-domain.md](./docs/planning-domain.md), and [docs/planner-engine.md](./docs/planner-engine.md), and [docs/ai-planning.md](./docs/ai-planning.md), and [docs/plan-execution.md](./docs/plan-execution.md). Live Flow validation is blocked/not run, and no live model provider is required by any test in this repository.

## D-001 — Google Flow is a replaceable provider, not the product core

- **Date / status:** 2026-10-04 · Accepted
- **Context:** FlowForge must manage a creative project independently of any one generator. The repository has a separate `providers/google-flow` package, but operational generation methods are not implemented.
- **Options:** Make Google Flow-specific requests and state part of core; or define provider-neutral generation ports and keep vendor behavior in adapters.
- **Decision:** Keep the domain and workflow provider-neutral. Providers implement typed operations and report capabilities. Google Flow is one adapter alongside Mock, local, API, and future browser providers.
- **Reason:** Enables deterministic testing, provider replacement, capability-aware planning, and avoids making Flow's current UI or limits the canonical model.
- **Trade-offs:** The adapter must explicitly translate feature differences; some workflows will be unavailable for providers with fewer capabilities.

## D-002 — The FlowForge project graph is the local source of truth

- **Date / status:** 2026-10-04 · Accepted
- **Context:** Generations, reviews, versions, references, and exports need traceable relationships; provider-side projects and collections are not a sufficient production model.
- **Options:** Store only prompt queues and file names; treat the provider workspace as canonical; or persist a separate FlowForge graph and map provider artifacts into it.
- **Decision:** Maintain a local graph with stable IDs and explicit project/scene/character/world/reference/asset/job links. Provider project IDs are external references only.
- **Reason:** Supports scene-level regeneration, project independence, provenance, and multiple providers.
- **Trade-offs:** Requires schema evolution and explicit mapping/synchronization with provider workspaces.

## D-003 — Creative versions are immutable snapshots

- **Date / status:** 2026-10-04 · Accepted
- **Context:** Regeneration must not silently overwrite a prompt or its references; a final render must identify exact source versions.
- **Options:** Mutate a single current scene/prompt record; copy complete projects for each revision; or retain stable scene identity and append immutable scene/prompt versions with a current-selection pointer.
- **Decision:** Use stable parent entities plus immutable `SceneVersion` snapshots. A generation pins its exact scene version, prompt, settings, provider, and references; explicit current-version selection is separate from snapshot creation.
- **Reason:** Scene-level edits remain independent and provenance is recoverable.
- **Trade-offs:** More metadata and UI complexity; retention/cleanup needs an explicit policy rather than destructive in-place edits.

## D-004 — SQLite remains the local-first metadata store; schema changes use migrations

- **Date / status:** 2026-10-04 · Accepted and implemented for Phase 1
- **Context:** SQLite with WAL fits a single-user/local development stage. The original schema was not migration-versioned.
- **Options:** Replace immediately with a server database; keep ad hoc `CREATE TABLE IF NOT EXISTS`; or retain SQLite and introduce forward-only migrations with an upgrade test.
- **Decision:** Keep SQLite, use versioned forward-only migrations (currently schema version 3), and preserve existing tables/data. Revisit a server database only if deployment/concurrency requirements justify it.
- **Reason:** Minimizes disruption and keeps the first slice runnable without extra infrastructure.
- **Trade-offs:** SQLite constrains write concurrency and deployment topology; moving later requires a deliberate repository/migration strategy.

## D-005 — Media bytes are stored outside the relational database

- **Date / status:** 2026-10-04 · Accepted and implemented for local files
- **Context:** The original repository recorded paths and SHA-256 hashes but did not own asset bytes.
- **Options:** Put binary blobs in SQLite; treat filenames as identity; or persist stable asset metadata in SQLite while a filesystem/object-store port manages bytes.
- **Decision:** Keep bytes in an `AssetStore` (local filesystem in Phase 1; object storage is deferred). Database records retain stable asset/version IDs, provenance, storage path, hash, MIME, size, and available dimensions. Hashes support integrity, not entity identity.
- **Reason:** Keeps metadata transactions small, makes media independently portable, and preserves identity across renames.
- **Trade-offs:** File and database writes are not one physical transaction; temporary files, deterministic paths, atomic publication, integrity checks, and restart recovery reduce—but do not remove—the need for future repair/reconciliation tooling.

## D-006 — Queue delivery is at-least-once with explicit idempotency and recovery

- **Date / status:** 2026-10-04 · Accepted and implemented for the mock provider
- **Context:** A remote/browser generation can succeed while FlowForge loses local state. Exactly-once side effects cannot be promised unless a provider offers idempotency/recovery.
- **Options:** Blindly retry after restart; claim exactly-once execution; or persist correlation keys, attempt evidence, leases, and recover/inspect before another submit.
- **Decision:** Use durable at-least-once job delivery with a database-enforced idempotency key per logical request. A worker claims with a lease, persists the attempt/request key before provider side effects, and asks the provider to recover/find prior work before a first/repeated submission. Ambiguous work remains on the same attempt; bounded uncertainty becomes a visible terminal error and blocks blind retry as a new attempt.
- **Reason:** Avoids losing jobs while acknowledging that exactly-once external side effects cannot be promised without provider idempotency/recovery.
- **Trade-offs:** Some providers may not support lookup; ambiguous work may require a new scene version or operator resolution rather than automatic completion. Phase 1's MockProvider has durable lookup; a future adapter must meet this boundary.

## D-007 — Prove the first production path with MockProvider

- **Date / status:** 2026-10-04 · Accepted and implemented for Phase 1
- **Context:** Google Flow access is not available to CI and live generations can consume user quota. The adapter's live methods intentionally throw.
- **Options:** Start with live browser generation; build a mock only after integration; or implement the whole project/job/asset/review lifecycle against a deterministic provider first.
- **Decision:** Build the project → scene version → job/queue → MockProvider → asset → QC → review/version slice before live provider work.
- **Reason:** Tests domain correctness, persistence, idempotency, restart recovery, and provenance without credentials, network, quota, or UI drift.
- **Trade-offs:** The mock proves orchestration only, not a real generator's reliability or fidelity. Live-adapter tests remain separate opt-in work.

## D-008 — Browser automation is user-authorized UI automation only

- **Date / status:** 2026-10-04 · Accepted
- **Context:** FlowForge may operate a user's own authenticated session where appropriate, but must not bypass authentication, CAPTCHA, security controls, provider restrictions, or depend on private APIs.
- **Options:** Use private/undocumented endpoints; extract/replay credentials; or use a browser-session abstraction limited to visible, user-authorized workflows and stop when blocked/ambiguous.
- **Decision:** Keep CDP/Playwright behind `BrowserGateway` and provider-specific UI operations inside the adapter. Never read/store cookies, tokens, or passwords; never bypass challenges or restrictions. Treat access challenges and policy blocks as `BLOCKED` for user action.
- **Reason:** Respects the legal/security boundary and allows the browser provider to be replaced.
- **Trade-offs:** UI changes may break an adapter; public UI may not reveal enough state for safe recovery. In that case FlowForge must pause rather than infer or bypass.

## D-009 — QC must report evidence, not invented semantic scores

- **Date / status:** 2026-10-04 · Accepted and implemented for deterministic file/image checks
- **Context:** File integrity and some media properties can be measured deterministically; character/style adherence requires a real validated evaluator or human review.
- **Options:** Display fabricated completeness/continuity scores; infer success from provider status; or emit measurable checks and mark unimplemented metrics `NOT_EVALUATED`.
- **Decision:** Phase 1 validates existence/readability, supported MIME/signatures, size, SHA-256, and dimensions for PNG/JPEG/GIF/WebP/BMP. Semantic, continuity, duration, codec, and unsupported image-dimension checks are not faked as passed.
- **Reason:** Preserves trust and makes evidence auditable.
- **Trade-offs:** Early QC offers limited creative judgment and still needs explicit review.

## D-010 — Initial execution is sequential

- **Date / status:** 2026-10-04 · Accepted; single-worker policy for Phase 1
- **Context:** Provider/account quotas and browser UI stability differ by provider; no Flow concurrency policy is established.
- **Options:** Parallelize immediately; expose unrestricted concurrency; or start with one worker and make concurrency policy-aware later.
- **Decision:** The Phase 1 CLI runs one local worker at a time. The durable claim protocol is designed to fence leases, but no multi-worker throughput policy is enabled or claimed.
- **Reason:** Safer recovery and simpler sequencing while observability is immature.
- **Trade-offs:** Lower throughput for providers that could safely handle parallel work.

## D-011 — No product UI/API before the first persistent slice

- **Date / status:** 2026-10-04 · Accepted; CLI demo now exercises the slice
- **Context:** There was no `apps/api` or `apps/web`, and domain/queue boundaries were unproven.
- **Options:** Add a dashboard now; grow the browser gateway into a monolith; or validate use cases through persistence, CLI, and automated integration tests first.
- **Decision:** Complete the testable vertical slice before starting a product web/API surface. `apps/cli` is a developer demonstration, not a review UI; `apps/browser-gateway` remains a local diagnostic/session host.
- **Reason:** Avoids coupling UI to unstable persistence and reduces scope without blocking later dashboard work.
- **Trade-offs:** The first milestone is developer/test-facing rather than a polished product experience.

## D-012 — “GA Studio” remains unverified

- **Date / status:** 2026-10-04 · Accepted (research caveat)
- **Context:** The Google Flow Automator Chrome Web Store release history includes “Prepare to support GA Studio” in version 2.8.5, but public sources reviewed do not define GA Studio or specify a supported interface.
- **Options:** Assume it is a Google Flow API/product; build speculative support; or record it as unresolved and wait for authoritative documentation.
- **Decision:** Do not infer ownership, architecture, compatibility, or API from that release-note phrase. Keep FlowForge provider-neutral and revisit only when public documentation establishes safe observable workflows.
- **Reason:** Prevents undocumented/private integration and avoids encoding an incorrect assumption.
- **Trade-offs:** No GA Studio-specific feature is planned until evidence exists. See [FEATURE_MATRIX.md](./FEATURE_MATRIX.md).

## D-013 — Idempotency is based on canonical logical request identity

- **Date / status:** 2026-10-04 · Accepted and implemented
- **Context:** Prompt-only hashes conflate intentional generations; unprotected caller keys can also be reused for different inputs.
- **Options:** Deduplicate by prompt, accept arbitrary keys without a unique constraint, or derive a stable key from a canonical request snapshot and enforce it in SQLite.
- **Decision:** Compute a SHA-256 identity from project, scene/version, provider, prompt/references, and generation parameters; persist both the key and canonical identity under a unique index. Identical requests return the existing job; new scene versions or generation parameters produce a distinct key.
- **Reason:** Prevents duplicate logical queue items while preserving intentional work differences.
- **Trade-offs:** Request-identity fields must be versioned deliberately if the canonical contract changes. Non-generation metadata is excluded.

## D-014 — Uncertain provider success remains the same attempt

- **Date / status:** 2026-10-04 · Accepted and covered by crash-recovery tests
- **Context:** A worker can crash after provider acceptance/success but before storing the provider ID or asset.
- **Options:** Start a new provider request on restart; rely only on the local provider ID; or query the provider by the persisted request key and reuse stable output/asset paths.
- **Decision:** Persist the attempt key before provider calls, call provider lookup before first submission if no provider ID is stored, and resume status/download/finalization on the same attempt. Conflicting bytes at the deterministic asset path are errors, not overwrites.
- **Reason:** Avoids duplicate successful logical generation and duplicate accepted asset after a crash.
- **Trade-offs:** Safe automatic recovery requires provider-side lookup/idempotency. If state remains uncertain, the system surfaces bounded recovery failure and disallows blind same-job retry.

## D-015 — A job accepts one distinct result in Phase 1

- **Date / status:** 2026-10-04 · Accepted and implemented
- **Context:** The provider port can return an artifact list, while the first workflow and finalization transaction are intentionally small.
- **Options:** Silently accept the first item, partially persist a batch, or collapse byte-identical duplicate indexes and reject multiple distinct outputs visibly.
- **Decision:** Collapse exact duplicate outputs that share an output index and bytes. Reject a response containing multiple distinct outputs; the mock declares no batch-generation capability.
- **Reason:** Prevents lost or partially reviewed outputs until batch assets/reviews have a complete model.
- **Trade-offs:** Providers returning several distinct results need a later batch-aware job/finalization design.

## D-016 — Review is exact-version and selection is explicit

- **Date / status:** 2026-10-04 · Accepted and implemented
- **Context:** A review of one output must not accidentally approve a newer/different asset, and generation success is not user acceptance.
- **Options:** Store a scene-level boolean; treat QC/provider success as approval; or persist a review against an exact asset version and require a separate selection call.
- **Decision:** Persist `PENDING`/`APPROVED`/`REJECTED` against an asset version. Final decisions are terminal. Selection requires that exact version's approval and passing deterministic QC, and updates scene current/selected pointers atomically.
- **Reason:** Makes the accepted version and its provenance explicit and auditable.
- **Trade-offs:** A richer production review UI/feedback vocabulary is deferred.

## D-017 — Ambiguous legacy jobs are not replayed during migration

- **Date / status:** 2026-10-04 · Accepted and implemented
- **Context:** The old schema did not contain enough attempt/provider-correlation history to prove whether queued/running jobs had already caused an external generation.
- **Options:** Requeue all old active rows; drop old jobs; or preserve their records, snapshot the scene prompt when possible, and mark ambiguous active work failed for explicit operator review.
- **Decision:** Preserve old rows and map completed records to succeeded. Map ambiguous active/unclassified work to failed with a visible no-auto-replay explanation; do not create new queue items for it.
- **Reason:** Avoids duplicate external work while retaining the user's historical metadata.
- **Trade-offs:** An operator must deliberately create a new versioned request if old work should run again.

## D-018 — Late integrity guards receive a forward migration

- **Date / status:** 2026-10-04 · Accepted and tested for Phase 1
- **Context:** Additional asset-current-version and selected-version QC/approval guards were identified after schema version 2 had already been exercised locally.
- **Options:** Change the already-numbered version 2 migration and leave earlier version-2 databases stale; or add an additive version-3 migration and test the upgrade path.
- **Decision:** Keep schema history monotonic. Version 3 installs the late triggers with `IF NOT EXISTS`; existing version-2 databases upgrade without dropping data, and fresh/legacy databases apply versions 2 and 3 in sequence.
- **Reason:** A database that has already recorded version 2 must not skip a later integrity requirement because the migration source changed.
- **Trade-offs:** Schema version increments for a small guard-only change, and each later schema change must continue to add a forward migration rather than editing historical migrations.

## D-019 — Google Flow stays behind the existing provider and browser ports

- **Date / status:** 2026-10-04 · Accepted and implemented for the Phase 2 code path
- **Context:** Phase 1's queue, MockProvider, asset store, and QC already establish the durable provider-neutral workflow. Rebuilding any of those would create a second source of truth and retry system.
- **Options:** Add Flow selectors to core/queue; replace the worker or MockProvider; or implement an isolated provider using the existing `GenerationProvider` and `BrowserGateway` ports.
- **Decision:** Keep Flow-specific semantics and target definitions inside `providers/google-flow`. Pass the existing generic request object to lookup/status/download only where it is needed for correlation; no Flow/browser fields are added to core domain records.
- **Reason:** Preserves replaceability and lets deterministic MockProvider/queue behavior remain unchanged.
- **Trade-offs:** The adapter is limited to what its one visible workflow can safely observe; unsupported Flow settings are rejected.

## D-020 — Authentication and Flow actions remain visible and manual-session-only

- **Date / status:** 2026-10-04 · Accepted and implemented
- **Context:** The real provider needs a user-controlled browser session but must not bypass account/security controls or collect secrets.
- **Options:** Automate sign-in or use private endpoints; or attach only to the user's configured CDP session and act through visible semantic controls.
- **Decision:** Use CDP through `BrowserGateway`; report auth/block status from visible page state; leave sign-in and challenges to the user. Redact diagnostic output and never read/store/log cookies, credentials, tokens, or browser storage.
- **Reason:** Makes the access boundary explicit and ensures security challenges are never treated as automation tasks.
- **Trade-offs:** A user must keep a manually authenticated session available; UI changes can safely stop the provider.

## D-021 — Ambiguous Flow state remains on the same durable attempt

- **Date / status:** 2026-10-04 · Accepted and fake-tested; live UI behavior unverified
- **Context:** Flow does not document a stable per-submission ID in the reviewed public UI material, so a click or generic result card alone is not enough to prove which job produced it.
- **Options:** Resubmit on timeout; accept the newest result heuristically; or persist a request-key manifest and require unique visible prompt/media evidence before accepting or downloading.
- **Decision:** Persist the manifest before Generate, derive a local provider ID from the durable attempt key, and correlate only one new prompt occurrence plus one accessible new media element (or a visible active-generation signal). Store a prompt hash and baseline fingerprints, not a second plaintext prompt. Any ambiguity raises `submissionUnknown`; the existing queue defers the same attempt and never creates a blind replacement submission.
- **Reason:** Reduces duplicate generations and prevents attaching an unrelated Flow asset to a job.
- **Trade-offs:** Some legitimate Flow pages may not expose enough visible evidence and will remain blocked for operator resolution. Live correlation has not yet been verified.

## D-022 — Phase 2 capability declarations are deliberately narrow

- **Date / status:** 2026-10-04 · Accepted for implementation; live validation pending
- **Context:** Flow exposes multiple image/video settings, references, and frame workflows, while the first adapter path can verify only a small subset.
- **Options:** Advertise the product's full feature surface; claim only the implemented one-image/no-reference workflow; or disable all provider functionality until a live session is available.
- **Decision:** Declare only single-image generation. Video, references, frames, and batch generation remain false; non-default settings are rejected. Keep the live smoke separate and opt-in. Fake tests exercise the declared path, but actual Google Flow behavior remains **BLOCKED / NOT RUN** until an authorized session executes the smoke test.
- **Reason:** Avoids overstating support or consuming quota in ordinary CI while delivering the narrow provider implementation.
- **Trade-offs:** The capability flag describes implemented/fake-tested path, not a claim that real Flow has passed; release readiness still requires authorized live validation.

## D-023 — Flow timeouts and cancellation preserve ownership uncertainty

- **Date / status:** 2026-10-04 · Accepted and fake-tested; live UI behavior unverified
- **Context:** A browser click timeout does not prove Flow rejected a generation, while a generic visible Stop control does not prove which generation it would stop.
- **Options:** Treat timeouts as failures and submit again; click a generic Stop control; or persist uncertain state, recover the same attempt, and leave remote cancellation unavailable until ownership is testable.
- **Decision:** A dispatched Generate click without a verified visible state change raises `FLOW_TIMEOUT` with `submissionUnknown: true`. The existing queue defers the same attempt and performs request-key lookup/status inspection before any recovery decision. FlowForge local cancellation remains supported; the Flow adapter does not click remote Stop/Cancel controls for in-flight requests and returns `FLOW_CANCEL_UNAVAILABLE`.
- **Reason:** Prevents timeouts from becoming duplicate generations and prevents a cancellation from targeting unrelated user work.
- **Trade-offs:** A remote operation may continue after local cancellation or remain uncertain until bounded recovery/operator intervention; this does not imply a provider-side failure or cancellation.

## D-024 — Application services orchestrate; they own no infrastructure

- **Date / status:** 2026-10-04 · Accepted and implemented in `packages/services`
- **Context:** The durable engine was provable but only operable through a hardcoded demo script. A naive "service layer" would duplicate queueing, retries, provider selection, or QC and create a second source of truth.
- **Options:** Put orchestration inside `packages/queue`; add an HTTP API in front of the repository; or add a narrow composition layer that validates intent, delegates each write to the component that already owns the transition, and projects read models.
- **Decision:** `packages/services` owns validation, orchestration, and operator read models only. It receives a `JobRepository` port that is a structural `Pick` of the existing repository, calls `createGenerationJobWithCreated` (job + queue item in one transaction) instead of re-implementing enqueueing, and drives `LocalQueueWorker` for execution. It never touches SQL, leases, retry scheduling, provider construction/selection, CDP/Playwright, or asset bytes.
- **Reason:** Keeps one enforcement point per state machine, so durability, idempotency, and recovery guarantees from Phases 1–2 cannot be bypassed by a convenience API.
- **Trade-offs:** Operators get CLI JSON rather than a richer product surface; read models recompute from stored rows instead of maintaining materialised state.

## D-025 — Production readiness is derived; `READY` is a guarded transition, not new state

- **Date / status:** 2026-10-04 · Accepted and tested
- **Context:** The chain ends at a "production-ready scene". A stored boolean would silently drift from the QC, review, selection, and open-job rows that justify it, and a new migration would widen the schema for no gain.
- **Options:** Add a `production_ready` column; reuse `scenes.status` and accept any writer; or derive readiness from evidence and gate the existing status write.
- **Decision:** Readiness is computed on every call into an ordered blocker list (`NO_CURRENT_SCENE_VERSION`, `NO_SUCCEEDED_OUTPUT_FOR_VERSION`, `GENERATION_IN_PROGRESS`, `NO_SELECTED_ASSET_VERSION`, `QC_NOT_PASSED`, `REVIEW_NOT_APPROVED`, `SELECTED_VERSION_NOT_CURRENT`, `SCENE_ARCHIVED`). `READY` is set only by `ProductionService.markReady` after that list is empty, using the new `SCENE_STATUS_TRANSITIONS`/`PROJECT_STATUS_TRANSITIONS` tables in core which `updateSceneStatus`/`updateProjectStatus` re-check in their own transaction. `SceneService` deliberately refuses `READY`, and archived scenes/projects are terminal. No migration was required because `status` columns already exist.
- **Reason:** The gate can never disagree with its evidence, and the transition rule stays in the domain layer where the job state machine already lives.
- **Trade-offs:** Readiness costs a few indexed reads per scene; recomputation is preferred over cache invalidation at this scale.

## D-026 — Refuse to drive the worker for providers it cannot serve

- **Date / status:** 2026-10-04 · Accepted and tested
- **Context:** `LocalQueueWorker` serves exactly one provider and permanently fails any claimed job belonging to another (`PROVIDER_MISMATCH` is non-retryable). A mixed queue plus `queue run` would destroy operator work by accident.
- **Options:** Let the worker fail mismatched jobs; add per-provider routing/parallel workers to the queue; or check coverage before execution in the application layer.
- **Decision:** `QueueService` verifies every `QUEUED` job's provider against the served provider set before each run and throws `PROVIDER_COVERAGE_INCOMPLETE` (exit code 3) without consuming an attempt. `--ignore-provider-coverage` remains available for a deliberate, reviewed override, and queuing work for an unwired provider requires the explicit `allowUnconfiguredProvider` flag.
- **Reason:** Keeps Phase 1 queue semantics untouched while making the destructive combination impossible by default.
- **Trade-offs:** One extra queue read per run; a mixed queue must be drained provider by provider rather than in one command.

## D-027 — Operator surface is a typed CLI over shared read models

- **Date / status:** 2026-10-04 · Accepted and tested
- **Context:** An operable system needs status, review, and selection actions now, but a web UI, HTTP API, or daemon would add auth, transport, and concurrency surface before the live provider is validated.
- **Options:** Ship a web review UI/API; run a background worker daemon; or expose the services as CLI subcommands with serialisable read models.
- **Decision:** `apps/cli` gains subcommands (`project`, `scene`, `generate`, `status`, `queue`, `cancel`, `retry`, `review`, `production`, `provider`) that call only the services. Human and `--json` output are the same projections; errors carry stable codes (`READINESS_NOT_SATISFIED`, `PROVIDER_COVERAGE_INCOMPLETE`, `RETRY_BLOCKED_UNSAFE_STATE`, …) and exit codes `0/1/2/3`. The flag-only Phase 1 invocation still runs the vertical slice unchanged. Execution is on demand, never a daemon; a future UI must consume these read models and persisted IDs.
- **Reason:** Delivers operator leverage with no new trust boundary, keeps deterministic CI (no browser, no Google account), and preserves the documented Phase 1 contract.
- **Trade-offs:** No graphical review; JSON read models are the contract for the next surface.

## D-028 — Creative planning is a domain above the execution spine, not a second pipeline

- **Date / status:** 2026-10-04 · Accepted and tested (Phase 4A)
- **Context:** Phases 1–3 execute work: a scene version becomes a job, a queue item, a provider call, an asset, QC, and review. Creative intent needed a durable home, and the tempting shortcut was to model "plan" as a batch of scenes (or to auto-enqueue from a plan) so that planning data would reuse the existing tables directly.
- **Options:** Store plans as scene rows with a flag; let a plan version enqueue jobs on approval; or introduce a planning domain that owns its own tables, lifecycle, and read models and maps *downward* through the existing services.
- **Decision:** `ScenePlan` is a distinct concept from `Scene`/`SceneVersion`, and creating one never creates a job, queue item, or asset. The execution boundary is one-directional and explicit — validate → approve → mark executable → read-only execution preview → the existing Phase 3 commands — with no second execution engine, no parallel queue, and no automatic submission anywhere in Phase 4A. Tests assert an empty job table and an empty queue after a complete lifecycle.
- **Reason:** Keeping the two domains separate preserves every Phase 1–3 guarantee (leases, attempts, idempotency, capability admission, review authority) as the only path to a provider, and it means a planner in 4B/4C can only ever *propose* work that still passes the same gates a human-written plan must pass.
- **Trade-offs:** The plan graph and the execution graph are two sets of tables that must be kept consistent by service-level rules rather than by one shared row; a scene plan cannot be executed until it is mapped, which is deliberate friction.

## D-029 — The plan *version* owns the lifecycle; approved content is copied, never edited

- **Date / status:** 2026-10-04 · Accepted and tested (Phase 4A)
- **Context:** A plan is revised repeatedly while its outputs are already in flight, and an approval must stay attributable to the exact content that was approved. Putting the status on the plan row would make "approved" drift as soon as a scene is edited.
- **Options:** Status on the plan with editable children; mutate approved versions in place and log a diff; or make the version the consistency boundary, with revisions as copies.
- **Decision:** `DRAFT → VALIDATED → APPROVED → EXECUTABLE → ARCHIVED` lives on `production_plan_versions`, defined by `PLAN_VERSION_STATUS_TRANSITIONS` in core, re-checked by compare-and-set writes in storage, and enforced again by v4 database triggers. Child writes are refused (`PLAN_NOT_EDITABLE`, and at the database level via `<table>_requires_editable_plan_version_*`) unless the version is `DRAFT`/`VALIDATED`. `revise` copies story, cast, scene plans, and specs into `version_number + 1` with `predecessor_version_id`, and `sceneKey` carries per-scene identity across versions; an approved version keeps its content, findings, and hash forever.
- **Reason:** Approval becomes a statement about an immutable snapshot, the history is queryable instead of reconstructed, and no destructive migration or in-place rewrite of approved creative decisions is possible.
- **Trade-offs:** Copies cost storage and a version-copy transaction; operators must reopen or revise rather than "just fix a typo" on an approved version.

## D-030 — Planning state is normalized relational tables, not an opaque JSON blob

- **Date / status:** 2026-10-04 · Accepted and tested (Phase 4A)
- **Context:** A plan version is a tree of story, cast, scene plans, and specs. A single JSON column would make versioning trivial to write and would need no migration, but uniqueness, referential integrity, per-child idempotency, and operator queries would all move into application code.
- **Options:** One `plan_json` blob per version; a blob plus an index table; or normalized tables per concept with foreign keys and uniqueness.
- **Decision:** Eleven v4 tables (`creative_briefs`, `worlds`, `visual_dna`, `production_plans`, `production_plan_versions`, `plan_stories`, `plan_version_characters`, `scene_plans`, `scene_plan_characters`, `generation_specs`, `plan_validations`) with foreign keys, indexes on project/plan/version, uniqueness that encodes version semantics (`UNIQUE(project_id, version_number)`, `UNIQUE(plan_id, version_number)`, `UNIQUE(plan_version_id, scene_number)`, `UNIQUE(plan_version_id, scene_key)`, `UNIQUE(scene_plan_id, spec_number)`), and partial-unique idempotency keys. Only genuinely leaf payloads (constraints, palettes, continuity statements, planned outputs, findings) are JSON columns, encoded with the existing canonical `stableJson`. One `SqlitePlanningRepository` is constructed from the existing `SqliteJobRepository`'s connection, so a single database owns all durable state and aggregate writes stay one `.immediate()` transaction.
- **Reason:** The database can then enforce exactly what the domain promises — no duplicate scene order, no orphan spec, no child of an approved version changing, no pointer to another plan's version — and the operator read models query scenes, specs, and cast without deserializing a whole aggregate.
- **Trade-offs:** More migrations and more SQL than a blob; aggregate loads are explicit joins. Content hashing keeps the "read the whole version" operation cheap to verify.

## D-031 — Capability requirements reuse `ProviderCapabilities`, and the gate reads declarations only

- **Date / status:** 2026-10-04 · Accepted and tested (Phase 4A)
- **Context:** Generation specs must say what they need from a provider (batch, references, video, frames). Phase 2 already declares provider capabilities, and a planning-specific `supportsX` flag or a pre-flight provider call would create a second source of truth — or a browser session — for something a registry already answers.
- **Options:** Plan-specific capability booleans; probe a provider at validation time; or express requirements as `keyof ProviderCapabilities` and check them against the existing registry declarations.
- **Decision:** `GenerationSpec.requiredCapabilities` is `readonly (keyof ProviderCapabilities)[]` (`PROVIDER_CAPABILITY_KEYS` in core is derived from that type, so the two can never drift). The validator maps spec shape to requirements (image → `imageGeneration`, video → `videoGeneration`, references → `referenceImages`, `outputCount > 1` → `batchGeneration`) and reports unsatisfiable ones as `CAPABILITY_UNAVAILABLE` findings; `markExecutable` refuses with `PLAN_CAPABILITY_UNMET` plus per-spec candidate providers. Both read `ProviderRegistry` declarations only: no provider object is constructed, no auth/session is touched, and no capability list is duplicated. `--providers CSV` (not `--provider`) names the providers allowed to serve a plan, because executability is about a *set* of candidates.
- **Reason:** One capability model, one place to change it, and a gate that works identically for the mock provider in CI and for Google Flow, while keeping the provider boundary replaceable.
- **Trade-offs:** Declaration-based gating can be optimistic if a provider's declared capability later fails at runtime — the queue, QC, and review stages remain the real enforcement, exactly as in Phase 3.

## D-032 — Validation evidence is append-only, hash-bound, and ranked by insertion order

- **Date / status:** 2026-10-04 · Accepted and tested (Phase 4A)
- **Context:** Structural validity must be provable after the fact, and a plan edited after validation must not be approvable on stale evidence. Re-running a validator under a fixed test clock or inside one millisecond also means "the latest report" needs an unambiguous definition.
- **Options:** Store a `valid` flag on the version; overwrite one evidence row per version; or append immutable evidence keyed by content hash.
- **Decision:** `plan_validations` rows are immutable (update/delete raise `plan validation evidence is immutable`) and unique per `(plan_version_id, validator_version, content_hash)` — a revalidation of unchanged content reuses the row and reports `evidenceReused`. Every child write recomputes `content_hash`, so `isCurrent` is derived, staleness blocks approval with `PLAN_VALIDATION_REQUIRED`, and `VALIDATION_MISSING` (never validated) stays distinct from `VALIDATION_STALE` (validated, then edited). "Latest evidence" is ordered by `created_at, rowid`, never by the random primary key, so two rows in one clock tick still rank deterministically. A failing validation moves the version back to `DRAFT` rather than throwing away the report.
- **Reason:** Approval can always be traced to the exact findings and content it covered, and staleness is a computed property that cannot drift from its justification — mirroring how `qc_results` work for assets.
- **Trade-offs:** Evidence rows accumulate per version (cheap, and useful as history); a passing run may insert a row even when nothing changed.

## D-033 — No event bus, and no second idempotency system, for planning

- **Date / status:** 2026-10-04 · Accepted and tested (Phase 4A)
- **Context:** A planning layer with briefs, definitions, versions, and validation is exactly where an internal event bus and a planning-specific dedup mechanism are usually proposed. Both were already decided against in earlier phases (`packages/events` unused, one canonical idempotency helper).
- **Options:** Emit planning events into `packages/events` for projection building; add a planning outbox; or keep direct service orchestration and reuse the existing key derivation.
- **Decision:** Planning services call each other and the repository directly. `packages/events` remains unused, and no dispatcher, subscriber, outbox, or daemon was introduced. Idempotency reuses `createIdempotencyKey`/`canonicalize`/`stableJson` with a `plan:` prefix, stored in each table's partial-unique `idempotency_key` column; the derived keys are documented in [docs/planning-domain.md](./docs/planning-domain.md) §8. A same-key/different-content attempt still fails with `IDEMPOTENCY_CONFLICT`, and lifecycle transitions remain compare-and-set.
- **Reason:** Direct calls keep one transaction, one error path, and one retry story; a second dedup scheme would give operators two ways to describe the same intent.
- **Trade-offs:** Fan-out for a future UI or webhook will need a deliberate outbox decision, and read models recompute rather than project from a stream.

## D-034 — Reuse the character identity and pin immutable snapshots instead of duplicating types

- **Date / status:** 2026-10-04 · Accepted and tested (Phase 4A)
- **Context:** Planning needs characters, worlds, Visual DNA, and creative intent. `characters` already exists as a stable project-scoped identity table, and briefs/worlds/DNA could each be stored as one mutable row per project.
- **Options:** A parallel `planning_characters` table; a `planning_*` JSON copy of the execution rows; or additive columns plus per-plan cast links, with project definitions as immutable versioned snapshots.
- **Decision:** Characters are the same rows, extended additively (`traits_json`, `visual_identity_json`) in the v4 migration; the per-plan `role` lives on the `plan_version_characters`/`scene_plan_characters` links so one identity can recur across scenes and versions. Creative briefs, worlds, and Visual DNA are versioned immutable snapshots (`ACTIVE`/`SUPERSEDED`, `UNIQUE(project_id, name, version_number)`), and a plan version references them **by ID**, so `plan revise` and revalidation reproduce the inputs the plan was authored against even after a newer snapshot exists. A cross-project reference is refused by trigger, and reusing a brief id from another project raises `Creative brief belongs to another project.`
- **Reason:** One identity per concept in the system keeps execution provenance, review, and planning consistent; snapshot pinning is what makes an approved version reproducible rather than "approved against whatever the brief says now".
- **Trade-offs:** Two representations of "a character" (identity + per-version role) instead of one denormalized row, and updating a brief means creating a new snapshot rather than editing one.

## D-035 — Read models never throw for legitimately absent state

- **Date / status:** 2026-10-04 · Accepted and tested (Phase 4A)
- **Context:** The first end-to-end CLI walkthrough crashed: `plan status` on a fresh `DRAFT` plan failed with `NOT_FOUND` because the read model required validation evidence that does not exist yet — and an operator's most common question is exactly "what is the state of this plan right now?".
- **Options:** Make callers pre-check for evidence; return an empty synthetic report; or return a nullable view and reserve the throwing variant for paths that require evidence.
- **Decision:** `PlanningReadService.validationView` returns `PlanValidationView | null`, and `requireValidationView` throws `NOT_FOUND` for the transitions that genuinely need evidence (`approve`, `markExecutable`, the `validate` report projection). `planValidation` reads tolerate `null` briefs, stories, and validations and express the gap as a blocker (`VALIDATION_MISSING`) plus a next action (`AUTHOR_PLAN`/`VALIDATE_PLAN`). A CLI renderer that had a no-op conditional and a trailing blank line was fixed in the same pass, because operator output is part of the contract.
- **Reason:** Absence of un-started work is information, not an error; the state machine already refuses the actions that require evidence.
- **Trade-offs:** Read paths carry a nullable type, and a caller that *should* have evidence must remember to use the `require…` variant.

## D-036 — The planner is a versioned rule registry, not a model

- **Date / status:** 2026-10-05 · Accepted and tested (Phase 4B)
- **Context:** 4A left the plan aggregate fillable by hand, by a deterministic planner, or later by an AI adapter. The tempting implementation is a prompt to a language model that returns a plan tree; the requirement is a plan whose scene order, identifiers, durations, and capability requirements are reproducible and explainable.
- **Options:** Ask a model and validate the result; write an ad-hoc scoring heuristic; or implement a pure engine as an ordered registry of named rules, versioned independently of the validator.
- **Decision:** `packages/services/src/planner/` exposes `runPlanner(PlannerInput) → PlannerRun`: a pure function over explicit input, executing `PLANNER_RULES` — 12 frozen rules from `brief-foundation` to `plan-integrity`, each recording a trace step with what it read. `DETERMINISTIC_PLANNER_VERSION` (`deterministic-planner-v1`) and `PLANNING_RULES_VERSION` (`planning-rules-v1`) live in `@flowforge/core` and are distinct from the validator version. A source-scan test forbids randomness, clocks, I/O, and model/provider imports in that directory. `flowforge planner rules` prints the same registry, so operators read the algorithm the engine runs.
- **Reason:** Determinism is what makes an approved plan reviewable later; a rule can be named, tested, versioned, and explained, while a model's plan cannot be re-derived once the provider changes. Keeping the engine pure also means 4C can add a model *behind the same input/result contracts* without touching persistence.
- **Trade-offs:** Planning quality is bounded by the rules, and prose is never improved by the engine — a verbose beat yields a verbose scene. An AI planner (4C) must pass the same validator rather than being trusted to produce a plan; D-043 onward records how that was done without disturbing this engine.

## D-037 — Canonical normalization fingerprints content, not write policy

- **Date / status:** 2026-10-05 · Accepted and tested (Phase 4B)
- **Context:** Two runs must be comparable to decide "nothing changed", but the input contains both creative knobs and *how to write* knobs. Fingerprinting the whole input made an unchanged re-plan with a different `replan` policy look like new content, which would fork a version for a no-op.
- **Options:** Compare the raw command; hash the whole normalized input; or hash a documented projection that keeps only what a rule can read.
- **Decision:** `normalizePlannerInput` trims text, collapses internal whitespace, treats empty optionals as absent, trims but never rewrites identifiers, preserves meaningful order (beats, cast, themes, constraints) while sorting/deduplicating the semantically unordered (capability keys, provider candidates, duplicate references), floors durations to whole milliseconds, applies defaults *before* hashing, and drops fields no rule reads. `inputFingerprintOf` then hashes `fingerprintableView`, which excludes `replan` and `includeTrace`; `asOf` is excluded everywhere. `seed` stays in the hash, because it changes cast assignment and is therefore content. Canonical JSON lives in `packages/core/src/canonical-json.ts` (`canonicalize`, `stableJson`, `fingerprintJson`) with a namespace per digest kind.
- **Reason:** The fingerprint should answer "is this the same plan?", so anything that cannot change the plan must not change the fingerprint — and prose is preserved verbatim because the operator's words are the creative record.
- **Trade-offs:** A new option must be classified deliberately (content or policy); the projection is one more thing to keep honest, covered by a core test that pins ordering and stability.

## D-038 — Plan and row identity are derived, with row ids scoped to the version

- **Date / status:** 2026-10-05 · Accepted and tested (Phase 4B)
- **Context:** Idempotent authoring and a later execution mapping both need ids that recur across runs, but storage needs one primary key per row and two versions of one plan legitimately hold the same scene.
- **Options:** `randomUUID()` per write (breaking reuse); reuse the draft's ids verbatim across versions (colliding keys); or derive identities from the input.
- **Decision:** Every id is `plannerId(fingerprint, kind, path)` — a SHA-256 over the namespaced input fingerprint, kind, and deterministic path, formatted as a **UUID-shaped derived value** (fixed version/variant nibbles, no randomness). `planIdentityId({ projectId, briefId, title })` decides *which plan* a run targets and deliberately ignores seed and prose. `authoringId(inputFingerprint, planVersionId, kind, path)` scopes row ids per version, and `scenePlan`-kind references are re-pointed from drafted ids to row ids — a translation of identity, never of content. `sceneKey` is a position-free slug with `-2`, `-3` collision suffixes, so inserting a scene cannot rename the scenes behind it.
- **Reason:** Same input yields the same ids, which is what makes a re-run a reuse and a re-map the same scenes and jobs; keying identity on `(project, brief, title)` keeps a new seed a new version of the same plan instead of a forked plan.
- **Trade-offs:** Ids are opaque rather than sequential, and scene keys stay stable but not order-encoding — the explicit `sceneNumber` carries order.

## D-039 — Planner provenance is an additive v5 column set with write-once triggers

- **Date / status:** 2026-10-05 · Accepted and tested (Phase 4B)
- **Context:** A plan must say which planner version, rules version, seed, and fingerprints produced it, so that a future planner release cannot silently reinterpret an old plan. Options on the table were revision notes, a separate trace table, or columns.
- **Options:** Record provenance as free-text in `plan_version_revisions`; create a `plan_version_provenance` (+ trace) table; or add nullable columns to `production_plan_versions` in a forward-only migration.
- **Decision:** Migration v5 adds seven nullable columns — `planner_version`, `planner_rules_version`, `planner_seed`, `planner_input_fingerprint`, `planner_output_fingerprint`, `planner_content_hash`, `planner_trace_json` — outside the version `content_hash`, written by `setPlanVersionProvenance` as a complete set and made immutable by triggers that refuse any `UPDATE` changing a recorded value. `revise()` copies content but not provenance. The read model derives `planned`, `contentMatchesProvenance`, and a human `detail`, and reports an unprovenanced version as "authored by hand", never as an error.
- **Reason:** Provenance belongs to the version row that the plan already keys on; triggers, not service discipline, are what make "recorded once, never rewritten" a database guarantee, and keeping it out of the content hash means recording authorship never invalidates validation evidence.
- **Trade-offs:** The trace is stored in a JSON column rather than queryable rows (it is an explanation artifact, read whole), and re-planning into a version that already carries provenance is impossible by design — the answer is a new version.

## D-040 — Planner writes are content-based reuse first, then an explicit replan policy

- **Date / status:** 2026-10-05 · Accepted and tested (Phase 4B)
- **Context:** Running the planner twice is the normal operator behaviour, so the engine seam needs an idempotency rule that neither duplicates a plan nor destroys hand edits. 4A already owns one idempotency system; the planner must not invent a second.
- **Options:** Always fork a new version; overwrite the current version's scene plans; or compare the run's fingerprints against the recorded ones and write nothing on a match.
- **Decision:** `resolveTarget` reuses the current version when its stored `inputFingerprint`, `outputFingerprint`, and `contentHash` all match this run and the content hash still recomputes — `reused: true`, zero writes, and the stored validation view reported. Otherwise `replan: "new-version"` (default) forks with `predecessorVersionId` set, `"fail"` raises `IDEMPOTENCY_CONFLICT`, and `"in-place"` is legal only on an editable (`DRAFT`/`VALIDATED`) version that carries **no** provenance and **no** hand-authored scene plans; a provenanced version refuses with `IDEMPOTENCY_CONFLICT` because provenance is write-once (D-039). A `dryRun` runs the engine and writes nothing at all, including provenance.
- **Reason:** "Same content, same version" makes the operation safe to repeat and preserves recoverability, while the policy field keeps the choice visible instead of implicit. Refusing rather than deleting is what protects work the planner cannot rebuild.
- **Trade-offs:** In-place re-planning is available only for an empty unprovenanced version, so an operator iterating on a planned version accumulates versions — which is also the audit trail.

## D-041 — Planning stops at the plan: execution mapping emits intents and nothing else

- **Date / status:** 2026-10-05 · Accepted and tested (Phase 4B)
- **Context:** A planned version is *executable-ready*, which invites wiring plan → jobs in the same phase and exposing a `planner execute` command. Phase 3 already owns submission, idempotency, leases, retries, and QC; 4B owns authoring.
- **Options:** Submit jobs from the planner; add a CLI `planner execute`; or provide a pure mapping at service level, proven by deterministic tests, with no submit call and no command.
- **Decision:** `mapPlanToJobs(snapshot, { providers, … })` in `packages/services/src/plan-execution.ts` consumes the 4A execution preview and returns typed `CreateGenerationJobIntent`s with deterministic `sceneId` and `jobKey` (scoped by `plannerOutputFingerprint ?? contentHash`), `blockers` (`PLAN_NOT_APPROVED` unless approved or explicitly `allowUnapproved`), and `skipped` entries (`NO_CAPABLE_PROVIDER`). It calls no `GenerationService`, writes no job or queue row, and no CLI command invokes it; `plan preview` stays the read-only operator view. A test asserts that `planner execute|submit|queue` does not exist.
- **Reason:** Submitting is a side effect with a different failure model, so it must be a deliberate call, not a by-product of planning; and re-implementing provider selection would have created a second execution engine next to 4A's preview.
- **Trade-offs:** The end-to-end "plan → mock generation" loop is not closed inside 4B — that is the named 4B-follow-on in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md), and its building blocks are already tested.

## D-042 — A stored plan that fails validation is reported and left editable

- **Date / status:** 2026-10-05 · Accepted and tested (Phase 4B)
- **Context:** The engine self-checks its draft with the same validator before anything is written, yet between draft and rows a concurrent edit, a rule drift, or a persistence quirk can make the stored aggregate fail. Deleting the version would destroy the operator's data; keeping it approved would be dishonest.
- **Options:** Trust the draft check and report success; roll the version back; or keep the authored rows, downgrade the reported outcome, and leave the version editable.
- **Decision:** After authoring, the service records provenance and **revalidates the stored rows**. If that report is not `PASSED`, the result outcome becomes `VALIDATION_FAILURE` with the notice `PLANNER_PERSISTED_VALIDATION_MISMATCH`, the version stays `DRAFT` (unapproved, re-planable into a new version), and `nextAction` names the repair. Approval and executability are only ever reached through the 4A gates, so a mismatch can never be `APPROVED`.
- **Reason:** The authoritative evidence is about rows, not drafts; keeping the version recoverable and loudly reported preserves the Phase 1/3 guarantees (persist before destructive transitions, no silent success) and leaves the operator something to inspect.
- **Trade-offs:** A rare run leaves an unusable draft version behind rather than a clean slate — and the plan's own `nextAction` says so, instead of the tool quietly hiding the trace of what it did.

## D-043 — The AI planner is a domain port; adapters live outside it

- **Date / status:** 2026-10-05 · Accepted and tested (Phase 4C)
- **Context:** 4C has to let a language model propose plan content without making the model part of the domain, without a second planning engine, and without the repository becoming dependent on a vendor. Google Flow already proves the pattern for providers (D-001); planning needs the same shape for planning intelligence.
- **Options:** Put a prompt-and-parse routine inside `PlannerService`; define a provider-neutral port in core with adapters in their own packages; or build a separate "AI planner" subsystem with its own plan writer.
- **Decision:** `packages/core/src/ai-planning.ts` owns the vocabulary — `AIPlanner` (`descriptor` plus `propose(request)` and an optional `describe()`), `AIPlanningRequest`/`AIPlanningResponse`, `PlanningProposal` with `AI_PLANNING_SCHEMA_VERSION`, `AI_PROPOSAL_LIMITS`, `PlanAiProvenance`, the `AI_*` error codes, and the AI trace stages. `packages/services/src/ai-planner/` owns orchestration (schema validation, translation, digests) and `AiPlannerService`; `providers/openai-chat` is the only adapter. The AI route ends at `PlannerService.plan()`, which remains the sole author of plan rows.
- **Reason:** The engine in D-036 stays pure and untouched, tests run with deterministic fakes, a vendor swap touches one package, and no module gets both model access and write access to the aggregate. Naming vendors in the domain would leak an implementation choice into every consumer of the contract.
- **Trade-offs:** One more indirection, and the port must be designed before any adapter exists — so its types carry limits and failure codes that the first adapter could otherwise have improvised. The domain also has to keep resisting convenience requests to "just pass the raw text through".

## D-044 — Structured output only, validated strictly, and never partially accepted

- **Date / status:** 2026-10-05 · Accepted and tested (Phase 4C)
- **Context:** A model that returns prose about a film is not a planning input. The proposal must be machine-checkable, and every way a response can be wrong must have a name, because the alternative — interpret what the model meant — silently invents content.
- **Options:** Parse loose JSON and default the missing fields; accept prose and extract it; or require a versioned document validated by a strict schema with no tolerance for extras.
- **Decision:** A proposal is `{ kind: "ai-planning-proposal-v1", schemaVersion: 1, ... }`, validated before translation by a schema that refuses unknown fields (path and reason included), bounds every string and collection against `AI_PROPOSAL_LIMITS`, demands whole milliseconds inside `200..60000`, and rejects duplicate or empty keys. Structural failures carry `AI_SCHEMA_MISMATCH` (or `AI_INVALID_JSON`/`AI_EMPTY_RESPONSE`/`AI_TRUNCATED` upstream). There is no partial acceptance and no `continueOnInvalid`: the outcome is `refused by schema`, with the domain findings that were reached, and nothing is written. The adapter is asked for structured output (JSON schema / `json_object`) as well as checked afterwards, so the model's failure rate and the validator's judgement are independent facts.
- **Reason:** The aggregate's invariants belong to the domain, so a proposal that contradicts them must fail closed rather than be negotiated with. A strict schema plus a refusal reason is also the only way to tell "the model said something wrong" apart from "the transport broke", which is what an operator needs to see.
- **Trade-offs:** Adding a proposal field means changing the schema and the validator together, and a model that embellishes gets refused instead of approximately understood. Some valid-looking provider answers are rejected — deliberately.

## D-045 — AI metadata is provenance, never plan content

- **Date / status:** 2026-10-05 · Accepted and tested (Phase 4C)
- **Context:** Recording which adapter, model, and digests produced a plan is required for audit. Folded into the plan's content hash, that metadata would invalidate validation evidence and make an identical plan look edited; kept nowhere, it makes a model's influence unauditable.
- **Options:** Extend `content_hash`; store AI facts in the plan's JSON payloads; or keep them in columns outside every fingerprint, as 4B did for planner provenance (D-039).
- **Decision:** Ten nullable v6 columns (`ai_adapter`, `ai_adapter_version`, `ai_provider`, `ai_model`, `ai_schema_version`, `ai_path`, `ai_request_fingerprint`, `ai_proposal_fingerprint`, `ai_response_fingerprint`, `ai_fallback`) sit beside the v5 planner columns, outside `content_hash` and outside `plannerInputFingerprint`/`plannerOutputFingerprint`, which the authoring service computes from the planner input and draft before provenance is attached. Triggers enforce the same complete-set and write-once rules as v5, with `ai_response_fingerprint` exempt from both because a refused answer legitimately has no response to digest. A run that reuses an existing version writes nothing at all — including no provenance update — and reports `provenanceRecorded: false` with the reason.
- **Reason:** A plan is what it is regardless of who proposed it, so the routes must be comparable and the content must remain re-derivable; and the audit question is "what produced this", which is answered by facts attached to the version rather than by facts inside it.
- **Trade-offs:** `reused` results carry the current invocation's digests in the result but not in the database (the version they describe was written by another invocation), and a future plan whose semantics genuinely depend on adapter identity will need a deliberate fingerprint change, not a column.

## D-046 — Digest the exchange, retain nothing that can leak

- **Date / status:** 2026-10-05 · Accepted and tested (Phase 4C)
- **Context:** An auditable planning trace wants enough of the exchange to reconstruct what was asked and answered; prompts and raw answers can carry a project's unreleased content, and an adapter that logs its request could leak credentials into logs, database rows, and CLI output.
- **Options:** Store prompt and response bodies with a retention window; store nothing at all; or store digests and identities by default, with raw bodies as an explicit future opt-in.
- **Decision:** Default retention is metadata: named digests (`ai:request:v1`, `ai:proposal:v1`, `ai:response:v1` over canonical `stableJson`), adapter/provider/model/schema identities, sanitized trace steps (counts, lengths, kinds, digests), and bounded message text. The request digest names the brief row's stored `contentHash` instead of copying its prose. Retaining a raw prompt or response is a separate, deliberate opt-in that 4C does not add; if a later phase adds it, it must be bounded, excluded from every fingerprint, and secret-scrubbed. Secrets are never stored: the adapter reads the key from the environment only when it composes the header, the CLI passes a variable *name* (never a value) as a launch argument, and every message that can reach storage or stdout passes one `sanitize()` that replaces both credential-shaped keys and secret-looking values.
- **Reason:** Digests answer "is this the exchange we had before" — the actual audit question — without turning the durable store into a copy of a provider conversation, and one shared sanitizer means a fix protects the trace, the log, and the error path at once.
- **Trade-offs:** A refused proposal's exact text cannot be reconstructed after the fact, only its digest, its length, and why it was rejected; debugging a model's odd answer may require reproducing the call. Truncation is detectable, not recoverable.

## D-047 — Fallback is an explicit operator decision, and transport never triggers it

- **Date / status:** 2026-10-05 · Accepted and tested (Phase 4C)
- **Context:** When a proposal is unusable the operator may want the deterministic route instead, but a silent substitution would produce a plan that looks AI-assisted and is not — or a plan that stops existing because a provider had an outage.
- **Options:** Always fall back to the rules; never fall back; or require the operator to ask, and distinguish what kind of failure may trigger it.
- **Decision:** `fallback: "none" | "deterministic"`, default `none`. The deterministic re-plan runs only for domain-level failures (refused or contradictory proposal) and never for transport failures (`AI_UNAVAILABLE`, `AI_TIMEOUT`, `AI_HTTP_ERROR`, …), where the plan a model would have produced is unknown; the request digest is computed before the call so both routes remain attributable to the same guidance, and the authored version records `ai_fallback` plus an `AI_FALLBACK_USED` notice with the refusal reason. `--fallback` is refused with exit 2 on the deterministic `planner run`, which has nothing to fall back from.
- **Reason:** A fallback that changes what the operator gets must be one they asked for; and an unavailable endpoint is a reason to retry later, not a reason to quietly ship a different plan.
- **Trade-offs:** Most failed AI runs end with nothing written and a non-zero exit, which is noisier than auto-recovering — and correct, because the operator keeps the choice.

## D-048 — Dry run exercises the real path and commits nothing

- **Date / status:** 2026-10-05 · Accepted and tested (Phase 4C)
- **Context:** A model-backed plan cannot be re-derived on demand, so the operator needs to see what a proposal would produce — and any dry run whose output could differ from the real run is a trap. An AI dry run also cannot promise that the next call returns the same proposal.
- **Options:** Validate the proposal without planning; plan in memory against a snapshot; or run the real planner and validator against the committed state and let the authoring service skip its writes.
- **Decision:** `dryRun: true` calls the adapter for real, validates and translates, runs the engine and the 4A validator against the *committed* aggregate, and performs no write: `PlannerService`'s existing dry-run branch is the only mechanism (a separate AI-specific planner would be a second engine), so `plan list` and `queue status` are unchanged afterwards. The result exposes the three digests, the normalized proposal and planner input, and the planned version with its trace, and `planner ai-run --dry-run` reports the digests rather than claiming the next call reproduces them.
- **Reason:** Same code, same inputs, same ordering — that is what makes the preview worth reading; and the identity that would change the result is named instead of glossed over.
- **Trade-offs:** A dry run reads live rows, so a concurrent edit between preview and real run can change the outcome; and it may cost a provider call even though it writes nothing.

## D-049 — A new optional input field does not move `PLANNING_RULES_VERSION` when every existing input is byte-identical

- **Date / status:** 2026-10-05 · Accepted (Phase 4C judgement, recorded for reviewers)
- **Context:** 4C added `StoryBeatInput.continuityNote`, which the `continuity-linking` rule turns into an extra `ScenePlanContinuity` statement. D-036 says a rule whose *decisions* change requires a rules-version bump; a new field no caller sends changes nothing, and an unnecessary bump would falsely imply that plans made before 4C were produced by different rules.
- **Options:** Bump `PLANNING_RULES_VERSION` because a rule's code changed; or keep it and rely on input normalization plus golden tests to prove existing behaviour is untouched.
- **Decision:** Kept at `planning-rules-v1`. The field is optional, trimmed like every other string, absent-when-empty through the same normalization that feeds `plannerInputFingerprint` (so a plan that *used* a note can never collide with one that did not), and documented in `docs/planner-engine.md` §13. The 4B engine and CLI goldens — twelve trace steps, unchanged fingerprints and output — are the evidence; they pass unchanged.
- **Reason:** The version exists to tell an auditor whether the same input would plan differently. For every input that predates 4C it would not, and saying otherwise would degrade the meaning of the constant.
- **Trade-offs:** The judgement is behavioural rather than textual, so it is only safe with goldens to back it: a future rule change must prove the same way or bump. If a reviewer decides recorded plans need per-field attribution for this channel, that is a rules-version change and it should be made deliberately.

## D-050 — Materialization is a bridge over the existing engine, never an engine

- **Date / status:** 2026-10-05 · Accepted (Phase 5)
- **Context:** An approved, executable plan needed to become real work, and the tempting shape was an "execution subsystem" with its own job table, dispatcher, retry policy, and status field on the plan version. Phase 1 already owns a durable queue with claims, leases, expiry recovery, retry classification, ACK, and idempotent job creation; Phase 3 owns the services that write those rows.
- **Options:** Build a plan-runner layer with its own execution state; extend the queue/worker with plan awareness; or add one service that *materializes* rows and hands them to the untouched engine.
- **Decision:** The third. `PlanExecutionService` maps the version through 4B's `mapPlanToJobs`, then writes scenes and scene versions through `SceneService` and jobs through `GenerationService.requestGeneration` — it owns no claim, lease, attempt, retry decision, provider call, asset byte, or review outcome, and there is no new plan-version status besides the lifecycle's `EXECUTABLE`. A `plan_executions` row records *that* a version was materialized; whether the work succeeded remains a question the job, queue, attempt, asset, QC, and review rows answer.
- **Reason:** A second engine would put two authorities in charge of the same durable state, which is exactly the failure the earlier phases were built to avoid. Keeping the bridge thin also keeps every Phase 1 reliability property — recovery-before-submit, ambiguous-work `FAIL_CLOSED`, one attempt ledger — true for planned work without re-proving them.
- **Trade-offs:** No plan-level "run to completion" convenience: materializing and running are separate commands, and an operator (or a later daemon) drives the worker. Batch policies, scheduling, and auto-run remain future phases, and this phase deliberately did not grow them.

## D-051 — Atomic materialization through a repository `transaction()` passthrough, not a new repository

- **Date / status:** 2026-10-05 · Accepted (Phase 5)
- **Context:** A materialization writes N scenes, N scene versions, N jobs, and N queue items. Half of that is a corrupt state: a scene version whose job vanished, or a queue item with no plan link. The repository already wraps each of those writes in its own `BEGIN IMMEDIATE` transaction, and `services` owns no SQL by rule.
- **Options:** An `ExecutionRepository` in `packages/storage` owning the composite write; sequential writes with compensation on failure; or expose the existing connection's transaction to the service through a narrow port method.
- **Decision:** The third. `JobRepository` gained `transaction<T>(work)`, a passthrough to the SQLite connection's `BEGIN IMMEDIATE` — and the nesting behaviour the design depends on was measured, not assumed: an inner repository transaction becomes a savepoint, so a caught inner failure loses only its own unit while an uncaught one rolls the whole outer transaction back. The service wraps the entire materialization in one call to it. No `ExecutionRepository`, no compensation logic, no second transaction owner.
- **Reason:** A dedicated repository would duplicate table knowledge that `SqliteJobRepository` already owns correctly; compensation would leave a visible window of partial state; and a single savepoint-aware unit gives the guarantee the phase is named for, at the cost of one method on a port that already had ten.
- **Trade-offs:** The whole graph is one writer's critical section, so a very large plan holds a write transaction open longer than one row would; the pre-pass that computes `plan_executions` counts runs inside it, adding reads to that window. Local SQLite with a single worker makes this the right trade today; a multi-writer future would revisit it, not quietly inherit it.

## D-052 — Execution identity is a fingerprint of canonical inputs, and provenance sits outside job identity

- **Date / status:** 2026-10-05 · Accepted (Phase 5)
- **Context:** "Materialize twice and nothing duplicates" only holds if the identity of a materialization is reproducible across processes, restarts, and retries — and if adding plan provenance does not change what a job *is*.
- **Options:** Store a `planExecutionId` inside the job's idempotency identity; use a random or timestamped execution id per call; or derive a fingerprint over the inputs that decide what work exists and derive every id from it.
- **Decision:** The third. `executionFingerprint` covers project, plan version id, scene plan id, spec (kind, prompt, output count, aspect ratio, duration), capability requirements, references, rules version, and the normalized selected-provider list. Timestamps, UUIDs, priorities, `maxAttempts`, leases, worker identity, attempt counts, and provider responses are excluded. `executionId`, `sceneVersionId`, and the reuse keys come from `plannerId` over that fingerprint (the same derived-id discipline as 4B), and `generation_jobs.plan_execution_id` is an additive column kept *out* of `identityJson`.
- **Reason:** A retry must look like the same work, and provenance must not alter the work it describes. Putting the execution id inside job identity would fork a job for every re-materialization; deriving ids from content means the idempotent answer falls out of the data rather than depending on a lookup that could be missed.
- **Trade-offs:** Determinism is a promise about the inputs listed, so adding an input that changes materialization decisions means bumping `EXECUTION_RULES_VERSION` — a fingerprint that quietly widened would silently collide. `plan_executions` therefore refuses a stored-fingerprint conflict outright instead of reusing a row whose counts describe different work.

## D-053 — Readiness is a gate that writes nothing, and capability drift is re-checked at the gate

- **Date / status:** 2026-10-05 · Accepted (Phase 5)
- **Context:** `EXECUTABLE` was granted by 4A's gate against the provider declarations of that moment. Registration can change afterwards, and a plan that cannot be served must not burn a queue item or enter a retry loop to discover it.
- **Options:** Trust the `EXECUTABLE` stamp and let the worker fail; enqueue and mark the job failed; or re-derive the assessment before the first write and refuse.
- **Decision:** Re-derive. `assessExecutionReadiness` (pure, shared with the read-only `planExecution.readiness()` and with `--dry-run`) checks lifecycle, ownership, archived state, current validation evidence for the exact content hash, per-spec soundness, scene conflicts, and — against the *current* `ProviderRegistry` — capability satisfiability. A real run throws `EXECUTION_NOT_READY`, or `EXECUTION_CAPABILITY_UNAVAILABLE` when every blocker is capability-attributable and at least one names a positively-detected capability miss; a dry run returns the same blockers with exit code `3` and writes nothing either way.
- **Reason:** Failing closed before a queue item exists is the only variant that cannot waste work or hide a defect: no burned item, no retry loop, no silent fallback to a different provider. Choosing the error code from computed capability evidence rather than from the mapping's prose means an upstream wording change cannot downgrade an explicit capability refusal into a generic one.
- **Trade-offs:** Two gates (approval and materialization) can disagree, which is correct but can surprise an operator who approved hours earlier; and the report is a snapshot, since readiness can change between a dry run and a real one — which is exactly why a dry run says so in a `DRY_RUN` notice. A version that is not `EXECUTABLE` also has its derived per-spec blockers suppressed, so the report names the cause instead of a list of symptoms.

## D-054 — A Scene is a project container: the plan's scene number is intent, not an assignment

- **Date / status:** 2026-10-05 · Accepted (Phase 5)
- **Context:** `scenes.scene_number` is unique per project, while a plan version numbers its own scene plans from 1. Materializing a second plan — or a re-plan whose scene keys changed — into a project that already holds numbers 1..N collides. A `ScenePlan` must also never silently become a `Scene` outside materialization.
- **Options:** Make execution scenes per plan version (guaranteed collisions and duplicated containers); reuse any scene with a matching number (wrong — different shots, one container); or reuse by deterministic id and allocate the next free number for a genuinely new scene.
- **Decision:** The third. Reuse is by the 4B-derived scene id (`plannerId("plan:" + planId, "execution-scene", sceneKey)`), which is what makes re-running a plan land on the same container; a new scene takes the first free number at or after its planned number, preserving the plan's relative order; a reused scene keeps the number it already has. Execution order itself is carried by queue priority and the one-step `dependsOn`, not by scene numbering.
- **Reason:** Numbering is a project-level presentation, order is an execution property, and conflating them would either fail on legitimate re-plans or let a database constraint decide semantics. Reused scenes keeping their numbers also avoids silently reordering work that is already finished and reviewed.
- **Trade-offs:** A materialization report's planned numbers can differ from the numbers stored when a collision was resolved, so the report shows the resolved value and the fingerprint deliberately excludes scene numbers; and a project's scene list is not a faithful view of any one plan's numbering (it never was — `plan inspect` is).

## D-055 — The bridge's invariants are enforced by v7 triggers, not by caller discipline

- **Date / status:** 2026-10-05 · Accepted (Phase 5)
- **Context:** A link column that any `UPDATE` can rewrite is not evidence. Phase 5's links answer "which plan version, scene plan, spec, and materialization produced this row", and that question has to stay answerable after a bug, a future refactor, or a hand-run SQL session.
- **Options:** Enforce in the service only; add a separate trace table (as considered and rejected in 4B); or extend the additive v7 columns with the same database-level rules 4A/4B/4C used for plan and AI provenance.
- **Decision:** The third: `plan_executions_are_immutable` and `plan_executions_cannot_be_deleted`; `scene_versions_plan_link_must_be_complete` (all four link columns or none); `generation_jobs_plan_link_is_write_once`, written to refuse *adding* a link as well as changing one; and `ON DELETE RESTRICT` on every new foreign key. `plan_executions` is inserted before scene versions because they reference it, and its counts come from a read-only pre-pass in the same transaction so the numbers stored are the numbers reported.
- **Reason:** Tests can only prove the behaviour of code that is run; the guarantee that survives an unknown future caller is the one the database refuses to accept. Symmetric write-once matters specifically because attaching a plan after the fact would make provenance look like evidence when it is an afterthought.
- **Trade-offs:** Repairing corrupt execution state now needs a deliberate migration rather than an ad-hoc update, and the immutability of `plan_executions` means a *counting* change is a new row (a new fingerprint), not an edit — which is the intended semantics but costs a schema step if a real correction is ever needed.

## D-056 — `plan execute` is the only new verb, and the earlier "no execution command" test was narrowed rather than deleted

- **Date / status:** 2026-10-05 · Accepted (Phase 5)
- **Context:** 4A/4B/4C each asserted that no CLI command could turn a plan into work — including `apps/cli/test/planning-cli.test.mjs` expecting `plan execute` to be an unknown command, and a help assertion that the string `plan execute` never appear. Phase 5's brief sanctions exactly one such command, so those assertions contradicted the shipped surface.
- **Options:** Delete the offending assertions; keep them and name the command something unrelated; or narrow them to the invariant that actually mattered and keep it enforced.
- **Decision:** The third. `plan execute` (plus the read-only `plan execution`/`plan executions`) exists; the planning-cli test now asserts the surviving half — reading a plan (`plan preview`, `plan status`, `scene list`, `queue status`) still creates nothing, and the new verb enqueues for the existing worker instead of executing, with the item count it predicted becoming that many queued jobs — and the help assertion became "no *direct* provider or browser verb is advertised" while `plan execute` is. Every `planner …` test proving that `planner execute`, `planner ai-execute`, and `--execute` do not exist stays exactly as written, because it is still true. A blocked `--dry-run` also reports instead of throwing and signals through exit `3`.
- **Reason:** An assertion that records a phase boundary should be re-pointed at the boundary, not deleted with the phase name; and a thin verb that cannot reach a provider keeps the original safety claim intact in its stronger form.
- **Trade-offs:** Two tests changed in a phase that otherwise added no behavioural churn, so a reviewer must read this entry to see the change was deliberate; and the narrowed assertion no longer proves absence-by-name, only absence-by-capability, which is the weaker-sounding but more meaningful property.

## D-057 — Reuse is matched on content, and counts describe the call that created them

- **Date / status:** 2026-10-05 · Accepted (Phase 5)
- **Context:** Idempotency claims fail in the gap between "a row with this id exists" and "this row is the work I was about to write". A reuse that assumes from the id could report a scene version whose prompt or link differs, and a report whose counts drift from the stored row makes a retry look safe when it is not.
- **Options:** Reuse by id alone; recompute the whole graph and diff it; or reuse only when the existing row's content matches what this call would have written, and keep counts write-once.
- **Decision:** Match, then reuse. A scene version counts as `REUSED` only if its prompt, references, and `planExecutionId` all agree with the unit; a job only if its provider and stable parameters agree. Anything else is a different identity and takes the conflict path (`plan_executions` refuses a fingerprint that describes different work; a content-mismatched scene version is not reused). Tallying uses one `applyTally` for both the dry run's predictions and the write path's real outcomes, so a report cannot double-count, and `job_count`/`reused_job_count` on the stored row belong to the creating call — a later reuse neither restamps nor amends them, with `queueItemsCreated` reported separately in the response because a reused job has no new queue item.
- **Reason:** Deterministic ids make collisions *possible by construction* (two different inputs that hash alike, or a row written by a different execution), so the safe reading is to verify content rather than trust identity — and an immutable count is only honest if it is defined as "what the creating call did".
- **Trade-offs:** Reuse costs a comparison per unit; and a genuine content change under the same fingerprint is reported as a hard refusal rather than repaired, which is slower to resolve but never silently wrong.

## D-058 — Phase 6 hardened the existing provider instead of adding a real-provider layer

- **Date / status:** 2026-10-05 · Accepted (Phase 6)
- **Context:** The path the brief asked to make production-safe — `GenerationJob → provider registry → GoogleFlowProvider → BrowserGateway → Google Flow` — already existed: `apps/cli/src/runtime.ts` builds the descriptor and the gateway-backed provider and hands it to the Phase 1 `LocalQueueWorker`, which already asks `findGeneration` before `createGeneration` and already defers `submissionUnknown` on the same attempt. A "real provider integration" phase could therefore have meant a new Flow orchestrator, a provider-side retry/recovery loop, or a rewritten adapter.
- **Options:** Add a Google-specific execution service/queue/worker (a second engine, explicitly forbidden and redundant); rewrite the adapter from the brief (discarding proven Phase 2 invariants for no new guarantee); or extend the existing adapter and composition root in place and add automated proof where proof was missing.
- **Decision:** The third. Phase 6 changed four things and only them: the distinguishable state/error taxonomy, the mandatory pre-click prompt verification, the recovery classification rule applied per stage, artifact describability before handoff, plus one operator-facing configuration code at the composition root. `packages/core`, `queue`, `assets`, `qc`, `events`, `browser`, and `apps/browser-gateway` are untouched, and `packages/services` gained exactly one entry in its error-code table.
- **Reason:** A boundary is made safe by removing the places where it could act on an assumption, not by adding a layer above it; and a rewrite of code that already refuses to double-submit would have to re-prove every refusal it inherited.
- **Trade-offs:** The adapter is now ~1,450 lines carrying its own classification table, so the next provider has the same bar with no framework to hold it; and hardening in place means some Phase 2 shapes (the local `flow-<sha256>` job id, the manifest state machine) are now load-bearing and harder to change later.

## D-059 — Prompt verification uses the only two channels the gateway exposes, and it happens before the side effect

- **Date / status:** 2026-10-05 · Accepted (Phase 6)
- **Context:** The supplied prompt is authoritative, but `CdpBrowserGateway` deliberately returns an empty `text` for contenteditable and input elements ("do not expose live editable contents"), so the adapter cannot compare the editor's contents the way a test fake could. Before this phase, integrity rested on the guarded `fill` (compare-before-write plus read-back `verified`) and on the correlation rule *after* the click — which meant the first moment an unverifiable prompt could be detected post-fill was after a real generation had been requested.
- **Options:** Trust `fill.verified` alone; widen the gateway to return editor contents for verification (breaking its own redaction rule and putting prompt bodies into discovery/diagnostics); or require, immediately before the click, exactly one new occurrence of the authoritative prompt in the page's visible text, measured against the pre-fill baseline, in the same browser session.
- **Decision:** The third. A mismatch or an unreadable page leaves the recovery record at `NOT_SUBMITTED` and raises `FLOW_PROMPT_NOT_VISIBLE` with `retryable: false` — no click, and no claim that the remote side is clean beyond the fact that nothing was dispatched.
- **Reason:** The correlation step already needed that exact evidence, so the pre-click gate cannot refuse a submission correlation would have accepted; it only moves the decision in front of the irreversible action, and the gateway's redaction is preserved instead of negotiated around.
- **Trade-offs:** If live Flow renders the prompt somewhere `document.body.innerText` does not cover, nothing can be submitted through this adapter at all — which is a deliberate fail-closed outcome and the first thing the manual Colab check must establish; and the session-identity re-check adds a second reason (besides correlation) for the same code.

## D-060 — Recovery classification comes from two questions, and from whether a dispatch was possible

- **Date / status:** 2026-10-05 · Accepted (Phase 6)
- **Context:** `GenerationProviderError` carries exactly two recovery flags, and the durable queue reads them once: non-uncertain errors may fail the attempt (and the existing retry semantics may then take a new attempt), uncertain errors defer the *same* attempt. Phase 2 set `submissionUnknown: true` generously — including for pre-click states where no submission was possible — and used `FLOW_UI_CHANGED` for five distinguishable conditions, so an operator could not tell "the page is still loading" from "the editor is gone", and a merely-busy page and an authentication wall both burned recovery cycles before ending behind the uncertain-work guard.
- **Options:** Keep the generous flag (safe, but every refusal looks alike); give the queue a provider-specific classification table (a second retry engine, forbidden); or derive the flags from two questions asked at the point of failure — *would waiting plausibly help* (`retryable`) and *might a remote generation already exist* (`submissionUnknown`, true only where a dispatch was possible).
- **Decision:** The third, applied through one `sessionError(inspection, stage)` function so no throw site invents its own policy. `retryable: false, submissionUnknown: false` for pre-click states a person must act on (`FLOW_AUTH_REQUIRED`, `FLOW_ACCESS_BLOCKED`, `FLOW_EDITOR_NOT_FOUND`, `FLOW_PROMPT_INPUT_NOT_FOUND`, `FLOW_GENERATE_CONTROL_NOT_FOUND`, `FLOW_UI_CHANGED`, `FLOW_UNSUPPORTED_REQUEST`); retryable for transient ones (`FLOW_PAGE_NOT_READY`, `FLOW_BROWSER_UNAVAILABLE`, busy session); and every state reached after a dispatch keeps `submissionUnknown: true`, including authentication loss mid-generation. A click whose dispatch was never confirmed now reports `FLOW_SUBMISSION_UNKNOWN` instead of result ambiguity when the page shows nothing, because the honest uncertainty is about the submission.
- **Reason:** The durable guard that refuses a blind resubmission keys on uncertainty, so claiming uncertainty where none exists hides a safe manual retry behind a refusal, and claiming none where it exists risks a second generation. Making the *stage* of the failure part of the classification is what keeps one code (say, `FLOW_AUTH_REQUIRED`) correct on both sides of the click.
- **Trade-offs:** Same-code-different-flags means the stage argument is now part of the adapter's contract and must be passed correctly by every future call site; a pre-click refusal that fails the attempt needs one explicit `flowforge retry` after the operator fixes the page; and a `retryable: true` transient state consumes an attempt rather than a recovery, so an operator watching a long busy period sees attempt numbers advance.

## D-061 — Artifact describability is checked at the boundary; image judgement stays in QC

- **Date / status:** 2026-10-05 · Accepted (Phase 6)
- **Context:** After positive correlation the adapter hands one local file to `FileSystemAssetStore`, and the worker derives a MIME type from the filename, falling back to `application/octet-stream` for anything extension-less. So a corrupt or unexpectedly-named download could reach the asset graph and be recorded as a QC failure, blurring "the provider gave us garbage" with "the image is low quality", and a valid image with a nameless download was described worse than it was known.
- **Options:** Reuse the extension rule as-is; run a full media probe inside the provider (duplicating the existing deterministic QC validator, which the brief forbids); or keep only the describability decision at the boundary and let QC own judgement.
- **Decision:** The third. `FLOW_INVALID_ARTIFACT` is raised when neither the download name nor the file's own signature identifies a supported image; a nameless download is described by its signature so the asset record is truthful; and a stored file that stops meeting that bar is re-downloaded from the same correlated result rather than imported or regenerated.
- **Reason:** "Can we say what this is?" is a provider question with a provider answer, whereas "is this image acceptable?" is already answered by a versioned validator with recorded checks — the two differ in who must fix the failure.
- **Trade-offs:** Five signatures and six extensions is a small allow-list that will need widening alongside QC, not instead of it; and because the invalid case keeps `submissionUnknown: true`, an unusable download ends in bounded same-attempt recovery rather than an immediate failure, which is slower but never duplicates a generation.

## D-062 — Phase 6 evidence is a fake gateway with counters, and no existing test was weakened

- **Date / status:** 2026-10-05 · Accepted (Phase 6)
- **Context:** The rules under test are statements about side effects — one Generate click per attempt, no download without correlation, no regeneration after a timeout — which survive badly as message-text assertions; and the brief forbade real Flow execution, while the 22 Phase 2 tests already pinned the adapter's behavior.
- **Options:** Assert error strings; run the opt-in live smoke in CI (excluded by the boundary, and it consumes a real account); or script a fake `BrowserGateway` in `test/support/` that counts `generateClicks`, `downloadCalls`, `pollCalls`, `fillCalls`, and `resolveCalls` and logs operations in order.
- **Decision:** The fake gateway, in two new suites (`real-provider-boundary.test.mjs`, `real-provider-integration.test.mjs` — the second driving the real repository, queue, worker, asset store, and QC) plus five CLI composition-root tests, with every counter assertion written as "stays 1" or "never leaves zero". Existing tests were not modified or removed; the two fixtures that could have been reinterpreted (the `text`-carrying prompt element) were left alone because the real gateway does not expose editor text, and the new fake reproduces that redaction so a passing test cannot depend on a channel production does not offer.
- **Reason:** A counter is the only assertion that stays true when the message wording, the code list, or the retry engine changes; and reproducing the gateway's redaction in the fake keeps the suite honest about what the adapter can actually see.
- **Trade-offs:** The fake is now a maintenance surface that has to follow `BrowserGateway`, and a green suite is evidence about FlowForge's decisions only — the documentation and README say so plainly rather than implying live coverage. `GOOGLE_FLOW_NOT_CONFIGURED` was added to the services error table (where operator refusals live) rather than to the provider's code list, because configuration state is not a provider outcome.
