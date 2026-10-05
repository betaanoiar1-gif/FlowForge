# FlowForge Implementation Plan

- **Current stage:** Phases 1–3 are implemented and tested; Phase 4A (creative planning domain) is implemented and tested (2026-10-04), covering durable briefs, versioned production plans, deterministic validation, and capability-gated executability with an execution preview. Live Flow validation is still **BLOCKED / NOT RUN** without an authorized CDP session.
- **Next validation milestone:** two independent ones. (1) Run the separate opt-in live smoke on a user-authorized, manually authenticated Flow session, then drive that session through the operator commands (`generate --provider google-flow` → `queue run`); stop if UI correlation is ambiguous. (2) Phase 4B — author plans deterministically through the 4A contracts and prove the plan → scene/version/job mapping end to end with the mock provider; only then Phase 4C adds an optional AI adapter.
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

## Phase 3 — Application services and operator surface

`packages/services` sits between the durable engine and the operator and covers the chain `Project → Scene → Generation Request → Generation Job → Durable Queue → Provider → Asset → QC → Review → Version Selection → Production-ready Scene`. Phase 0/1/2 systems are reused, not replaced: no second queue, retry engine, storage layer, QC implementation, provider selector, or browser automation exists in this layer.

### Phase 3 acceptance criteria

1. **Narrow application layer:** services own validation, orchestration, and read models only. Every write goes through the existing repository method that already owns the transition (job creation and enqueue stay one transaction), and execution goes through `LocalQueueWorker`. No browser, CDP, selector, retry-algorithm, or asset-byte code appears in the layer.
2. **Idempotent requests:** `GenerationService.requestGeneration` validates scope and provider capabilities, then creates or reuses the durable job and reports `created`/`reusedExistingJob`. A repeated command never double-enqueues; prompts stay on immutable scene versions rather than on the request.
3. **Capability admission:** a request is refused before it is queued when the selected provider's declared capabilities cannot satisfy it (video, batch, frames, references). Providers not registered in this process are refused unless the operator explicitly opts into `allowUnconfiguredProvider`.
4. **State transitions:** job transitions stay owned by core's `JOB_TRANSITIONS`. Scene status transitions use the new `SCENE_STATUS_TRANSITIONS` table, are enforced again in storage, and `READY` is reachable only through the readiness gate. Project archival is guarded by `PROJECT_STATUS_TRANSITIONS` and refuses while work is open. No new table or migration was added.
5. **Derived production readiness:** readiness is computed from persisted evidence on every call (current version, succeeded output, no open generation, explicit selection, passing QC, explicit approval) and reported as blocking codes, so there is no stored flag that can drift from its justification.
6. **Persistence/recovery respected:** leases, same-attempt recovery, `UNCERTAIN_PROVIDER_STATE` no-auto-retry, and the recovery manifest remain Phase 1/2 behaviour; the service layer only drives and reports them. Retry is offered only when the durable evidence permits it.
7. **Operator surface and read models:** `apps/cli` exposes project/scene/version/generate/status/queue/cancel/retry/review/select/production/provider commands. Human and `--json` output are projections of the same read models, and errors carry stable codes with exit codes `0/1/2/3`.
8. **Safety and scope:** authentication stays manual; the CLI attaches to the operator's browser session only when execution with `--provider google-flow` is requested, redacts the endpoint in messages, and never logs page content or secrets. No web UI, HTTP API, daemon, planner, agent, publishing, analytics, or video pipeline was introduced. (Phase 4C later added an AI planning *adapter* behind its own port; it reads a credential variable only for that verb, sends it in one header, and reaches no browser, queue, or execution path.)

**Gate:** build, typecheck, `corepack pnpm test` (75 tests, deterministic, no browser or Google account), and `corepack pnpm vertical-slice` all pass. Live Google Flow execution through the new commands is **NOT RUN**: it requires the user's authorized session.

## Phase 4A — Creative planning domain

Phase 4A adds the **domain foundation** for creative intelligence — the structures, lifecycle, and gates that a planner (4B) or an AI adapter (4C) will later fill in. It is explicitly **not** an AI planner: no language model, no agent, no autonomous decision, and no provider call appears anywhere in the planning path. Design, table list, finding catalogue, CLI reference, and the verified walkthrough are in [docs/planning-domain.md](./docs/planning-domain.md).

