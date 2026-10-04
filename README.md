# FlowForge

FlowForge is an independent, provider-neutral creative-production system. Its project graph, scene versions, jobs, queue, assets, quality evidence, reviews, and selected versions are the source of truth. Google Flow is a replaceable provider, not the product core.

## Current status

**Phase 1's durable MockProvider slice and Phase 3's application-service layer plus operator CLI are implemented; Phase 2's browser-based Google Flow provider is implemented and fake-tested, but live Flow behavior is not validated.** The Phase 1 path remains the deterministic local/CI route:

```text
Project → versioned Scene → idempotent Generation Job → SQLite queue/lease
        → MockGenerationProvider → filesystem Asset → deterministic QC
        → explicit Review → explicit selected version
```

The Phase 2 provider uses only visible UI interactions through the generic browser gateway. Its declared scope is one image at a time with no references or non-default settings. Ordinary tests require neither Chrome nor a Google account. **Live Google Flow testing is BLOCKED / NOT RUN** because no user-authorized CDP session was available. Do not interpret passing fake tests as live Flow verification. Phase 3 makes the durable engine operable without changing it: `packages/services` validates and orchestrates, and `apps/cli` exposes project, scene, generation, queue, review, selection, and production-readiness commands whose human and `--json` output come from the same read models.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for package boundaries/recovery, [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) for delivery gates, [docs/vertical-slice.md](./docs/vertical-slice.md) for Phase 1 behavior, [docs/application-services.md](./docs/application-services.md) for the Phase 3 service boundaries and operator commands, [docs/browser-gateway.md](./docs/browser-gateway.md), [docs/google-flow-provider.md](./docs/google-flow-provider.md), [FEATURE_MATRIX.md](./FEATURE_MATRIX.md), and [DECISIONS.md](./DECISIONS.md).

## Workspace packages

- `packages/core` — typed projects, immutable scene versions, generation/provider contracts, attempt/queue/asset/QC/review records.
- `packages/storage` — SQLite schema migrations, logical-generation idempotency, queue claims/leases, attempt history, assets, QC, reviews, and explicit selection.
- `packages/queue` — provider-neutral durable worker with recovery-before-submit, lease renewal, retry classification, artifact persistence, and finalization.
- `packages/services` — application layer: request validation and capability admission, idempotent job creation, on-demand worker execution, review/selection commands, derived production readiness, and operator read models. Owns no queue, storage, retry, provider, browser, or asset-byte logic.
- `packages/assets` — atomic local filesystem storage for bytes and streaming SHA-256 integrity checks; bytes do not go in SQLite.
- `packages/qc` — deterministic file, readability, MIME, size, checksum, and supported image-dimension checks. No semantic success is fabricated.
- `providers/mock` — file-backed deterministic success, transient failure, permanent failure, timeout, and duplicate-result modes. Used by the local demo and ordinary reliability tests.
- `providers/google-flow` — visible-UI provider for a narrowly scoped single-image workflow; fake-tested, live UI unverified, and isolated behind the provider port.
- `packages/browser` — provider-neutral Playwright/CDP gateway with fake-transport tests, explicit tab selection, guarded input, observation, and visible upload/download actions.
- `apps/browser-gateway` — sanitized local CDP diagnostics, not a server or worker.
- `apps/cli` — operator subcommands over the services (project, scene, generate, queue, review, production, provider) plus the Phase 1 MockProvider demo command.

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

Browser automation attaches only to a user-authorized, manually authenticated session and uses visible UI operations. FlowForge must not bypass authentication, CAPTCHA, platform security controls, or provider restrictions; extract/store/log cookies, credentials, or tokens; call private APIs; or hard-code secrets. Authentication remains manual. Changed UI, blocked state, or uncertain correlation pauses the same durable attempt; a timeout is not treated as proof of provider failure and does not trigger blind resubmission. Local job cancellation is supported, but remote Google Flow cancellation is deliberately conservative: no generic Stop control is clicked unless ownership of that generation is unambiguous. There is no web UI/API, worker daemon, AI planner, agent system, publishing, analytics, or full video pipeline in this phase; the operator surface is the CLI over the application services.
