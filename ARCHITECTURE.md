# FlowForge Architecture

- **Baseline audit:** 2026-10-04, commit `f8b7019c1b924bc4a25b6642c5e1dc18e63578ef`.
- **Current status:** Phase 1 durable mock-backed production slice implemented and locally validated (2026-10-04).
- **Boundary:** no live Google Flow generation, private API, authenticated browser session, or access-control mechanism was used or inspected for this phase.

## Executive summary

FlowForge is a provider-neutral creative-production system. The local project graph and persisted workflow metadata—not a provider's workspace—are canonical. Phase 1 now exercises a complete local path:

```text
Project → SceneVersion → idempotent Job → durable SQLite Queue
        → provider-neutral Worker → MockGenerationProvider
        → filesystem Asset → deterministic QC → Review → selected version
```

The core, SQLite migrations/repository, queue/worker, filesystem asset store, QC, mock provider, CLI, automated tests, root scripts, and Phase 1 documentation are implemented. The path is independent of browser automation. There is still no product UI/API, and `providers/google-flow` is not a live generation adapter.

Public research and its limitations are recorded in [FEATURE_MATRIX.md](./FEATURE_MATRIX.md). The staged plan is in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md), the runnable details in [docs/vertical-slice.md](./docs/vertical-slice.md), and trade-offs in [DECISIONS.md](./DECISIONS.md).

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
  google-flow/                isolated adapter shell; no Phase 1 generation
