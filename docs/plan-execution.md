# Plan Materialization → Durable Execution (Phase 5)

Planning says what a piece needs. Execution says what work exists. **Phase 5 is the bridge and nothing more**: it
turns one `EXECUTABLE` `ProductionPlanVersion` into durable execution rows — `Scene`, `SceneVersion`,
`GenerationJob`, and their queue items — using the primitives Phases 1 and 3 already own, and then it gets out of
the way. There is no second engine, no second queue, no second worker, no second retry policy, and no new
execution status a plan version can be in besides the one the 4A lifecycle already grants.

The one-sentence contract:

> `ProductionPlanVersion → readiness gate → execution mapping → one transaction → durable queued work`, and every
> later question about that work is answered by the existing job, queue, attempt, asset, QC, and review records.

Everything below is what that sentence commits to, and where each commitment is enforced.

---

## 1. Why a bridge and not an engine

Phase 4B shipped `mapPlanToJobs` as a read-only intent emitter with the explicit note that submitting those
intents stayed an operator decision. Phase 4C kept that boundary for the AI route. The gap this phase closes is
therefore narrow and well-defined: *who is allowed to turn an approved plan into work, and what guarantees the
turning must carry.*

The answer is one service, `PlanExecutionService` (`packages/services/src/execution/`), which:

- is the only caller of the mapping outside tests and read models;
- owns no SQL (it calls repository methods, including `transaction()`);
- owns no queue, lease, retry, provider, or asset logic (it enqueues through `GenerationService`, which already
  does);
- writes nothing when any precondition is unmet, and says which precondition;
- cannot be reached from a planning or planner command — `planner run` and `planner ai-run` still author a
  version and stop, and `plan preview`/`plan status` still create nothing.

The pure parts of the bridge (`execution-idempotency.ts`, `execution-mapping.ts`, `execution-readiness.ts`) are
separated from the service on purpose: they use no clock, no randomness, and no I/O, so the identity of a
materialization can be reproduced in a test, in a dry run, and in a later process without running anything.
`plan-execution.test.mjs` asserts that purity by scanning their source.

## 2. The path

```
 planId (+ optional versionNumber, providers, maxAttempts, dryRun)
   │
   ├─ resolveSnapshot            plan exists · project owned · version exists and is not archived
   ├─ readiness assessment       status EXECUTABLE · current validation evidence · scene plans and specs sound
   │                             · capabilities satisfiable by the *selected* providers · no scene conflict
   │        any blocker → EXECUTION_NOT_READY (or EXECUTION_CAPABILITY_UNAVAILABLE) and nothing is written
   ├─ buildExecutionMapping      deterministic units: ids, prompts, parameters, provider, priority, dependsOn
   │                             + executionFingerprint over canonical execution inputs only
   ├─ predict per unit           what already exists: scene by id, scene version by id + matching link, job by
   │                             provider and stable parameters (reused ⇒ nothing re-written)
   └─ ONE transaction (BEGIN IMMEDIATE)
        ├─ plan_executions row   insert-or-reuse, counted from a read-only pre-pass
        ├─ per unit              create Scene (if absent) → addSceneVersion (with plan link)
        │                        → requestGeneration (existing idempotent job + queue insert)
        └─ commit                a failure anywhere rolls the whole unit back; no partial graph exists
   │
   └─ report                     created/reused per unit, counts, blockers, notices, next action
                                  execution itself is the existing worker's job: flowforge queue run
```

Materialization enqueues; it never executes. A caller that wants results runs the worker (or waits for one). This
keeps `EXECUTABLE` meaning "the plan may become work" rather than "the work is in progress", which is what makes
the lifecycle and the queue independent concerns.

## 3. The readiness gate

`assessExecutionReadiness` is a pure function called before any write, and reused by the read-only
`planExecution.readiness()`. It returns an ordered, deduplicated blocker list — sorted by code then subject, so
the same state always produces the same report — and it never throws. The service throws for a real run and
reports for a dry run.

