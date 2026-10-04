# FlowForge

FlowForge is an independent, provider-neutral creative-production system. Its project graph, scene versions, jobs, queue, assets, quality evidence, reviews, and selected versions are the source of truth. Google Flow is a replaceable future provider, not the product core.

## Current status

**Phase 1 is implemented and locally validated (2026-10-04).** The repository now has a durable, mock-backed production slice:

```text
Project → versioned Scene → idempotent Generation Job → SQLite queue/lease
        → MockGenerationProvider → filesystem Asset → deterministic QC
        → explicit Review → explicit selected version
```

The slice is exercised by an executable CLI and deterministic unit/integration tests, including fresh/legacy SQLite migration, process-crash recovery, duplicate submission/results, retries, permanent failure, timeout, and QC failure. This is not a product UI/API or a live Google Flow integration.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for package boundaries and recovery guarantees, [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) for remaining phases, [docs/vertical-slice.md](./docs/vertical-slice.md) for commands and behavior, [FEATURE_MATRIX.md](./FEATURE_MATRIX.md) for public-source research, and [DECISIONS.md](./DECISIONS.md) for decisions.

## Workspace packages

- `packages/core` — typed projects, immutable scene versions, generation/provider contracts, attempt/queue/asset/QC/review records.
- `packages/storage` — SQLite schema migrations, logical-generation idempotency, queue claims/leases, attempt history, assets, QC, reviews, and explicit selection.
- `packages/queue` — provider-neutral durable worker with recovery-before-submit, lease renewal, retry classification, artifact persistence, and finalization.
- `packages/assets` — atomic local filesystem storage for bytes and streaming SHA-256 integrity checks; bytes do not go in SQLite.
- `packages/qc` — deterministic file, readability, MIME, size, checksum, and supported image-dimension checks. No semantic success is fabricated.
- `providers/mock` — file-backed deterministic success, transient failure, permanent failure, timeout, and duplicate-result modes.
- `providers/google-flow` — existing safe adapter shell and browser diagnostics only. Phase 1 does not use it to submit, monitor, or download generations.
- `apps/cli` — the `flowforge` Phase 1 demo command.
- `packages/browser` and `apps/browser-gateway` — existing Playwright/CDP tooling for a user-authorized browser session; separate from this mock-backed slice.

## Quick start

Install dependencies, then run the same checks exposed by the root scripts:

```sh
corepack pnpm install
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
corepack pnpm vertical-slice
```

`corepack pnpm vertical-slice` builds the CLI and its workspace dependencies, then runs the success demo. It writes SQLite data, MockProvider manifests, and asset bytes under the ignored `.flowforge/vertical-slice/` directory. Re-running it reuses the same logical job and does not create another attempt or asset when the first run succeeded.

To run a different deterministic outcome or isolate data, build first and invoke the CLI directly:

```sh
corepack pnpm --filter @flowforge/cli build
node apps/cli/dist/index.js --data-dir /tmp/flowforge-demo --mode DUPLICATE_RESULT --review approve
node apps/cli/dist/index.js --data-dir /tmp/flowforge-qc-failure --artifact INVALID_PNG --review approve
```

Mock modes are `SUCCESS`, `TRANSIENT_FAILURE`, `PERMANENT_FAILURE`, `TIMEOUT`, and `DUPLICATE_RESULT`. `--review approve|reject` records an explicit demonstration decision against the exact output asset version. QC failures remain visible and cannot be selected. The CLI's approval is an example operator action, not a replacement for a real review UI.

## SQLite native dependency

The storage package uses `better-sqlite3`, so migration/integration tests require a working native addon; they do not silently skip database checks. If the prebuilt download is unavailable, build it against the local Node headers, for example:

```sh
cd packages/storage
npm_config_nodedir=/path/to/node-headers corepack pnpm rebuild --pending
```

The exact Node-header path is machine-specific. In the Phase 1 sandbox the local Node headers were used after the binary download could not be verified; fresh and legacy database tests then ran successfully.

## Safety boundary

Browser work is limited to a user's authorized browser session and visible, legitimate UI workflows where appropriate. FlowForge must not bypass authentication, CAPTCHA, platform security controls, or provider restrictions; extract/store cookies or credentials; use private APIs; or hard-code secrets. Challenges and provider blocks require user action. Google Flow submission, monitoring, and downloads are intentionally not part of Phase 1.
