# Phase 1 durable mock-backed vertical slice

**Status:** implemented and locally validated on 2026-10-04. This document describes the Phase 1 contract and its intentional limits; it does not describe a live Google Flow integration.

## What the slice proves

```text
Project
  → Scene + immutable SceneVersion
  → stable logical GenerationJob + queue item
  → persisted claim/lease + GenerationAttempt
  → provider lookup / deterministic MockProvider
  → filesystem bytes + asset provenance
  → deterministic QC evidence
  → exact-asset-version review
  → explicit approval and selected version
```

The project graph and workflow metadata live in SQLite. Artifact bytes live in the configured filesystem asset root. The `MockGenerationProvider` writes deterministic files and request-key manifests locally; it does not contact a generation service or claim that a model generated the fixture.

## Run it

At the workspace root:

```sh
corepack pnpm install
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
corepack pnpm vertical-slice
```

The root vertical-slice script builds the CLI and its workspace dependencies, then runs the default success flow. It writes to `.flowforge/vertical-slice/` (ignored by Git):

```text
.flowforge/vertical-slice/
├── flowforge.sqlite
├── assets/projects/<project>/scenes/<scene>/generations/<job>/output-0.png
└── mock-provider/
    ├── records/<request-key-hash>.json
    └── results/<provider-job-id>/output.png
```

The CLI prints project/scene/version/job/attempt IDs, job and queue status, asset path/size/SHA-256, QC and review statuses, and the explicitly selected asset version. Its default `--review approve` is a demonstration operator action, not a production review UI.

Run a separate mode/database after building:

```sh
corepack pnpm --filter @flowforge/cli build
node apps/cli/dist/index.js --data-dir /tmp/flowforge-demo --mode DUPLICATE_RESULT --review approve
node apps/cli/dist/index.js --data-dir /tmp/flowforge-qc-failure --artifact INVALID_PNG --review approve
```

Supported mock modes:

| Mode | Deterministic behavior |
| --- | --- |
| `SUCCESS` | Persist a valid 2×2 PNG fixture and report success. |
| `TRANSIENT_FAILURE` | Fail the first provider submission as explicitly not accepted; the worker records attempt 1 and retries using attempt 2's stable request key. |
| `PERMANENT_FAILURE` | Fail submission as non-retryable; persist a failed job/attempt and terminal queue state. |
| `TIMEOUT` | Persist a `RUNNING` provider manifest indefinitely. The worker retains the same attempt through bounded recovery and does not create a new provider request. |
| `DUPLICATE_RESULT` | Return two copies with the same output index and bytes; the worker collapses them to one stored/accepted asset version. |

`--artifact INVALID_PNG` provides a non-empty but invalid PNG payload. The file can still be stored, but deterministic QC records the MIME/readability failure and version selection is blocked. `--review reject` records an explicit rejection and intentionally leaves the version unselected.

## Persistence and idempotency

SQLite `user_version` is schema version 3. Forward migration 3 adds late asset-current-version and approved-plus-QC-passed selection guards for already-version-2 databases; the upgrade is tested. Migrations preserve the existing projects, scenes, characters, jobs, queue entries, and assets. Legacy completed work is mapped to succeeded; ambiguous legacy active/failed work is made visible as failed and is not silently replayed. Legacy jobs are linked to a generated scene-version snapshot when their scene exists.

New scene versions are immutable and can be created with stable IDs safely. The scene's `current_version_id` is a separate pointer. Repeating a version creation with the same ID/content returns the original version and does not reset a later current selection.

A logical job identity is canonical JSON over project ID, scene ID/version, provider, prompt/references, and generation parameters. Its SHA-256 idempotency key has a SQLite uniqueness constraint. A repeated logical request returns the existing job and queue item instead of inserting more work. Job metadata that does not affect the rendered request is not part of this identity.

Each attempt has its own stable provider request key (`logical-idempotency-key:attempt:N`) and durable history. An explicitly retryable provider rejection may create a later attempt. An uncertain submission/result is retried only as recovery of the same attempt. When bounded recovery is exhausted, the error remains visible and the same failed job cannot be blindly resubmitted; create a new scene version after review if a new logical generation is intended.

## Queue and crash recovery

`queue_items` persist status, priority, availability, claim time, lease deadline, worker ID, claim count, acknowledgement, and last error. Job creation and queue insertion share one SQLite transaction. A worker claims in an immediate transaction, persists an attempt before external work, renews its lease while awaiting the provider, and finalizes asset metadata/QC/review/job/attempt/queue acknowledgement in one database transaction.

Recovery behavior:

1. **Crash before provider submission:** an expired lease is returned to the queue; the same active attempt is resumed.
2. **Provider accepted or succeeded, but SQLite has no provider job ID yet:** the worker calls `findGeneration` with the same provider request key before creating anything. The mock's durable manifest returns the existing provider generation.
3. **Provider ID persisted, but no local asset/finalization:** the worker looks up status and downloads the same provider result.
4. **Asset bytes copied, but SQLite finalization did not commit:** the deterministic path is integrity-checked and reused; QC is rerun and database finalization is retried.
5. **Database finalization committed:** the job is succeeded and queue item acknowledged atomically, so a restart cannot accept a second asset for that attempt/output.