### Phase 4A acceptance criteria

1. **Layering respected:** `Creative Intent → Creative Brief → Production Plan → Story/Concept → Characters → Worlds → Visual DNA → Scene Plans → Generation Specifications` sits *above* the Phase 3 services. Planning never touches `generation_jobs` or `queue_items`; a scene plan is not a `Scene`, and creating one creates no work (asserted by an empty queue and empty job list after a full lifecycle).
2. **Extend, do not compete:** planning types live in `packages/core/src/planning.ts` beside the existing contracts; characters are the same stable `characters` rows with additive trait columns; capability requirements reuse `keyof ProviderCapabilities`, so no second `supportsX` system exists.
3. **Explicit lifecycle with impossible invalid edges:** `DRAFT → VALIDATED → APPROVED → EXECUTABLE → ARCHIVED` on the *plan version*, enforced by a core transition table, compare-and-set storage writes, and v4 database triggers. Approved content is never edited in place: `revise` copies it into a new version, `reopen` only undoes a not-yet-approved validation.
4. **Versioning is mandatory:** `planId + versionNumber` with uniqueness, `predecessor_version_id` lineage, stable `sceneKey` identity across versions, immutable brief/world/DNA snapshots pinned by ID, and a content hash that makes stale evidence impossible to approve. No destructive migration; v1–v3 data is untouched.
5. **Deterministic structural validation:** a pure validator detects the enumerated failures — ownership, empty required fields, duplicate scene keys/orders, unknown character/world/DNA references, missing DNA, specs without a valid scene plan, invalid spec values, unknown or contradicted capability requirements, dangling references, empty executable plans — and returns structured findings with severities, sorted deterministically. Warnings never block.
6. **Capability gate, never execution:** validation and approval construct no provider; `markExecutable` checks every spec against explicitly named configured providers and fails with `PLAN_CAPABILITY_UNMET` plus per-spec coverage rows. A read-only `plan preview` shows the exact Phase 3 commands a later phase would submit.
7. **Persistence decision documented:** normalized relational tables (11 new tables, 38 triggers) with foreign keys, project/plan/version indexes, per-child idempotency keys, and lifecycle/immutability triggers — not opaque JSON blobs — with rationale recorded in the design note.
8. **Services own orchestration; no wrappers:** five planning services validate commands, hold the invariants, and compose read models; the repository owns SQL. `createApplication` takes an optional `planning` port, so Phase 3 callers are unaffected and misuse fails with `PLANNING_NOT_CONFIGURED`.
9. **Minimal CLI extension:** 30 commands over the existing command table (`plan …`, `brief …`, `definition …`) using the same parser, flags, read models, exit codes, and typed errors; the CLI bypasses no service and exposes no execution command.
10. **No infrastructure creep:** no event bus (`packages/events` stays unused), no new queue, no second retry system, no background daemon, no web UI, no Redis/Kafka, no external APIs, no publishing/analytics, no video pipeline, and no provider implementation change.

