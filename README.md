# FlowForge

FlowForge is an independent, provider-neutral creative-production system. Its project graph, scene versions, jobs, queue, assets, quality evidence, reviews, and selected versions are the source of truth. Google Flow is a replaceable provider, not the product core.

## Current status

**Phases 1–3 are implemented, Phase 4A adds the creative planning domain — durable creative briefs, versioned production plans with story, cast, worlds, Visual DNA, scene plans, and generation specs, deterministic validation, and capability-gated executability — Phase 4B adds the deterministic planner engine that authors those plans, and Phase 4C adds an optional AI planner adapter that *proposes* input for that same engine. Phase 4A and 4B contain no model call at all. Phase 4C's adapter is propose-only: it may return a structured proposal, it writes nothing, and every field of the resulting plan is still decided by the deterministic rules and the Phase 4A validator. No agent loop, no autonomous submission, and no execution path exist anywhere in the planning route.** Phase 2's browser-based Google Flow provider is implemented and fake-tested, but live Flow behavior is not validated. The Phase 1 path remains the deterministic local/CI route:

```text
Project → versioned Scene → idempotent Generation Job → SQLite queue/lease
        → MockGenerationProvider → filesystem Asset → deterministic QC
        → explicit Review → explicit selected version
```

The Phase 2 provider uses only visible UI interactions through the generic browser gateway. Its declared scope is one image at a time with no references or non-default settings. Ordinary tests require neither Chrome nor a Google account. **Live Google Flow testing is BLOCKED / NOT RUN** because no user-authorized CDP session was available. Do not interpret passing fake tests as live Flow verification. Phase 3 makes the durable engine operable without changing it: `packages/services` validates and orchestrates, and `apps/cli` exposes project, scene, generation, queue, review, selection, and production-readiness commands whose human and `--json` output come from the same read models. Phase 4A sits above that spine: plans are authored, validated, approved, and marked executable, and only then mapped onto the existing scene/version/job commands. Planning never enqueues work, and `plan preview` is read-only by design. Phase 4B's planner is a pure function over explicit input — 12 named, versioned rules, canonical normalization, derived identifiers, and write-once provenance per version — so the same brief and story always produce the same plan; it writes through the same planning services a human uses, and no command executes a plan. Phase 4C puts a model in front of that engine and nothing behind it: `flowforge planner ai-run` asks a provider-neutral `AIPlanner` port, refuses any answer that is not a schema-valid proposal, resolves the proposal's names against the project, plans it with the 4B rules, validates it with 4A, and records which adapter, model, and digests produced the version — in additive v6 columns kept outside the plan's content hash. A live model call is never required to build, test, or verify FlowForge.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for package boundaries/recovery, [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) for delivery gates, [docs/vertical-slice.md](./docs/vertical-slice.md) for Phase 1 behavior, [docs/application-services.md](./docs/application-services.md) for the Phase 3 service boundaries and operator commands, [docs/planning-domain.md](./docs/planning-domain.md) for the Phase 4A planning model, lifecycle, validation catalogue, and CLI, [docs/planner-engine.md](./docs/planner-engine.md) for the Phase 4B planner contracts, rules, normalization, and determinism guarantees, [docs/ai-planning.md](./docs/ai-planning.md) for the Phase 4C AI planning boundary, port, proposal schema, provenance, and security rules, [docs/browser-gateway.md](./docs/browser-gateway.md), [docs/google-flow-provider.md](./docs/google-flow-provider.md), [FEATURE_MATRIX.md](./FEATURE_MATRIX.md), and [DECISIONS.md](./DECISIONS.md).

## Workspace packages