```

| Package | Current responsibility | Important limit |
| --- | --- | --- |
| `packages/core` | Project/scene/version/job/attempt/queue/asset/QC/review contracts; explicit provider capabilities; provider-neutral async methods; job status transitions. | No creative-story graph, API schema layer, UI, or workflow-agent tools yet. |
| `packages/storage` | SQLite WAL, foreign keys, busy timeout, versioned migrations, projects/scenes/immutable scene versions, canonical generation identity, queue items/leases, attempts, asset versions, QC, review, selection; retains character and legacy asset methods. | SQLite remains a local/single-worker store; no event log/outbox or distributed concurrency. |
| `packages/queue` | Atomic claim, lease heartbeat, expired-lease recovery, same-attempt provider lookup, retry classification, file import/QC, and transactional finalization/ack. | Current worker accepts one distinct output; no background daemon/service. |
| `packages/assets` | Safe local path construction, atomic file publication, integrity checking, streaming SHA-256, bytes outside SQLite. | No object-store backend or retention/garbage-collection service. |
| `packages/qc` | Deterministic existence, readability, MIME/signature, size, checksum, and supported image dimensions. | No semantic continuity QC, video/audio probe, or unsupported-format dimension guess. |
| `providers/mock` | `SUCCESS`, `TRANSIENT_FAILURE`, `PERMANENT_FAILURE`, `TIMEOUT`, and `DUPLICATE_RESULT`; request-key manifests and deterministic local image bytes. | Proves the orchestration contract only; it is not a generative model. |
| `providers/google-flow` | Isolated adapter shell and existing browser diagnostics; provider-port methods throw intentionally. | No submission, status monitoring, result download, or live worker use in Phase 1. Existing prompt/control diagnostics are not called by the mock worker. |
| `packages/browser`, `apps/browser-gateway` | Playwright/CDP operations against an explicitly user-controlled session. | Separate from the vertical slice; browser runtime was not tested here. |
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
2. Otherwise, ask `findGeneration(providerRequestKey)` first.
3. Only if lookup proves no provider generation exists does it call `createGeneration` with the same stable key.
4. Persist the provider job ID, query status, and—on success—download the result.
5. Import the artifact to a deterministic external-file path, validate it, then atomically write asset/version/QC/pending-review/attempt-success/job-success/queue-ack metadata.

A crash after remote acceptance but before SQLite records the provider ID is recovered by the provider lookup on the same request key. A crash after file publication but before DB finalization reuses the integrity-checked deterministic path. A crash after finalization cannot split job success from queue acknowledgement. A stale worker cannot renew or finalize a lease after recovery assigned a new claim.

Queue delivery is at-least-once, not a claim of exactly-once external effects. Safety after ambiguous submission depends on the provider implementing request-key lookup/idempotency. The MockProvider does. A future adapter unable to determine prior state is never supposed to submit a new attempt blindly; bounded same-attempt recovery ends as a visible terminal error that cannot be blindly retried.

### Status and retry model

The job lifecycle is deliberately small: `QUEUED → CLAIMED → RUNNING → SUCCEEDED|FAILED|CANCELLED`. Attempts separately record `CLAIMED`, `RUNNING`, `SUCCEEDED`, `FAILED`, or `CANCELLED`; their provider request/job IDs and recovery count remain persisted. Retryable provider failures schedule the queue item for a later time and create a new numbered attempt when claimed. Uncertain status/result recovery keeps the current attempt.

The initial policy is one local worker. There is no broker, Redis, Kafka, cloud queue, microservice, or distributed database.

## 4. Provider boundary and safety

`GenerationProvider` has a neutral capability record and operations for `findGeneration`, `createGeneration`, `getGenerationStatus`, `downloadResult`, and `cancelGeneration`. The `MockGenerationProvider` is file-backed so its request-key manifest/result survive repository and worker restarts. Provider errors distinguish retryability and uncertain submission.

`GoogleFlowAdapter` remains isolated and has conservative false capability declarations until behavior is validated. Its new provider-port generation methods throw intentionally; the Phase 1 queue never invokes the browser gateway. Existing prompt/control diagnostics from the baseline are not a submission/monitoring/download integration. No Google Flow prompt submission, provider selector work, result monitoring, or download was added for Phase 1.

Any later browser use remains limited to a user's authorized browser session and visible, legitimate UI workflows. No authentication/CAPTCHA bypass, cookie/token extraction, private API, hidden endpoint, or provider-restriction evasion is permitted. If state is ambiguous or blocked, surface it for user action rather than inventing certainty.

## 5. Asset, QC, review, and selection

The filesystem store writes bytes outside SQLite under a deterministic project/scene/job/output path. It uses temporary files and atomic hard-link creation rather than replacing conflicting bytes; existing paths are re-hashed before reuse. SQLite stores provenance/metadata and the SHA-256, not binary media.

QC version `deterministic-v1` validates regular-file existence, readability/non-empty bytes, detected-vs-expected MIME, byte count, SHA-256, and image dimensions. PNG chunks/CRC and decompressed pixel length are checked; dimensions are parsed for PNG, JPEG, GIF, WebP, and BMP. QC is intentionally not semantic: style, prompt adherence, continuity, codec, and duration have no fake pass. Unsupported image dimensions are `NOT_EVALUATED`; media QC is not selected unless all evaluated requirements pass. Current maximum QC input is 128 MiB.

A stored asset version receives `PENDING` review. A decision is explicitly `APPROVED` or `REJECTED` and terminal. Selection requires the exact asset version's approval and passing QC; selecting it updates the scene's current scene-version and selected asset-version pointers together. Neither generation nor review approval silently selects a version.

## 6. Deferred work

- No API/web product surface, worker daemon, or production human-review interface.
- No live Google Flow integration, authenticated browser generation, browser download, account-state handling, or provider credentials.
- No multi-output persistence in one job, object storage, global deduplication, or retention/repair daemon.
- No creative brief/story/storyboard/Visual DNA graph, agents, audio, timeline, render/export, publishing, or analytics.
- No durable event/outbox system or distributed queue.
- No semantic/image similarity evaluator, video/audio codec probe, duration QC, or unsupported image-dimension guess.

These are future phases only when justified; they were not introduced as Phase 1 infrastructure.

## 7. Verification

The Phase 1 validation commands and exact outcomes are recorded in [docs/vertical-slice.md](./docs/vertical-slice.md). Fresh and legacy SQLite migrations were exercised with the real `better-sqlite3` native addon. TypeScript build/typecheck and deterministic tests passed as listed there. The local CLI was run twice to confirm that its repeated success run reuses the same job, asset version, and attempt. Browser/CDP runtime and any live Google Flow behavior remain untested and intentionally unused.