**Gate:** build 11/11 packages, typecheck 11/11, `corepack pnpm -r test` 115/115 (Phase 3's 75 tests unchanged and still passing, plus 40 planning tests), and `corepack pnpm vertical-slice` reproducing the identical selected asset version. The manual planning walkthrough — project → brief → plan v1 → story → characters → world → Visual DNA → scene plans → generation specs → validate → approve → inspect → preview → revise — runs deterministically with the mock provider and leaves the queue empty. Nothing in this phase talks to Google Flow, and no database operation drops, deletes, or recreates state.

## Phase 4B — Deterministic planner engine

Phase 4B fills the structure 4A created with a **deterministic authoring engine**: `runPlanner(PlannerInput) → PlannerRun` turns a brief plus explicit planning input into a complete, validated `ProductionPlan` draft, and `PlannerService` authors it through the 4A service methods only. It is explicitly **not** an AI planner: no language model, no agent, no provider call, no browser, no queue submission, and no publishing anywhere in the path. The specification — contracts, the 12-rule registry, canonical normalization and fingerprints, identity derivation, replan policies, provenance, and the test map — is [docs/planner-engine.md](./docs/planner-engine.md).

### Phase 4B acceptance criteria

1. **Pure and reproducible:** the engine reads only its input — no database, no clock, no randomness, no I/O, no provider instance, no network. A source-scan test fails the build if `packages/services/src/planner/` imports any of them. Byte-identical normalized input, `plannerVersion`, `rulesVersion`, and `seed` produce byte-identical scene order, keys, ids, cast/world/DNA bindings, durations, instructions, capability requirements, and both fingerprints.
2. **Explicit input, explicit result:** `PlannerInput` (`projectId`, `brief`, `story`, characters/worlds/DNA, `cast`, `planningOptions`, `providerCandidates`, `plannerConfig`) is assembled by the service; the engine queries nothing. `PlannerRun` distinguishes `SUCCESS`, `VALIDATION_FAILURE`, and `PLANNING_FAILURE`, and a run that cannot finish reports a failure rather than a shorter plan.
3. **Named, versioned, testable rules:** 12 frozen rules in a single ordered registry (`brief-foundation` … `plan-integrity`), each recording a trace step with the fields it read. `flowforge planner rules` prints that registry, so the documented algorithm and the executed one are the same list; it is a rule system, not a generic "AI-like" planner.
4. **Documented canonical normalization:** trim and whitespace collapse, empty-string-as-absent, identifier trimming, order preserved where it carries meaning and sorted/deduplicated where it does not, whole-millisecond durations, defaults applied before hashing, capability vocabulary validated, and unread fields dropped. Prose is never rewritten, folded, or summarised. Fingerprints exclude write-only options (`replan`, `includeTrace`) and `asOf`; `seed` is content and stays in.
5. **Planner version is not the validator version:** `deterministic-planner-v1` is recorded per version alongside `planning-rules-v1` and the Phase 4A validator's own version, so a future planner release cannot silently reinterpret an existing plan.
6. **Deterministic identity:** plan identity derives from `(projectId, briefId, title)`, and every id inside a run from the input fingerprint plus the rule's path, formatted as a UUID-shaped derived value. Authoring scopes row ids by version, and `scenePlan` references are re-pointed rather than rewritten. No UUID, timestamp, or hash ever decides ordering.
7. **One write path, one idempotency system:** the service authors with the existing 4A methods (`createPlanVersion`, `setStory`, `setCast`, `addScenePlan`, `addGenerationSpec`, `validate`, `approve`, `markExecutable`), so planner rows obey the same hashing, lifecycle, and trigger rules as hand-authored ones. An identical re-run performs **zero writes** (`reused: true`); `replan: "new-version"` forks, `"fail"` refuses with `IDEMPOTENCY_CONFLICT`, `"in-place"` is legal only on an editable, unprovenanced version, because provenance is write-once.
8. **Provenance is additive and immutable:** migration v5 adds seven nullable columns to `production_plan_versions`, outside the content hash, enforced by triggers to arrive as a complete set and never be rewritten; `revise()` deliberately does not copy them. A plan without provenance reads as "authored by hand", never as an error. A run whose stored rows fail validation after a clean draft is downgraded to `VALIDATION_FAILURE` with `PLANNER_PERSISTED_VALIDATION_MISMATCH` and left an editable draft.
9. **Stops at the plan:** `mapPlanToJobs` converts an approved snapshot into typed Phase 3 command intents with deterministic scene and `jobKey` identity, blockers, and skipped reasons — and is proven only by deterministic tests. No `planner execute` command exists, nothing is submitted, and `plan preview` remains the read-only operator view.
10. **Reused contracts only:** no competing `ProductionPlan`/`ScenePlan`/`GenerationSpec`/capability/lifecycle/validation type, no second retry or event system, no provider change, no UI, no web UI, no new infrastructure. Existing error-code spaces are reused.

**Gate:** build and typecheck clean across the workspace, `corepack pnpm test` **165/165** across 8 test suites
(the 115 tests from Phases 0–4A unchanged, plus 15 engine, 15 service, 7 storage-provenance, 6 canonical-JSON,
and 7 CLI tests), and `corepack pnpm vertical-slice` passing, with a repeat
run on the same data directory reusing the same job, asset version, and attempt. Planning is exercised end to
end from the CLI against the mock provider, writes no job and no queue entry, and
nothing in this phase talks to Google Flow; no live-flow test was run.

## Phase 4C — AI planner adapter

Phase 4C puts an optional model in *front of* the Phase 4B engine and nothing behind it: an adapter behind the
provider-neutral `AIPlanner` port turns the project's brief and definitions into a schema-validated
`PlanningProposal`, which is normalized into `PlannerInput` and handed to `PlannerService`. **AI proposes.
The deterministic planner normalizes. Phase 4A validates. Lifecycle services decide state. Execution is still
outside this phase.** The port, proposal schema, provenance, security rules, and test map are
[docs/ai-planning.md](./docs/ai-planning.md).

### Phase 4C acceptance criteria

1. **One engine:** no second planner, no bespoke `ProductionPlan` builder. The pipeline is
   `brief → AIPlanner.propose() → proposal → schema validation → PlannerInput → 4B rules → 4A validation →
   version`, and `PlannerService` stays the only author of plan rows.
2. **Provider-neutral port:** `AIPlanner`, the request/response types, `PlanningProposal`, and the error
   vocabulary live in `packages/core/src/ai-planning.ts` and name no vendor; the OpenAI-compatible
   implementation lives in `providers/openai-chat`. A domain file naming a vendor would be a design error.
3. **Structured output is mandatory:** a response must be a document of `ai-planning-proposal-v1` — unknown
   fields, prose, wrong version, out-of-bounds text, fractional or out-of-range durations, over-capacity scene
   lists, and duplicate keys are typed, path-pointing failures. There is no partial-acceptance path.
4. **The domain wins on every conflict:** unknown or ambiguous character/world/DNA names, invented brief
   constraints, and capabilities the providers do not declare fail closed with nothing written. The adapter may
   not write planning tables, mint ids, choose a capability, or set a lifecycle status.
5. **Determinism boundary respected:** the 12 rules, their order, and their fingerprints are unchanged; AI
   metadata lives outside `content_hash` and outside `plannerInputFingerprint`/`outputFingerprint`, so an
   adapter's identity cannot alter a plan and an equivalent proposal cannot look like an edit. Provider
   temperature is adapter configuration; the planner's `seed` stays the planner's.
6. **Provenance, not determinism theatre:** each authored version records adapter, adapter version, provider,
   model, schema version, path, fallback, and the request/proposal/response digests in additive v6 columns, with
   the same complete-set and write-once triggers as v5. Trace stages reuse the Phase 4B concept
   (`AI_REQUEST`, `AI_RESPONSE`, `AI_SCHEMA_VALIDATION`, `NORMALIZATION`, `DETERMINISTIC_PLANNING`,
   `DOMAIN_VALIDATION`) in the version's single trace, and `includeTrace` governs them as it governs the rule
   steps.
7. **No secrets, ever:** credentials are read from an environment variable by name at call time, sent in one
   request header, and never stored on an instance, persisted, or printed; every message that can reach storage
   or stdout is redacted, response bodies are byte-capped, and prompts/responses are digested rather than kept.
8. **Idempotency separated by identity:** AI-invocation identity (the response digest) is distinct from
   normalized planning identity (the planner's fingerprints). Equivalent normalized proposals reuse Phase 4B's
   zero-write path; differing ones fork distinguishable versions. A reuse records no new provenance and says so.
9. **Dry run and explicit fallback:** `--dry-run` may call the model and reports everything while committing no
   version, job, queue entry, or execution state, and is not presented as a promise about a later call;
   `--fallback=deterministic` is the only way a failed adapter still yields a plan, and it records the refusal.
10. **Minimal surface, no execution:** one command, `planner ai-run`, with typed exit codes; no `planner
    execute`, no `planner ai-execute`, no `--execute` flag, no submission, no queue work, no Google Flow or
    browser call, no asset download, no rendering, no publishing, and no live-model dependency in build,
    typecheck, test, or the vertical slice.

**Gate:** build and typecheck clean across the workspace, `corepack pnpm test` **207/207** across 9 test suites (the 165 tests from
Phases 0–4B unchanged and still passing, plus 3 storage v6-provenance, 18 services AI-planning, 14 adapter-contract,
and 7 CLI tests), and `corepack pnpm vertical-slice` passing unchanged. Every test runs without a credential, a
browser, or a network beyond localhost. Live Google Flow behavior remains **BLOCKED / NOT RUN**; the live model
smoke is documented and optional, never a gate.

## Phase 5 — Plan → executable work → durable execution

Phase 5 closes the gap the 4B and 4C follow-on rows named: an `EXECUTABLE` plan version becomes durable execution
work. It is **one service and one transaction, on top of the engine that already exists** — `PlanExecutionService`
maps the version to units through Phase 4B's `mapPlanToJobs`, writes the whole graph (or nothing) inside one
`BEGIN IMMEDIATE` unit, and hands the work to the existing queue, worker, provider registry, MockProvider, QC, and
review path. There is no second execution engine, no new queue, no new worker, no new retry policy, and no new
plan-version status. `docs/plan-execution.md` is the contract: the readiness gate and every blocker code, the
execution fingerprint and what it excludes, the scene boundary, the idempotency and recovery rules, the v7 schema,
and the test map.

### Phase 5 acceptance criteria

1. **Explicit path only.** `ProductionPlanVersion → readiness check → mapPlanToJobs → materialization`. No hidden
   flag bypasses the lifecycle: a version that is not `EXECUTABLE` cannot be materialized, and `plan preview`,
   `plan status`, `planner run`, and `planner ai-run` still create no scenes, jobs, or queue entries.
2. **The gate writes nothing.** Plan existence, project ownership, version-not-archived, `EXECUTABLE`, current
   validation evidence on the same content hash, provenance intact if present, capability support, and per-scene
   soundness (unique order, spec present, valid references, valid duration, satisfiable capabilities) are all
   assessed before the first write. Any failure is `EXECUTION_NOT_READY` — or `EXECUTION_CAPABILITY_UNAVAILABLE`
   when the block is capability-attributable — with the full ordered blocker list in details and zero graph rows.
3. **One transaction.** The materialization is atomic: an injected failure partway through leaves no scene, no
   scene version, no job, no queue item, and no execution row, and the next call is a clean run rather than a
   repair.
4. **Idempotent by identity, not by luck.** `materialize` twice returns the same `executionId`, the same
   fingerprint, the same scene versions and jobs, and one queue item per unit. Reuse is *matched* (prompt,
   references, link, provider, stable parameters) and a fingerprint that describes different work is refused.
   `plan_executions` is immutable: counts are the creating call's, and a reuse does not restamp or amend them.
5. **Fingerprint over canonical inputs only.** Project, plan version, scene plan, spec, capability requirements,
   rules version, normalized provider selection. Timestamps, random ids, leases, worker runs, attempt counts,
   retry budgets, and transient provider responses are excluded, so a retry never looks like new work.
6. **Scene boundary respected.** A `ScenePlan` never becomes a `Scene` implicitly; the explicit step happens only
   at materialization, and every scene version records the complete four-column link (execution, plan version,
   scene plan, generation spec) enforced by a trigger. Scene versions stay immutable, and a later plan version
   produces new rows without rewriting the first run's history.
7. **One job per execution identity, through the existing service.** `GenerationService`/repository remain the
   only writers of `GenerationJob` rows and queue items; `planExecutionId` is additive provenance kept outside the
   job's idempotency identity, recorded once and never amended (write-once both directions). No secret,
   credential, endpoint, or prompt body is stored on any execution row.
8. **Smallest dependency contract.** Execution order is the plan's own scene order: priority descends by unit
   index and each unit depends only on the scene plan before it. No graph is built that the plan did not declare.
9. **Queue and worker untouched.** Durable persistence, leases, visibility timeout, ACK, recovery, retry
   classification, and idempotency are the Phase 1 machinery, unmodified: a claim never deletes work, an expired
   lease resumes the *same* attempt, retries add attempts to the same job, and an ambiguous external execution
   stays `FAIL_CLOSED` instead of producing a second job.
10. **Capabilities gate before enqueue.** Selection goes through `ProviderRegistry` and the spec's declared
    capabilities, re-checked at materialization because registrations drift. A provider that cannot serve a spec
    yields `EXECUTION_CAPABILITY_UNAVAILABLE` with no burned queue item, no retry loop, and no silent or
    autonomous fallback. MockProvider is the Phase 5 provider.
11. **Assets, QC, and review stay Phase 3.** Artifact identity and idempotency unchanged; no new asset storage;
    deterministic QC unchanged (including its intentional submit-time and attempt-end passes); a QC failure uses
    existing status/retry semantics; `ReviewService` stays the only `PASSED → APPROVED` and selection path, so a
    materialization report ends with an operator command rather than a claim of approval.
12. **Thin surface, honestly narrowed.** Three read/write verbs — `plan execute` (with `--dry-run`),
    `plan execution`, `plan executions` — delegating to the service, and nothing else. The 4B/4C test that asserted
    `plan execute` did not exist is narrowed rather than deleted: planning and planner commands still execute
    nothing, `plan preview` still creates nothing, and the surviving half of that invariant is asserted in the
    same test.

**Gate:** build and typecheck clean across the workspace; `corepack pnpm -r --if-present test` **245/245** across 9
suites — core 13, browser 10, qc 4, openai-chat 14, google-flow 22, storage 39 (30 + 9 new), services 101 (82 + 19
new, the A–J matrix), cli 35 (25 + 8 verb tests + 2 vertical-slice tests) — with every earlier test still passing
unchanged except the two narrowing edits described in criterion 12; and `corepack pnpm vertical-slice` passing
unchanged. No test needs a credential, a browser, or a network beyond localhost. **Live Google Flow remains
BLOCKED / NOT RUN**, and Phase 5 adds no path that could reach it.

## Phase 6 — Real provider execution boundary (hardened)

- **Objective:** Make `GenerationJob → provider registry → GoogleFlowProvider → BrowserGateway → Google Flow` a production-safe path without modifying the general execution engine, and prove every safety property through automated tests that use a fake browser.
- **Scope delivered:** the distinguishable state and error taxonomy (loading page versus missing editor, prompt input, or Generate control; submission-failed versus submission-unknown; invalid artifact); mandatory pre-click prompt verification with same-session and single-occurrence requirements; one Generate submission per attempt enforced by the persisted recovery record rather than by in-memory state; fail-closed correlation with no "latest media" fallback; artifact describability before handoff to the existing asset/QC/review path; a per-stage recovery classification (`retryable` versus `submissionUnknown`) reused from the existing queue semantics; a read-only `attemptState()` recovery-phase view; and the `GOOGLE_FLOW_NOT_CONFIGURED` versus `PROVIDER_SESSION_UNAVAILABLE` distinction at the composition root.
- **Explicitly not delivered:** any live Google Flow execution, any real session, credential handling, or artifact download; any new Google-specific plan/job type, queue, worker, retry engine, or asset store; any change to `packages/core`, `queue`, `assets`, `qc`, `events`, `browser`, or `apps/browser-gateway`; any new capability beyond the single-image path; and any autonomous multi-unit run.
- **Test evidence:** 50 new deterministic tests in `providers/google-flow` (72 total in that package) driving a scripted fake `BrowserGateway` whose `generateClicks`/`downloadCalls`/`pollCalls` counters are the assertions, plus 5 `apps/cli` tests for the composition root; the 22 Phase 2 tests and every Phase 3/4A/4B/4C/5 test are unchanged and still pass. `build`, `typecheck`, `test` (300/300), and both vertical slices pass on this checkout.
- **Acceptance criteria:** see [docs/google-flow-provider.md](./docs/google-flow-provider.md) for the state/classification tables; the boundary is considered proven only for the fake-gateway path until the manual single-generation check on an authorized session is performed.

## Remaining milestones

| Phase | Scope | Exit gate |
| --- | --- | --- |
| **0 — Audit** | Inspect the checkout; document current system, public feature research, gaps, decisions, and the first slice. | **Complete.** See [ARCHITECTURE.md](./ARCHITECTURE.md), [FEATURE_MATRIX.md](./FEATURE_MATRIX.md), and [DECISIONS.md](./DECISIONS.md). |
| **1 — Durable mock-backed vertical slice** | Project/scene versions, stable logical idempotency, schema migrations, durable queue/leases/attempts, MockProvider, asset store, deterministic QC, review/selection, CLI and tests. | **Complete.** Validation commands and constraints are recorded below and in [docs/vertical-slice.md](./docs/vertical-slice.md). |
| **2 — Google Flow browser provider** | Visible-UI single-image provider behind the existing provider port, gateway hardening, durable same-attempt recovery, safe correlation/download, typed errors, and fake tests. | **Code complete and fake-tested**; hardened further by [Phase 6](#phase-6--real-provider-execution-boundary-hardened) above, which added the state taxonomy, pre-click prompt verification, single-submission enforcement, artifact describability, and per-stage recovery classification — still with no engine change and no live call. Live gate remains **BLOCKED / NOT RUN** until a manual single generation runs on a user-authorized session. |
| **3 — Application services and operator UX** | Narrow use-case services (`packages/services`) over the proven repository boundaries plus an operator CLI for project/scene/generation/queue/review/production commands and read models. | **Complete.** Commands use persisted IDs and cannot mutate storage directly; review/selection stay explicit; readiness is derived; no UI/HTTP API/daemon. See [docs/application-services.md](./docs/application-services.md). |
| **4A — Creative planning domain** | Structured brief, versioned production plan, story, character/world profiles, Visual DNA, scene plans, generation specifications, deterministic validation, capability gating, execution preview, persistence, CLI, and operator read models. **No planner and no AI adapter.** | **Complete.** Build/typecheck/test/vertical-slice pass (115 tests); the lifecycle walkthrough is deterministic, plan content is validated and approved before it can be marked executable, and planning provably creates no jobs or queue entries. See [docs/planning-domain.md](./docs/planning-domain.md). |
| **4B — Planner engine** | Deterministic authoring over the 4A contracts: `PlannerInput → PlannerRun` with a 12-rule versioned registry, canonical normalization, input/output fingerprints, plan identity, and authoring through the existing planning services only. Execution mapping exists as a **read-only intent emitter** at service level. | **Complete.** Build/typecheck/test/vertical-slice pass (165 tests); repeat runs are byte-identical; an unchanged re-run writes nothing; provenance is recorded per version and write-once; no job, queue entry, provider call, or UI is created, and no CLI command executes a plan. See [docs/planner-engine.md](./docs/planner-engine.md). |
| **4B-follow-on — Planned execution** | Submitting `mapPlanToJobs` intents through the Phase 3 services (`CreateGenerationJobCommand`), plus scene-level regeneration of planned outputs and their attempt/QC lineage. | **Complete, delivered as [Phase 5](#phase-5--plan--executable-work--durable-execution) above** — deliberately not part of 4B: the mapping and its deterministic ids were proven by tests first, and the submit call stayed an explicit later decision. Materialization is atomic and idempotent; scene-level regeneration reuses the existing job/attempt/QC lineage. See [docs/plan-execution.md](./docs/plan-execution.md). |
| **4C — AI planner adapter** | Provider-neutral `AIPlanner` port plus the shipped `providers/openai-chat` adapter: brief and definitions in, a schema-validated `PlanningProposal` out, normalized into `PlannerInput` and authored by the Phase 4B engine through the Phase 4A services, with write-once AI provenance, dry run, explicit fallback, and one CLI verb. | **Complete.** Build/typecheck/test/vertical-slice pass (207 tests, none needing a credential); invalid or contradictory output fails closed with nothing written; AI metadata stays outside plan content; provenance names adapter, model, schema version, and digests without storing a prompt, a response, or a secret; no adapter path touches storage, the queue, a provider, or a browser, and no command executes a plan. See [docs/ai-planning.md](./docs/ai-planning.md). |
| **4C-follow-on — Planned execution** | Turning an approved, executable plan into submitted Phase 3 work — the same gate the 4B-follow-on row describes, now reachable from either planning route. | **Complete, delivered as Phase 5 above.** Both planning routes reach it the same way, because the gate is the plan version's lifecycle state, not the route that authored it: an AI-proposed version carries an `AI_PROPOSED_PLAN` notice and is otherwise materialized, executed, and reviewed by the identical code path. |
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
- The application layer may only orchestrate: a new capability needs the component that owns its state, not a second implementation in `packages/services`.

## Phase 1 validation record

The final validation record for this implementation is in [docs/vertical-slice.md](./docs/vertical-slice.md). It includes the exact build/typecheck/test/CLI commands and distinguishes local SQLite runtime validation from the unimplemented live browser/provider paths.