- `packages/core` — typed projects, immutable scene versions, generation/provider contracts, attempt/queue/asset/QC/review records, the planning contracts (brief, plan version, story, cast, world, Visual DNA, scene plan, generation spec, validation finding, planner trace step) with the plan-version lifecycle transition table, the canonical JSON/fingerprint helpers, and the planner/validator version constants.
- `packages/storage` — SQLite v6 schema migrations (v4 planning tables with lifecycle/immutability triggers and content hashing, v5 planner-provenance columns, v6 AI-proposal provenance columns, both with complete-set and write-once enforcement), logical-generation idempotency, queue claims/leases, attempt history, assets, QC, reviews, explicit selection, and the planning tables.
- `packages/queue` — provider-neutral durable worker with recovery-before-submit, lease renewal, retry classification, artifact persistence, and finalization.
- `packages/services` — application layer: request validation and capability admission, idempotent job creation, on-demand worker execution, review/selection commands, derived production readiness, and operator read models; plus the planning services (briefs, definitions, plans, deterministic validation, capability gating, plan read models, read-only execution preview) and the Phase 4B deterministic planner (`packages/services/src/planner/`), its service seam, and the read-only plan→execution mapping. Owns no queue, storage, retry, provider, browser, or asset-byte logic.
- `packages/assets` — atomic local filesystem storage for bytes and streaming SHA-256 integrity checks; bytes do not go in SQLite.
- `packages/qc` — deterministic file, readability, MIME, size, checksum, and supported image-dimension checks. No semantic success is fabricated.
- `providers/mock` — file-backed deterministic success, transient failure, permanent failure, timeout, and duplicate-result modes. Used by the local demo and ordinary reliability tests.
- `providers/google-flow` — visible-UI provider for a narrowly scoped single-image workflow; fake-tested, live UI unverified, and isolated behind the provider port.
- `providers/openai-chat` — the Phase 4C AI planning adapter: implements the domain's `AIPlanner` port against an OpenAI-compatible chat endpoint with structured JSON-schema output, byte and timeout caps, credential redaction, and no write, queue, browser, or execution capability of any kind.
- `packages/browser` — provider-neutral Playwright/CDP gateway with fake-transport tests, explicit tab selection, guarded input, observation, and visible upload/download actions.
- `apps/browser-gateway` — sanitized local CDP diagnostics, not a server or worker.
- `apps/cli` — operator subcommands over the services (project, scene, generate, queue, review, production, provider, brief, definition, plan) plus the Phase 1 MockProvider demo command.

## Quick start

Install dependencies, then run the repository checks:

```sh
corepack pnpm install
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
corepack pnpm vertical-slice
```

`corepack pnpm vertical-slice` builds the CLI and its workspace dependencies, then runs the deterministic success demo. It writes SQLite data, MockProvider manifests, and asset bytes under the ignored `.flowforge/vertical-slice/` directory. Re-running it reuses the same logical job and does not create another attempt or asset when the first run succeeded.

To run a different deterministic MockProvider outcome or isolate data, build first and invoke the CLI directly:

```sh
corepack pnpm --filter @flowforge/cli build
node apps/cli/dist/index.js --data-dir /tmp/flowforge-demo --mode DUPLICATE_RESULT --review approve
node apps/cli/dist/index.js --data-dir /tmp/flowforge-qc-failure --artifact INVALID_PNG --review approve
```

Mock modes are `SUCCESS`, `TRANSIENT_FAILURE`, `PERMANENT_FAILURE`, `TIMEOUT`, and `DUPLICATE_RESULT`. `--review approve|reject` records an explicit demonstration decision against the exact output asset version. QC failures remain visible and cannot be selected. The CLI's approval is an example operator action, not a replacement for a real review UI.

## Operating the pipeline step by step

The same durable path can be driven one command at a time. Add `--json` for machine-readable output built from the identical read models; exit codes are `0` ok, `1` error, `2` usage error, and `3` when stored state legitimately blocks the command (unmet readiness, provider coverage, open work, unsafe retry).

