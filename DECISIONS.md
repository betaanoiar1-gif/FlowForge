# FlowForge Engineering Decision Log

- **Started:** 2026-10-04
- **Status note:** D-001–D-012 record the Phase 0 architecture/research decisions. D-013–D-018 record Phase 1 implementation choices. Implemented behavior and validation status are described in [ARCHITECTURE.md](./ARCHITECTURE.md) and [docs/vertical-slice.md](./docs/vertical-slice.md).

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