| Code | Raised when | Why it is a blocker |
| --- | --- | --- |
| `PLAN_NOT_EXECUTABLE` | version status is not `EXECUTABLE` | the lifecycle *is* the permission; there is no bypass flag |
| `PLAN_ARCHIVED` | version is archived | archived plans never become work, again or otherwise |
| `VALIDATION_MISSING` | no validation record for the version | approval requires evidence; executing without it would be guessing |
| `VALIDATION_STALE` | evidence is for a different `contentHash` | the plan that was checked is not the plan being executed |
| `VALIDATION_FAILED` | current evidence is not `PASSED`, or has errors | findings are not advisory at this boundary |
| `PLAN_HAS_NO_GENERATION_SPECS` | version declares no specs | nothing to materialize; refusing beats reporting success |
| `PLAN_HAS_NO_EXECUTABLE_UNITS` | specs exist but none survived mapping | every shot would be silently dropped |
| `EXECUTION_UNIT_UNMAPPED` | a spec was skipped for a non-capability reason | a plan must not execute as a partial |
| `EXECUTION_CAPABILITY_UNAVAILABLE` | the selected providers cannot satisfy a unit's declared capabilities | see §7 — this is the named Phase 5 refusal |
| `EXECUTION_PROVIDER_NOT_APPROVED` | requested `--providers` is not a subset of `executableProviders` | widening the pool after approval is a new decision, not a flag |
| `SCENE_ORDER_INVALID` / `SCENE_ORDER_CONFLICT` | a scene plan number is not ≥ 1, or two scene keys claim one number | ordering is execution's dependency input; ambiguity is not orderable |
| `SCENE_PROMPT_EMPTY` | a spec's instructions are blank after trimming | an empty prompt would produce an asset nobody asked for |
| `SCENE_DURATION_INVALID` / `SCENE_OUTPUT_COUNT_INVALID` | duration not an integer in range, or `outputCount < 1` | the provider contract is typed; fuzzing it moves failure downstream |
| `EXECUTION_SCENE_CONFLICT` | the deterministic scene id exists in another project | materialization never moves or copies a scene |
| `EXECUTION_SCENE_ARCHIVED` | the execution scene is archived | unarchive or revise; silently reusing an archived container is not allowed |
| `PLAN_PROVENANCE_STALE` → notice `PLANNER_PROVENANCE_STALE` | `plannerContentHash` ≠ `contentHash` | provenance describes an earlier draft; lifecycle and validation decide executability, so this is reported and *not* blocked |

Notices (informational, never blocking): `PLANNER_PROVENANCE_STALE`, `AI_PROPOSED_PLAN` (the plan content was
proposed through the 4C adapter — the deterministic planner and validator still authored and approved what is
being executed), `DRY_RUN` ("Nothing was written; a later call may see different state.").

Two refusals are load-bearing and deliberately different:

- **A blocked real run** throws `ApplicationError` with code `EXECUTION_NOT_READY`, or
  `EXECUTION_CAPABILITY_UNAVAILABLE` when every blocker is capability-attributable *and* at least one names a
  capability miss positively (that combination, not string-matching prose, decides the code). Details carry the
  whole blocker list, the notices, the `planVersionId`, the fingerprint, and a hint naming the exact command that
  would unblock it. The CLI maps both codes to exit `3` (blocked), so scripts can branch on it.
- **A blocked dry run** returns a report with `blockers` populated, `executionId: null`, predicted counts, and
  exit `3`. A blocked answer is still a useful answer.

When the version is not `EXECUTABLE`, the *derived* blockers are suppressed: the 4A preview marks every spec
unacceptable for that one reason, and listing it per spec would bury the cause under symptoms — and could dress
a lifecycle problem up as a capability problem. `PLAN_NOT_EXECUTABLE` (or `PLAN_ARCHIVED`) stands alone.

Provenance is checked if present and never invented: a plan version with no `plannerContentHash` was authored by
hand (4A commands), and that is an ordinary state, not a defect.

