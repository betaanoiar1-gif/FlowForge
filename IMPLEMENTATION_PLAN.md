# FlowForge Implementation Plan

- **Current stage:** Phase 2 provider implementation and fake-based verification are complete (2026-10-04); live Flow validation is **BLOCKED / NOT RUN** without an authorized CDP session.
- **Next validation milestone:** run the separate opt-in live smoke on a user-authorized, manually authenticated Flow session; stop if UI correlation is ambiguous.
- **Provider rule:** Google Flow remains replaceable and isolated. MockProvider remains the deterministic local/CI provider; neither queue nor domain is replaced.

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

## Phase 2 — Google Flow browser provider

The Phase 2 code path is implemented behind the existing `GenerationProvider` and `BrowserGateway` boundaries. It supports only one image request with no references or non-default settings. The browser target definitions live only in `providers/google-flow`; generic browser mechanics remain in `packages/browser`. The durable queue, request-key recovery, filesystem asset import, and deterministic QC are reused unchanged.

### Phase 2 acceptance criteria

1. **Manual session and status:** attach to the configured CDP endpoint; report disconnected/no-page/not-Flow/manual-auth-required/blocked/busy/ready/UI-changed states from visible page data. Never automate authentication or inspect browser storage.
2. **Narrow request:** accept one image request only when Image mode is visibly selected, a unique visible prompt editor exists, the guarded fill confirms the editor is still empty at write time and reads back exactly, the request contains no unsupported references/settings, and a unique enabled visible Generate control exists after fill. No silent overwrite or setting guess.
3. **Durable same-attempt recovery:** persist an attempt-keyed manifest before Generate. Store a one-way prompt hash, baseline visible prompt count/media fingerprints, opaque session identifier, state, and correlation evidence—not cookies, credentials, browser storage, raw page text, or plaintext prompt. Pass the existing generic request object through the provider port to correlate after process restart.
4. **Safe correlation/download:** accept only exactly one new prompt occurrence and one accessible new media element, or a prompt-correlated visible active-generation signal. Recheck the same result before hovering and using a unique visible Download control. Any missing/duplicate/changed evidence raises a typed uncertain error and the existing queue retains the same attempt; no blind resubmission.
5. **Existing finalization:** return one local artifact to the existing queue; reuse the current asset store, deterministic QC, attempt provenance, and transactional finalization. Do not add a parallel retry engine or duplicate asset/QC pipeline.
6. **Fake tests:** exercise gateway operations, auth/block handling, unsupported requests, request-key idempotency, post-click uncertainty, restart recovery, correlation, download, and the provider contract through the existing queue/asset/QC packages without an account.
7. **Typed errors, timeouts, and cancellation:** map failures to distinct `GenerationProviderError` codes for manual auth/access block, changed UI/session, click/download timeout, ambiguous correlation, download failure, unsupported request, recovery-storage failure, and correlated generation failure. A timeout is uncertain state, never proof of provider failure: the queue defers the same attempt and re-inspects it before any submission decision. FlowForge local cancellation is final; remote Flow cancellation is deliberately unavailable (`FLOW_CANCEL_UNAVAILABLE`) and never clicks a generic Stop/Cancel control without unambiguous per-attempt ownership.
8. **Separate live smoke:** keep actual Flow generation opt-in and outside ordinary CI. The script requires explicit confirmation and must never retry a timed-out or ambiguous request under a new key.

**Code gate:** build/typecheck and fake tests pass. **Live gate:** BLOCKED / NOT RUN because no authorized browser session was available; no claim of real Flow submission, correlation, or download success is made. See [docs/google-flow-provider.md](./docs/google-flow-provider.md).

## Remaining milestones

| Phase | Scope | Exit gate |
| --- | --- | --- |
| **0 — Audit** | Inspect the checkout; document current system, public feature research, gaps, decisions, and the first slice. | **Complete.** See [ARCHITECTURE.md](./ARCHITECTURE.md), [FEATURE_MATRIX.md](./FEATURE_MATRIX.md), and [DECISIONS.md](./DECISIONS.md). |
| **1 — Durable mock-backed vertical slice** | Project/scene versions, stable logical idempotency, schema migrations, durable queue/leases/attempts, MockProvider, asset store, deterministic QC, review/selection, CLI and tests. | **Complete.** Validation commands and constraints are recorded below and in [docs/vertical-slice.md](./docs/vertical-slice.md). |
| **2 — Google Flow browser provider** | Visible-UI single-image provider behind the existing provider port, gateway hardening, durable same-attempt recovery, safe correlation/download, typed errors, and fake tests. | **Code complete and fake-tested.** Live gate is **BLOCKED / NOT RUN** until the opt-in smoke runs on a user-authorized session. |
| **3 — Application services and operator UX** | Add narrowly scoped use-case services and, only when needed, a review/queue interface over the proven repository boundaries. | UI decisions use persisted IDs and cannot mutate storage directly; selection/review remains explicit. |
| **4 — Creative intelligence** | Add structured brief/story/story-spine/storyboard planning, shots, prompts, character/world profiles, Visual DNA, and continuity constraints. AI adapters return schema-validated data through explicit application tools. | Deterministic fixtures validate planner schemas, IDs, references, and scene-level regeneration. |
| **5 — Rich review and QC** | Add richer review categories/feedback and optional deterministic media probes or validated semantic checks. Keep unsupported metrics `NOT_EVALUATED`. | Evidence links to persisted records; no semantic score without a validated evaluator and reviewable evidence. |
| **6 — Media pipeline** | Add isolated audio/narration/music/caption/timeline/render/export jobs. Preserve source asset/version provenance and support requested output formats. | Reproducible render fixture and format-specific QC trace to source scene versions, generations, assets, and reviews. |
| **7 — Agent system** | Add specialist agents over typed, authorized domain tools and explicit workflow tasks. | Schema validation, tool authorization, audit logs, and policy tests; agents cannot write arbitrary DB rows. |
| **8 — Publishing** | Add provider-independent publishing adapters, scheduled/queued publish jobs, status, retry, and audit history. | Mock publishing tests first; credentials remain in environment/secret storage, never source or logs. |
| **9 — Analytics** | Derive retry/duration/provider/rejection/render/publish metrics from persisted workflow history. | Reproducible denominators/time ranges; no invented provider or semantic scores. |

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