```sh
corepack pnpm --filter @flowforge/cli build
CLI="node apps/cli/dist/index.js --data-dir /tmp/flowforge-pilot"
$CLI project create --project-id pilot --name "Pilot"
$CLI scene create --project-id pilot --scene-id scene-1 --title "Opening shot"
$CLI scene version add --scene-id scene-1 --prompt "A lantern lights a dark stairwell at dusk."
$CLI generate --project-id pilot --scene-id scene-1      # re-running reuses the same job
$CLI queue run --all                                     # drives the durable worker
$CLI status --scene-id scene-1                           # job, attempts, outputs, next action
$CLI review list
$CLI review approve --asset-version-id <id> --reviewer <name> --comment "Approved"
$CLI review select --scene-id scene-1 --asset-version-id <id>
$CLI production scene --scene-id scene-1                 # derived readiness evidence
$CLI production ready --scene-id scene-1
```

`flowforge help` lists every command and flag. Queued work whose provider this invocation does not
serve is refused rather than failed: run `queue run` with the matching `--provider`, or review the
queue and pass `--ignore-provider-coverage` deliberately. `queue recover` requeues work whose worker
lease expired. `cancel --local-only` clears local durable state without contacting the provider.

## Planning before generating (Phase 4A)

A plan is authored, validated, approved, and marked executable before any work is submitted. Every step
is an explicit command, and every refusal is typed:

```sh
corepack pnpm --filter @flowforge/cli build
CLI="node apps/cli/dist/index.js --data-dir /tmp/flowforge-planning"
$CLI project create --project-id pilot --name "Pilot"
$CLI brief create --project-id pilot --title "Launch film" --concept "A rooftop chase at dawn" \
                 --objective "Feel momentum" --constraints-json '[{"kind":"MUST","value":"no on-screen text"}]'
$CLI definition character-create --project-id pilot --name "Aya" \
                 --traits-json '{"role":"protagonist","appearance":"red jacket","personality":"decisive"}'
$CLI definition world-create --project-id pilot --name "Rooftops" --environment "Dense rooftop grid at dawn"
$CLI definition dna-create --project-id pilot --name "dawn-grain" --style "35mm film look" \
                 --palette-json '["#0b1020"]' --lighting "low key" --composition "centered thirds" \
                 --camera-language "slow dolly" --rendering-style "photoreal" --atmosphere "tense"
$CLI plan create --project-id pilot --brief-id <briefId> --title "Launch film plan" --visual-dna-id <dnaId>
$CLI plan story set --plan-id plan-1 --premise "A courier carries one package across the rooftops"
$CLI plan scene add --plan-id plan-1 --scene-key open-01 --scene-number 1 --title "Arrival" \
                 --narrative-purpose "Establish the grid" --world-id <worldId> --duration-target-ms 6000
$CLI plan spec add --scene-plan-id <scenePlanId> --kind image --instructions "Wide rooftop establishing shot" \
                 --output-count 1 --aspect-ratio 16:9 --capabilities-csv imageGeneration
$CLI plan status --plan-id plan-1        # version, validity, approval, executability, blockers, next action
$CLI plan validate --plan-id plan-1      # deterministic structural validation; exit 3 when findings block
$CLI plan approve --plan-id plan-1 --reviewer <name>          # bound to the current content hash
$CLI plan executable --plan-id plan-1 --providers mock        # capability gate against provider declarations
$CLI plan preview --plan-id plan-1       # the exact Phase 3 commands a later phase would submit
```

`plan status` and `plan validate` are safe to repeat: validation evidence is reused while the content hash
is unchanged, an edit makes the evidence stale (`VALIDATION_STALE`) until you validate again, and an
approved version is frozen — `plan revise` copies it into a new draft instead of editing it. Marking a plan
executable requires passing validation, an explicit approval, and a configured provider that declares every
capability each spec needs; an unsatisfiable requirement fails with `PLAN_CAPABILITY_UNMET` and the offending
spec ids. Nothing in this flow creates a scene, a job, or a queue entry — `flowforge help` (or
`flowforge plan validate --help` for one command) and
[docs/planning-domain.md](./docs/planning-domain.md) document the whole surface, including the exit codes.

