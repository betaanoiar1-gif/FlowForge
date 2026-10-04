# FlowForge Implementation Plan

- **Current stage:** Phase 1 durable mock-backed production slice implemented and validated (2026-10-04).
- **Next coding milestone:** provider-independent browser hardening only after the core slice is reviewed; do not integrate Google Flow in Phase 1.
- **Provider rule:** Google Flow remains a replaceable backend. The MockProvider is the Phase 1 proof of the provider-neutral workflow.

## Phase 1 slice delivered

```text
Project
  → immutable, versioned Scene + explicit current version
  → logically idempotent GenerationJob + atomic SQLite queue item
  → persisted claim / lease / attempt history
  → provider recovery lookup before any resubmission
  → MockGenerationProvider
  → filesystem asset bytes + SQLite provenance/hash/metadata
  → deterministic QC evidence
  → exact-asset-version Review
  → explicit approved-version selection
```

The CLI runs a deterministic success scenario and prints the persisted report. The queue, provider manifest, SQLite database, and asset files live on disk; the mock makes no network request and represents no live-model output.

### Phase 1 acceptance criteria

1. **Project and scene versions:** projects and scenes persist; scene versions are immutable snapshots. Creating a version sets the current pointer once; explicit version selection is a separate operation. Migrated legacy jobs are linked to generated legacy scene versions when possible.
2. **Logical idempotency:** a canonical request identity covers project, scene/version, provider, prompt/references, and generation parameters. A SHA-256 key is protected by a SQLite unique index; identical calls return the existing logical job and queue item.
3. **Queue durability:** job and queue item insert atomically. Workers claim with a persisted lease, heartbeat it, recover expired claims, preserve the same active attempt after a crash, and acknowledge only in the finalization transaction. A stale worker cannot renew or complete work after lease loss.
4. **Attempt/provider recovery:** every attempt has a stable provider request key and persisted status/history. Before a first submission the worker asks the provider to find that request key. After a crash following provider success but before the provider ID reaches SQLite, it recovers the existing result instead of submitting again. Ambiguous results remain on the same attempt; exhausted uncertainty is terminal and cannot be blindly retried as a new attempt.
5. **Provider contract and mock:** the neutral port includes `findGeneration`, `createGeneration`, status lookup, result download, and cancellation. Mock modes are success, transient failure, permanent failure, timeout, and duplicate result. The Google Flow adapter exposes no live generation path in this phase.
6. **Asset storage and QC:** bytes are stored outside SQLite under deterministic job/output paths. Metadata records project/scene/job/scene-version/attempt/provider, MIME, byte count, SHA-256, output index, and available dimensions. QC records existence/readability, supported MIME/signature, exact size, checksum, and dimensions for supported image formats. QC failures and unmeasured checks are never converted to a pass.
7. **Review and selection:** a review is tied to the exact asset version. Approval or rejection is explicit and terminal; only an approved asset version with passing deterministic QC can be selected. Selection updates the scene's explicit current/selected pointers.
8. **SQLite upgrades:** schema version 3 migrates fresh, schema-v2, and legacy databases without dropping data; the v2-to-v3 integrity-trigger upgrade has direct test coverage. Ambiguous legacy active jobs are marked failed/visible rather than silently replayed.
9. **Tests/scripts/docs:** automated tests cover migration, immutable versioning, idempotency, lease fencing/recovery, provider crash recovery, duplicate results, transient retry, permanent failure, timeout, QC failure, review, and selection. Root scripts expose build, typecheck, test, and vertical slice. README/architecture/plan/decision docs match the implementation.

### Phase 1 implementation boundaries

- Keep the existing pnpm/TypeScript/SQLite workspace; no Redis, broker, cloud, distributed database, UI, or API was added.
- `packages/storage` owns migrations and transactional repositories. `packages/queue` owns the worker and provider/artifact orchestration. `providers/mock` is a separate adapter. `packages/assets` stores bytes; `packages/qc` emits deterministic evidence.
- The worker currently supports one distinct result per generation. Duplicate copies with the same provider output index and matching bytes are collapsed; multiple distinct outputs are rejected instead of silently discarded.
- Deterministic image dimensions are parsed for PNG, JPEG, GIF, WebP, and BMP. Unsupported image formats remain `NOT_EVALUATED`; there is no semantic/continuity QC or media codec probe.
- A provider that cannot determine an ambiguous request is not retried under a new attempt automatically. Bounded recovery ends visibly; a new scene version is the safe path rather than re-submitting the same logical generation blindly.
- CLI review is a demonstration operator decision, not a production human-review interface. No UI is included.