## 4. Execution identity

`executionFingerprint` is computed by `fingerprintJson(EXECUTION_FINGERPRINT_NAMESPACE, …)` over exactly the
inputs that decide *what work exists*:

```
{ projectId, planVersionId, rulesVersion: "plan-execution-v1",
  providers: [normalized selected ids],
  units: [{ scenePlanId, specId, specNumber, kind, prompt, outputCount, aspectRatio,
            durationMs, capabilityRequirements, references, provider }] }
```

Deliberately **excluded**: timestamps, UUIDs, `maxAttempts`, priority, lease or worker identity, attempt counts,
retry state, provider responses, scene/project status, and every validation or approval timestamp. Including any
of those would either make a retry look like new work or make identical work look different.

From that fingerprint, and only from it, come the ids:

| Identity | Derivation |
| --- | --- |
| `executionId` | `plannerId(fingerprint, "execution", planVersionId)` |
| `sceneId` | 4B's `plannerId("plan:" + planId, "execution-scene", sceneKey)` — so re-materializing the same plan reuses the same container |
| `sceneVersionId` | `plannerId(fingerprint, "scene-version", `${sceneKey}/${specNumber}`)` |
| `jobId` | decided by Phase 1's `createIdempotencyKey` over the scene version, provider, prompt, references, and parameters — the materialization does not mint its own job key |
| `dependsOn` | the scene plan order in the plan version: unit *n* depends on unit *n−1*, and only on that |

The dependency contract is the smallest one that is true: the plan's scene order is the ordering the plan
declares, so it becomes the queue priority ladder (`1000 − index`) and a one-step dependency, and nothing else.
No DAG inference, no cross-scene capability graph, no invented fan-out.

Same plan version + same rules + same provider selection ⇒ same fingerprint ⇒ same `executionId` ⇒ the reuse
path. Change the plan content, the spec, or the approved provider set and the fingerprint moves, which is
reported as *new* work rather than a mutation of the old work.

`planExecution.readiness({providers})` narrows by the same rule `markExecutable` used, and refuses a selection
that widens beyond `executableProviders` with `EXECUTION_PROVIDER_NOT_APPROVED`.

## 5. The scene boundary, in both directions

A `ScenePlan` is a planning artifact. It never becomes a `Scene` implicitly, and the row that makes it real is
written only here, at materialization:

- `Scene` — created if the deterministic id is absent (title and description come from the scene plan), reused if
  it exists in this project and is not archived.
- `SceneVersion` — immutable, with the plan link recorded on it: `planExecutionId`, `planVersionId`,
  `scenePlanId`, `generationSpecId`. All four or none; the database refuses a half-link
  (`scene_versions_plan_link_must_be_complete`), so "materialized by execution X" can never be asserted without
  the scene plan and spec it executed.
- `GenerationJob` — via `GenerationService.requestGeneration`, carrying `planExecutionId` as an additive field
  *outside* the job's idempotency identity, because which plan asked for work is provenance, not part of what the
  work is. Its link is write-once in both directions
  (`generation_jobs_plan_link_is_write_once` refuses changing *and* adding), so provenance can never be
  back-filled onto an unrelated job.

Scene numbering: a `Scene` is a project-level container and `scenes.scene_number` is unique per project. The
plan's number is the *intent*; if the project already holds that number for a different scene — a second plan, or
a re-plan whose scene keys changed — materialization takes the next free number, preserving the plan's relative
order instead of surfacing a database constraint mid-transaction. A reused scene keeps the number it has:
rewriting it would silently reorder finished work.

A later plan version produces a new `SceneVersion` and new jobs, and rewrites nothing: the first run's versions
keep their `planVersionId`, their jobs keep their `planExecutionId`, and the plan's history (versions,
validations, approvals, executions) stays queryable per version.

## 6. Atomicity and idempotency

