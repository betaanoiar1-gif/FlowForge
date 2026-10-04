# FlowForge Architecture

- **Baseline audit:** 2026-10-04, commit `f8b7019c1b924bc4a25b6642c5e1dc18e63578ef`.
- **Current status:** Phase 1 mock-backed slice is implemented; Phase 2 Google Flow browser provider is implemented and fake-tested (2026-10-04).
- **Live-provider status:** no authorized CDP/browser session was available. Real Flow submission, status, correlation, and download are **BLOCKED / NOT RUN** and are not claimed as passing.

## Executive summary

FlowForge is a provider-neutral creative-production system. The local project graph and persisted workflow metadata—not a provider's workspace—are canonical. Phase 1 now exercises a complete local path:

```text
Project → SceneVersion → idempotent Job → durable SQLite Queue
        → provider-neutral Worker → MockGenerationProvider
        → filesystem Asset → deterministic QC → Review → selected version
```

The core, SQLite migrations/repository, queue/worker, filesystem asset store, QC, MockProvider, and CLI remain the proven local path. Phase 2 adds an isolated `GoogleFlowProvider`, generic browser-gateway operations, fake-based gateway/provider/queue tests, and an opt-in live smoke script. The Flow adapter currently implements one visible single-image workflow and reuses the existing queue, asset import, and deterministic QC. It is **not live-validated**: no authorized browser session was available, so real Flow selectors and behavior remain unverified. There is still no product UI/API.

Public research and implementation status are recorded in [FEATURE_MATRIX.md](./FEATURE_MATRIX.md). The staged plan is in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md), runnable Phase 1 details in [docs/vertical-slice.md](./docs/vertical-slice.md), Phase 2 details in [docs/google-flow-provider.md](./docs/google-flow-provider.md), browser mechanics in [docs/browser-gateway.md](./docs/browser-gateway.md), and trade-offs in [DECISIONS.md](./DECISIONS.md).

## 1. Current repository map

The pnpm workspace retains TypeScript/ESM, strict checking, and SQLite. It now contains the original browser foundations plus the Phase 1 packages and CLI.

```text
apps/
  cli/                        executable mock-backed vertical-slice command
  browser-gateway/            existing local CDP diagnostics and smoke scripts

packages/
  core/                       typed entities, statuses, and provider port
  storage/                    SQLite v3 migrations and transactional repositories
  queue/                      durable claim/lease/recovery worker
  assets/                     filesystem asset bytes and streaming SHA-256
  qc/                         deterministic file/MIME/image QC
  browser/                    Playwright/CDP gateway for a user-controlled session
  events/                     initial event vocabulary, not a durable outbox

providers/
  mock/                       deterministic, file-backed Phase 1 provider
  google-flow/                visible-UI single-image provider; live UI unverified
```