## Remaining milestones

| Phase | Scope | Exit gate |
| --- | --- | --- |
| **0 — Audit** | Inspect the checkout; document current system, public feature research, gaps, decisions, and the first slice. | **Complete.** See [ARCHITECTURE.md](./ARCHITECTURE.md), [FEATURE_MATRIX.md](./FEATURE_MATRIX.md), and [DECISIONS.md](./DECISIONS.md). |
| **1 — Durable mock-backed vertical slice** | Project/scene versions, stable logical idempotency, schema migrations, durable queue/leases/attempts, MockProvider, asset store, deterministic QC, review/selection, CLI and tests. | **Complete.** Validation commands and constraints are recorded below and in [docs/vertical-slice.md](./docs/vertical-slice.md). |
| **2 — Application services and operator UX** | Add narrowly scoped use-case services and, only when needed, a review/queue interface over the proven repository boundaries. | UI decisions use persisted IDs and cannot mutate storage directly; selection/review remains explicit. |
| **3 — Browser layer** | Harden provider-independent session operations: lifecycle, explicit page selection, allowed navigation, semantic input/click, waits/observe, upload/download, screenshots/evidence, clean shutdown, and test doubles. | Tests pass without a Google account; browser commands run only against a configured, user-owned session and allowed origin. |
| **4 — Google Flow adapter** | Only after authorization and public UI feasibility are established, implement visible user-authorized UI workflows behind the existing provider port. No private API, hidden endpoint, credential extraction, or access-control bypass. | Opt-in non-generating discovery first; any generation is explicit and user-authorized. Ambiguous outcomes pause rather than duplicate. No live generation in routine CI. |
| **5 — Creative intelligence** | Add structured brief/story/story-spine/storyboard planning, shots, prompts, character/world profiles, Visual DNA, and continuity constraints. AI adapters return schema-validated data through explicit application tools. | Deterministic fixtures validate planner schemas, IDs, references, and scene-level regeneration. |
| **6 — Rich review and QC** | Add richer review categories/feedback and optional deterministic media probes or validated semantic checks. Keep unsupported metrics `NOT_EVALUATED`. | Evidence links to persisted records; no semantic score without a validated evaluator and reviewable evidence. |
| **7 — Media pipeline** | Add isolated audio/narration/music/caption/timeline/render/export jobs. Preserve source asset/version provenance and support requested output formats. | Reproducible render fixture and format-specific QC trace to source scene versions, generations, assets, and reviews. |
| **8 — Agent system** | Add specialist agents over typed, authorized domain tools and explicit workflow tasks. | Schema validation, tool authorization, audit logs, and policy tests; agents cannot write arbitrary DB rows. |
| **9 — Publishing** | Add provider-independent publishing adapters, scheduled/queued publish jobs, status, retry, and audit history. | Mock publishing tests first; credentials remain in environment/secret storage, never source or logs. |
| **10 — Analytics** | Derive retry/duration/provider/rejection/render/publish metrics from persisted workflow history. | Reproducible denominators/time ranges; no invented provider or semantic scores. |

## Cross-cutting engineering rules

- Keep the current TypeScript/pnpm workspace and evolve `core`, `storage`, `queue`, `browser`, `events`, and provider packages rather than rebuilding the repository.
- Keep provider-specific behavior inside that adapter; do not scatter selectors or provider checks through core and storage.
- Validate untrusted inputs at boundaries and keep domain operations typed.
- Use forward-only migrations; preserve existing metadata. Persist before external side effects and make retry/recovery idempotent.
- Distinguish `GenerationJob`, `GenerationAttempt`, `Asset`, `AssetVersion`, `QCResult`, and `Review` IDs. Filenames are labels only.
- Keep state and failure visible. Redact secrets, cookies, tokens, and private browser content; never bypass authentication, CAPTCHA, security controls, or provider restrictions.
- Start with a single local worker. Do not add distributed infrastructure or concurrency without a demonstrated requirement and tested provider limits.
- Keep live provider tests explicit, opt-in, and separate from deterministic CI.

## Phase 1 validation record

The final validation record for this implementation is in [docs/vertical-slice.md](./docs/vertical-slice.md). It includes the exact build/typecheck/test/CLI commands and distinguishes local SQLite runtime validation from the unimplemented live browser/provider paths.