**One materialization is one transaction.** `PlanExecutionService` wraps the whole write in
`repository.transaction()` — a `BEGIN IMMEDIATE` on the same shared SQLite connection the repository uses for its
own multi-row writes. There is no second transaction owner and no `ExecutionRepository`: `transaction()` was added
to `JobRepository` as a passthrough, which also means the nesting rule already proven in `packages/storage` holds
for free — an inner repository transaction becomes a savepoint, so a caught inner failure loses its own writes and
an uncaught one rolls the outer unit back.

Consequences that tests pin down:

- A failure injected at the second unit leaves zero scenes, zero scene versions, zero jobs, zero queue items, and
  zero `plan_executions` rows. There is no "half-materialized" state to reason about, and the next call is a
  clean run rather than a repair.
- `plan_executions` is inserted *before* scene versions (they reference it) but counted from the same read-only
  pre-pass that produces the report, so the numbers stored are the numbers shown.
- Counting distinguishes creation from reuse and never double-counts: the dry run tallies predictions and the
  write path tallies real outcomes through the same `applyTally`. `job_count` is durable jobs;
  `queueItemsCreated` is reported separately, because reuse means a job can exist with no new queue item.
- Re-running `materialize` on the same plan version returns `created: false`, the same `executionId` and
  fingerprint, `REUSED` for every unit, `queueItemsCreated: 0`, and writes nothing. `reused_job_count` on the
  stored row is the count from the call that *created* it — a later reuse does not amend it (and cannot:
  `plan_executions_are_immutable` refuses `UPDATE` and `DELETE` outright).
- Reuse is *matched*, not assumed: an existing scene version counts as reusable only if its prompt, references,
  and `planExecutionId` all match, and an existing job only if provider and stable parameters match. Anything
  else is a distinct identity, which is why a fingerprint collision is a hard refusal
  (`Plan execution fingerprint collision …`) rather than a silent reuse.

## 7. Providers, capabilities, and failing closed

Provider selection is `ProviderRegistry`-based, exactly as in 4A: a unit runs on the provider its spec's declared
capabilities admit, chosen by the mapping's deterministic ordering. MockProvider is the Phase 5 provider — the
deterministic CI route — and it is not special-cased anywhere in this layer.

The capability gate runs **before anything is enqueued**, and it runs at materialization rather than trusting the
`EXECUTABLE` stamp, because registrations can drift between approval and execution. If a required capability is
no longer satisfiable by the selected providers, materialization throws `EXECUTION_CAPABILITY_UNAVAILABLE` with a
per-spec blocker naming the capability, and:

- no `Scene`, `SceneVersion`, `Job`, or queue item exists;
- no queue item is "burned", so nothing sits in a retry loop;
- there is no silent fallback to another provider, and no autonomous multi-provider failover — an operator
  changes the plan's specs or the provider registration, then materializes again.

This is the same shape as 4A's `PLAN_CAPABILITY_UNMET` gate, one step later in the pipeline: approval checked
what *could* be executed; materialization checks what *will* be.

## 8. Retries, recovery, and ambiguous work

Nothing in Phase 5 claims a retry policy. The existing worker keeps:

- lease acquisition, visibility timeout, heartbeat, ACK, and `recoverExpiredLeases`;
- `classifyProviderError` → retryable vs not, `canRetryJob`, and the per-job attempt ledger;
- the same-attempt resume rule for a lease that expired mid-flight (recovery returns the job to the queue and the
  *same* attempt is resumed — the attempt id is unchanged);
- `FAIL_CLOSED` behaviour for an ambiguous external execution: an uncertain submission is never answered with a
  second job;
- retry adding an *attempt* to the same job, never a new job.

The mapping contributes only two things: the queue item's `priority` (plan order) and `maxAttempts` (an optional
operator input, excluded from the fingerprint so a changed retry budget does not fork the work).

