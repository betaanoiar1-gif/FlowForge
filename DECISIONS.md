# FlowForge Engineering Decision Log

- **Started:** 2026-10-04
- **Status note:** D-001–D-012 record Phase 0 architecture/research decisions, D-013–D-018 record Phase 1 implementation choices, D-019–D-022 record Phase 2 provider choices, D-023–D-027 record the Phase 3 application-service and operator-surface choices, and D-028–D-035 record the Phase 4A creative planning domain, and D-036–D-042 record the Phase 4B deterministic planner engine. Implemented behavior and validation status are described in [ARCHITECTURE.md](./ARCHITECTURE.md), [docs/vertical-slice.md](./docs/vertical-slice.md), [docs/google-flow-provider.md](./docs/google-flow-provider.md), [docs/application-services.md](./docs/application-services.md), and [docs/planning-domain.md](./docs/planning-domain.md), and [docs/planner-engine.md](./docs/planner-engine.md). Live Flow validation is blocked/not run.

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
- **Trade-offs:** Planning quality is bounded by the rules, and prose is never improved by the engine — a verbose beat yields a verbose scene. An AI planner (4C) must pass the same validator rather than being trusted to produce a plan.

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