| Package | Current responsibility | Important limit |
| --- | --- | --- |
| `packages/core` | Project/scene/version/job/attempt/queue/asset/QC/review contracts; explicit provider capabilities; provider-neutral async methods; request context may be passed to lookup/status/download for safe reconciliation; job status transitions. | No creative-story graph, API schema layer, UI, or workflow-agent tools yet; no Flow/browser concepts. |
| `packages/storage` | SQLite WAL, foreign keys, busy timeout, versioned migrations, projects/scenes/immutable scene versions, canonical generation identity, queue items/leases, attempts, asset versions, QC, review, selection; retains character and legacy asset methods. | SQLite remains a local/single-worker store; no event log/outbox or distributed concurrency. |
| `packages/queue` | Atomic claim, lease heartbeat, expired-lease recovery, same-attempt provider lookup, retry classification, file import/QC, and transactional finalization/ack. | Current worker accepts one distinct output; no background daemon/service. |
| `packages/assets` | Safe local path construction, atomic file publication, integrity checking, streaming SHA-256, bytes outside SQLite. | No object-store backend or retention/garbage-collection service. |
| `packages/qc` | Deterministic existence, readability, MIME/signature, size, checksum, and supported image dimensions. | No semantic continuity QC, video/audio probe, or unsupported-format dimension guess. |
| `providers/mock` | `SUCCESS`, `TRANSIENT_FAILURE`, `PERMANENT_FAILURE`, `TIMEOUT`, and `DUPLICATE_RESULT`; request-key manifests and deterministic local image bytes. | Proves the orchestration contract only; it is not a generative model. |
| `providers/google-flow` | Provider-port implementation for one visible single-image path; central Flow semantic targets, manual session/auth status, durable non-secret recovery manifest, visible correlation, and browser download. | Fake-tested only. No live Flow behavior passed; video/references/settings/batch are unsupported. |
| `packages/browser`, `apps/browser-gateway` | Provider-neutral Playwright/CDP gateway with stable tab selection, observe/wait, click dispatch, guarded fill, hover, upload/download events, and redacted diagnostics; fake transport tests. | Fake transport tests do not validate real Chrome or Flow. Visible page text is sensitive application data and callers must not log it. |
| `packages/events` | Existing event type vocabulary. | No persisted event stream, transactionally written outbox, or dispatcher. |

## 2. Phase 1 domain and persistence

### Project graph

`Project` owns `Scene` identity. A `SceneVersion` is an immutable prompt/reference/metadata snapshot with an optional parent and version number. `scenes.current_version_id` is an explicit pointer, not an in-place edit. Repeating creation by stable version ID/content returns the existing snapshot without reselecting an older version.

A new `GenerationJob` pins the exact project, scene, and scene version, plus provider, request parameters, prompt, and references. Its canonical identity is SHA-256 of the stable request data. A SQLite unique index prevents duplicate logical jobs; job creation and its queue item are committed in the same transaction. Per-attempt keys append a stable attempt number to the logical key.

An accepted output is represented by `Asset` + immutable `AssetVersion`, linked to project/scene/scene version/job/attempt/provider and carrying storage path, MIME, size, checksum, output index, available dimensions, and metadata. `QCResult` refers to the asset version; `Review` refers to that same exact asset version. The scene's selected asset-version pointer is distinct from both generation and approval.

### SQLite migrations

`packages/storage/src/migrations.ts` owns forward-only `PRAGMA user_version` migrations through schema version 3. Fresh database creation, schema-v2 forward upgrade, and legacy-schema upgrade are tested. Existing project/scene/character/job/queue-entry/asset tables are retained. Legacy completed jobs are mapped to succeeded; ambiguous active work is marked failed with an explanation and is not auto-enqueued. Where the legacy scene exists, migration creates a scene-version snapshot for provenance.

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

## 6. Deferred work

- No API/web product surface, worker daemon, or production human-review interface.
- No live-validated Google Flow behavior: the single-image browser adapter is fake-tested, but real account eligibility, selectors, generation status, result correlation, and download remain untested. Authentication is manual; no provider credentials are stored.
- No multi-output persistence in one job, object storage, global deduplication, or retention/repair daemon.
- No creative brief/story/storyboard/Visual DNA graph, agents, audio, timeline, render/export, publishing, or analytics.
- No durable event/outbox system or distributed queue.
- No semantic/image similarity evaluator, video/audio codec probe, duration QC, or unsupported image-dimension guess.

These are future phases only when justified; they were not introduced as Phase 1 infrastructure.

## 7. Verification

The Phase 1 validation commands and exact outcomes are recorded in [docs/vertical-slice.md](./docs/vertical-slice.md). Fresh and legacy SQLite migrations were exercised with the real `better-sqlite3` native addon. TypeScript build/typecheck and deterministic tests passed as listed there. The local CLI was run twice to confirm that its repeated success run reuses the same job, asset version, and attempt. Browser/CDP runtime and any live Google Flow behavior remain untested and intentionally unused.