`planExecution.status()` is a read model over those durable facts — job status, queue status, lease owner,
attempt count, per-attempt statuses, asset version, QC status, review status, selection — plus deterministic
hints (`flowforge queue run --max-jobs N …`, `flowforge retry --job-id ID …`, an explicit note when a worker died
mid-lease, and "selection and readiness stay blocked until an accepted output exists" after a QC failure). It
never mutates, re-claims, cancels, or repairs. Two derived states exist to make drift visible rather than fatal:
`EXECUTION_UNIT_MISSING` (a materialized unit's row disappeared — corrupt state, report it, do not guess) and
`EXECUTION_UNIT_WITHOUT_WORK` (a unit with no job — the transaction guarantees this means external tampering).

## 9. Assets, QC, and review stay Phase 3

Materialization writes no asset and touches no QC or review row. The worker's existing path produces the
`Asset`/`AssetVersion` with content-addressed identity and Phase 3 idempotency, runs deterministic QC twice by
design (once at submit, once at attempt completion — do not "fix" this), and records a `ReviewQueueItem`. A QC
failure uses the existing status and retry semantics; it is not a Phase 5 concept. `ReviewService` remains the
only path from `PASSED` to `APPROVED` and the only way to select an asset version, and production readiness
remains derived evidence rather than a flag. A materialization report therefore ends with an operator command
(`flowforge review approve …`, `flowforge review select …`), never with a claim that a piece is approved.

## 10. Persistence added in v7 (additive only)

| Object | Purpose |
| --- | --- |
| `plan_executions` | one row per (plan version, execution fingerprint): the idempotency anchor, with `project_id`, `plan_id`, `rules_version`, `mapping_scope`, `provider_id`, `status` (`MATERIALIZED`), and the counts `scene_count`, `scene_version_count`, `job_count`, `reused_job_count` |
| `scene_versions.plan_execution_id` / `plan_version_id` / `scene_plan_id` / `generation_spec_id` | the complete origin of a materialized scene version |
| `generation_jobs.plan_execution_id` | which materialization submitted the job, outside the job's identity |
| `plan_executions_are_immutable` / `plan_executions_cannot_be_deleted` | the anchor is evidence; counts stay truthful |
| `scene_versions_plan_link_must_be_complete` | no half-written origin |
| `generation_jobs_plan_link_is_write_once` | recorded once, never changed or added afterwards |
| `idx_plan_executions_plan` / `_plan_version`, `idx_scene_versions_plan_execution`, `idx_generation_jobs_plan_execution` | the three reads the operator needs: by plan, by version, per execution |

Foreign keys are `ON DELETE RESTRICT` throughout: a referenced plan version or scene version cannot be deleted
out from under an execution, and an execution row cannot be deleted out from under its work. All five columns are
nullable, so every pre-Phase-5 row is a plain "not plan-driven" row — legacy data is an ordinary state, not an
error, and no earlier migration or trigger was edited.

`SqliteJobRepository` gained exactly the methods this bridge needs — `transaction()`,
`createPlanExecutionWithCreated()`, `getPlanExecution()`, `listPlanExecutionsForVersion()`,
`listSceneVersionsByPlanExecution()`, plus a `planExecutionId` filter on `listGenerationJobs()` — and the two
command types (`AddSceneVersionCommand.planLink`, `RequestGenerationCommand.planExecutionId`) are optional, so
every existing caller is byte-for-byte unaffected.

## 11. Operator surface

```bash
flowforge plan execute --plan-id ID [--version N] [--providers CSV] [--max-attempts N] [--dry-run]
flowforge plan execution --plan-id ID [--version N] [--execution-id ID]
flowforge plan executions --plan-id ID [--version N]
```

`plan execute` is the only command in the repository that turns a plan into execution rows, and it is thin: read
flags, call `app.planExecution`, print what the service returned. It performs no generation itself — the printed
next step is `flowforge queue run`, which the existing worker owns. `--dry-run` is the first thing an operator
should run: it prints the planned units, their priority and dependency, the counts that a real run would write,
the fingerprint, and every blocker, and commits nothing. Human and `--json` output render the same object. Exit
codes follow the established convention: `0` ok, `1` error, `2` usage, `3` state legitimately blocks.

Before the first materialization, `plan execution` answers `NOT_FOUND` with "run flowforge plan execute first"
rather than inventing an empty state, and `plan executions` lists zero rows.

## 12. What this phase refuses

Live Google Flow execution · any new browser automation, CDP change, or Google authentication step · real
credentials · publishing · a new rendering or media pipeline · an agent loop or autonomous planning cycle · new
LLM planning · an independent execution engine, queue, or worker · multi-provider autonomous fallback · audio,
timeline, export, or analytics · any change to Phase 0/1 storage semantics beyond the additive v7 columns · any
weakening of an existing test.

Phase 6 (richer review/QC categories, media pipeline work) starts only after this phase's definition of done is
met and verified.

## 13. Test map

`packages/storage/test/plan-execution.test.mjs` (9) — v7 shape; reuse/insert of a materialization record;
fingerprint collision refusal; immutability and ownership checks on both insert and reuse; the complete-set link
trigger; job-link write-once in both directions; `transaction()` commit/rollback and the savepoint nesting rule;
ordered reads.

`packages/services/test/plan-execution.test.mjs` (19) — the brief's matrix, against the real SQLite + queue +
worker + MockProvider + QC + review stack:

| Case | Test |
| --- | --- |
| A happy path | plan → materialize → queue → worker → asset → QC `PASSED` → review still `PENDING` |
| B double materialize | same scene version, job, fingerprint; one queue item each; counts all `REUSED` |
| B′ dry run | predicts the ids and counts a real run writes; writes nothing; same fingerprint |
| C restart | close and reopen the database file, materialize again → same rows, no duplication |
| D claim → death → expiry | three leases, all three recovered, same job ids, same attempt resumed |
| E retryable failure | attempt 1 requeues, attempt 2 succeeds **on the same job** (3 jobs, 6 attempts) |
| F non-retryable failure | `FAILED` at one attempt, no retry loop, `flowforge retry` named as the repair path |
| F′ QC failure | recorded as `qcFailed`, job still `SUCCEEDED`, no approval fabricated |
| G capability drift | provider unregistered, and provider registered but incapable → `EXECUTION_CAPABILITY_UNAVAILABLE`, zero rows |
| H lifecycle | DRAFT and APPROVED-not-EXECUTABLE refused; archived refused; stale evidence refused; widened `--providers` refused |
| I injected failure | mid-materialization `throw` rolls back every row, and the retry after it is a clean full run |
| J duplicate claims | materialize + run + materialize + drain again leaves 3 jobs, 3 scene versions, 3 assets, 1 attempt each |
| purity | no clock, randomness, I/O, provider, queue, or browser import in the deterministic modules |
| security | no credential-shaped string in `plan_executions`, `scene_versions`, `generation_jobs`, `queue_items`, `assets`, `asset_versions`, or in the report |

`apps/cli/test/plan-execution-cli.test.mjs` (8) — every verb end to end across separate processes (which *is* the
restart condition): dry run vs real run, repeat materialize, half-run then finish, blocked plan exit `3`, the
explicit review/selection leg reflected in the read model, flags reaching the service, help and boundary wording.

`apps/cli/test/plan-vertical-slice.test.mjs` (2) — the golden slice:
`project → brief → definitions → planner run (validate → approve → executable) → plan execute → scene + scene
version + job → durable queue → worker → MockProvider → asset → QC PASS → review approve → select → production
ready`, then the whole tail re-run, asserting that the second worker run attempts zero jobs and that scenes,
queue items, asset bytes, and review decisions are unchanged. The second test proves the planning leg alone still
creates nothing.

Run them with `corepack pnpm -r --if-present test` (245 tests across 9 suites, none needing a credential, a
browser, or a network beyond localhost), or a single file with
`cd packages/services && node --test test/plan-execution.test.mjs` after `corepack pnpm -r --if-present build`.