Expired claims are fenced: an old worker cannot renew, persist a provider ID, or complete once another claim owns the lease. Recovery is at-least-once at the queue boundary; safe external deduplication requires a provider to honor or look up the supplied request key. A future provider that cannot determine its prior submission must not blindly resubmit.

## Asset and QC records

Asset metadata records stable asset and asset-version IDs; project, scene, scene-version, job, attempt, provider, and provider-job provenance; stored path; MIME type; byte count; SHA-256; output index; available dimensions; and provider metadata. Files are copied to a stable path using a temporary file and atomic hard-link creation, then rechecked. Bytes are not stored in SQLite.

QC version `deterministic-v1` checks regular-file existence, non-empty/readable bytes, MIME/signature, exact byte count, SHA-256, and image dimensions. PNG structure/CRC/pixel-data decompression is validated; dimensions are parsed for PNG, JPEG, GIF, WebP, and BMP. Image formats outside that set remain `NOT_EVALUATED` for dimensions; unimplemented semantic, style, and continuity checks are not claimed. The current QC file-size limit is 128 MiB. Video/audio container probing, duration, codec, and semantic checks are outside Phase 1.

QC evidence is immutable and versioned by validator. A failed QC result does not masquerade as provider failure: the generation/asset can be persisted with `QC FAILED`, but it cannot be selected.

## Review and explicit version selection

Each stored asset version gets its own `PENDING` review. A decision is `APPROVED` or `REJECTED` and cannot be silently rewritten. Selection checks that the asset belongs to the requested scene, the review is approved, and the deterministic QC result passed. The scene's current version and selected asset-version pointers are updated together. Merely generating or approving an asset does not implicitly select it.

## Test and validation coverage

Automated tests include:

- Fresh SQLite migration and versioned/idempotent job creation.
- Upgrade from the legacy schema with completed and ambiguous active jobs.
- Immutable scene-version storage and current-pointer behavior.
- Persisted lease recovery, same-attempt resume, and stale-worker fencing.
- Provider success before local provider-ID persistence, recovered after repository/process restart without a second provider generation or asset.
- Duplicate logical request and duplicate provider outputs.
- Transient retry with per-attempt history; permanent failure; bounded timeout recovery.
- Valid image-dimension parsing for PNG, JPEG, GIF, WebP, and BMP; QC failures for missing files, bad MIME/signature, invalid image payload, and checksum mismatch.
- Exact review persistence and selection blocked when QC fails.

### Executed validation in this checkout

- `corepack pnpm build` — passed across the workspace.
- `corepack pnpm typecheck` — passed across the workspace (the root script builds workspace dependencies before typechecking).
- `corepack pnpm test` — passed: 15 tests total (`packages/storage` 4, `packages/queue` 7, `packages/qc` 4). Fresh, schema-v2 forward-upgrade, and legacy SQLite migration tests ran against the actual `better-sqlite3` native addon; no DB checks were skipped.
- `corepack pnpm vertical-slice` — passed on a fresh ignored data directory; job `SUCCEEDED`, queue `ACKED`, QC `PASSED`, review `APPROVED`, and a selected asset version was printed.
- `corepack pnpm --filter @flowforge/cli vertical-slice` — passed again against the same data directory and reused the exact job, attempt, and asset version (`workerRuns: 0`).
- The sandbox could not verify/download the prebuilt SQLite binary certificate. The addon was compiled successfully against its local Node headers with `cd packages/storage && npm_config_nodedir=/usr/local corepack pnpm rebuild --pending --reporter=append-only` before the SQLite tests.

These checks validate the local SQLite/filesystem/mock path only. Browser/CDP runtime, any authenticated session, and live Google Flow behavior were not exercised and are intentionally outside Phase 1.

## Intentional limits

- No product UI/API, live Google Flow submission, browser monitoring, browser download, selector work, CAPTCHA handling, or provider credential support was added for this phase.
- The existing Google Flow adapter remains an isolated shell; its provider-port generation methods explicitly throw, and the Phase 1 worker uses only `MockGenerationProvider`.
- The worker accepts one distinct output per generation. Duplicate identical copies are collapsed; multiple distinct outputs fail visibly.
- Deterministic image dimension support is limited as listed above. There is no semantic/continuity evaluator or production human-review interface.
- This is local SQLite/filesystem storage with a single-worker execution policy, not a distributed queue or object store.

## Phase 3 operator commands

This document stays the engine-level contract for the flag-only invocation (`flowforge --data-dir … --review approve`), which is unchanged. The same durable path is now also operable command by command through the application services — `project create`, `scene create`, `scene version add`, `generate`, `queue status|run|recover`, `review list|approve|reject|select`, `production scene|ready|project` — with `--json` read models and exit codes documented in [docs/application-services.md](./application-services.md).