## Letting the planner author the plan (Phase 4B)

The same aggregate can be authored deterministically instead of scene by scene. `planner run` plans from the
project's current brief plus the story, cast, and world claims you pass, and writes only through the planning
services above:

```sh
$CLI planner rules                        # the 12 rules, their order, versions, and defaults

$CLI planner run --project-id pilot --dry-run \
  --story-json '{"premise":"A courier carries one package across the rooftops",
                 "beginning":"She reaches the grid at dawn.",
                 "development":"The chase crosses three rooftops and the watch slips.",
                 "ending":"She delivers it and walks out of frame."}' \
  --cast-json '[{"characterId":"<characterId>","role":"the courier"}]' \
  --worlds-json '[{"worldId":"<worldId>"}]' \
  --options-json '{"totalDurationMs":20000,"developmentScenes":3}'

# drop --dry-run to author the plan; --approve validates, approves, and (with --providers) marks it EXECUTABLE
$CLI planner run --project-id pilot --story-json '<same JSON>' --approve --reviewer <name> --providers mock

$CLI plan inspect --plan-id <planId>      # planner view: version, rules, seed, unchanged-since-planning
```

- A dry run writes nothing and reports the fingerprints the real run would record.
- Re-running identical input writes nothing at all (`reused: true`). A changed plan becomes a new version
  (`replan: "new-version"` by default; `"fail"` refuses with `IDEMPOTENCY_CONFLICT`; `"in-place"` is legal only
  on an empty, unprovenanced draft).
- Every authored version records its authorship — planner version, rules version, seed, and both fingerprints —
  and that provenance is never rewritten, so a future planner release cannot reinterpret an old plan.
- A run the rules reject exits 3 and persists nothing; a version whose stored rows fail validation afterwards
  stays an editable `DRAFT` and says so (`PLANNER_PERSISTED_VALIDATION_MISMATCH`).
- **Phase 4B stops at the plan.** There is no `planner execute` command; `plan preview` stays the read-only view
  of the Phase 3 commands a later phase would submit.

The engine's contracts, canonical normalization, identity derivation, and rule-by-rule behaviour are specified
in [docs/planner-engine.md](./docs/planner-engine.md).

## Letting a model propose the plan (Phase 4C)

`planner ai-run` is the one AI verb. It asks the configured adapter for a structured proposal and hands the
accepted proposal to the deterministic planner above — there is no second planning engine, and nothing in this
path can generate, enqueue, or publish:

```sh
export FLOWFORGE_AI_API_KEY=…            # read by name at call time; never stored, printed, or logged

$CLI planner ai-run --project-id pilot --dry-run   --guidance-json '{"sceneCount":3,"notes":"no on-screen text after the hook"}'   --options-json '{"totalDurationMs":20000,"aspectRatio":"9:16"}'

# drop --dry-run to author the version; --trace prints the recorded stages
$CLI planner ai-run --project-id pilot --approve --reviewer <name> --providers mock --trace

$CLI plan inspect --plan-id <planId>     # planner view, plus which adapter and model produced the version
```

- **AI proposes; the rules decide.** A proposal carries story direction, scene order and intent, per-scene
  duration and kind intent, character/world/DNA *names*, and continuity notes. Ids, durations beyond an
  explicit per-scene request, specifications, capabilities, continuity structure, and fingerprints stay the
  planner's. A name the project does not have fails the run; nothing is invented to fill a gap.
- **Structured output or nothing.** Prose, a wrong schema version, an unknown field, an over-capacity
  document, or a contradictory reference is refused with a typed, path-pointing report and no write.
- **Explicit fallback only.** `--fallback=deterministic` plans the story you passed instead; without it a
  failed adapter is simply a failed run (exit 3).
- **Auditable, not deterministic.** The version records the adapter, adapter version, provider, model, schema
  version, path, and the request/proposal/response digests — digests rather than prompt bodies, so there is
  nothing sensitive to leak and still something to verify.
- **Phase 4C stops at the plan**, like 4B: no `planner execute`, no `--execute` flag, and the CLI tests assert
  their absence.

The port, proposal schema, provenance columns, security rules, and test map are in
[docs/ai-planning.md](./docs/ai-planning.md).

## Browser diagnostics and live Flow smoke

The safe prompt-only diagnostic does not click Generate, but it requires a deliberately prepared, manually authenticated Flow page with an empty prompt editor:

```sh
FLOWFORGE_CDP_ENDPOINT=http://127.0.0.1:9222 \
  corepack pnpm --filter @flowforge/provider-google-flow test:prompt
```

The separate live smoke test **does submit one real image generation** and may consume account quota. It runs only when both confirmation variables are set and the user has already authenticated in the visible browser:

```sh
FLOWFORGE_CDP_ENDPOINT=http://127.0.0.1:9222 \
FLOWFORGE_LIVE_SMOKE=1 \
FLOWFORGE_CONFIRM_LIVE_GENERATION=I_UNDERSTAND_THIS_GENERATES_MEDIA \
  corepack pnpm --filter @flowforge/provider-google-flow test:live
```

Use a protected local CDP endpoint and the same `FLOWFORGE_GOOGLE_FLOW_DATA_DIR` across restarts. The smoke prints a non-secret request key; provide it as `FLOWFORGE_LIVE_SMOKE_REQUEST_KEY` to resume that same attempt. Never use the smoke to bypass an authentication challenge, CAPTCHA, security control, or provider restriction. **Live Flow smoke was NOT RUN in this checkout** because no authorized session was available; see [docs/google-flow-provider.md](./docs/google-flow-provider.md) for recovery behavior and limitations.

Ordinary `corepack pnpm test` runs only deterministic tests. It does not invoke the live smoke or require Google credentials.

## SQLite native dependency

The storage package uses `better-sqlite3`, so migration/integration tests require a working native addon; they do not silently skip database checks. If the prebuilt download is unavailable, build it against the local Node headers, for example:

```sh
cd packages/storage
npm_config_nodedir=/path/to/node-headers corepack pnpm rebuild --pending
```

The exact Node-header path is machine-specific. In the Phase 1 sandbox the local Node headers were used after the binary download could not be verified; fresh and legacy database tests then ran successfully.

## Safety boundary

Browser automation attaches only to a user-authorized, manually authenticated session and uses visible UI operations. FlowForge must not bypass authentication, CAPTCHA, platform security controls, or provider restrictions; extract/store/log cookies, credentials, or tokens; call private APIs; or hard-code secrets. Authentication remains manual. Changed UI, blocked state, or uncertain correlation pauses the same durable attempt; a timeout is not treated as proof of provider failure and does not trigger blind resubmission. Local job cancellation is supported, but remote Google Flow cancellation is deliberately conservative: no generic Stop control is clicked unless ownership of that generation is unambiguous. There is no web UI/API, worker daemon, agent system, publishing, analytics, or full video pipeline in this phase; Phase 4C's AI planner is an adapter that returns a proposal and nothing else — it holds no repository, queue, browser, or credential beyond the one request header it is configured to send, and it cannot execute, submit, or persist by itself; the operator surface is the CLI over the application services. Phases 4A and 4B add the planning *domain* and a *deterministic* planner: no model call, no provider-implementation change, and no plan that can execute without the explicit Phase 3 commands above — 4B's planner refuses rather than guessing, and ships no execution command. Phase 4C's model access is bounded by the same rule: the domain wins over any AI answer, a proposal that cannot be validated ends the run with nothing written, credentials are read from the environment by variable name and never persisted or printed, and no planning command — deterministic or AI-proposed — submits work.
