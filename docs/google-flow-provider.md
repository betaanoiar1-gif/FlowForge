# Google Flow Provider

## Status

`providers/google-flow` implements the provider-neutral generation port using only visible interactions through `BrowserGateway`. The only implemented workflow is one image request at a time, with no references or non-default settings. It is reachable from the real engine path — `GenerationJob → provider registry → GoogleFlowProvider → BrowserGateway → Google Flow` — with no second queue, worker, retry engine, asset store, or Google-specific orchestration layer anywhere on that path.

Phase 2 proved the adapter's shape; **Phase 6 hardened the execution boundary**: the state and error taxonomy an operator can act on, the prompt verification that must succeed before a click, one side effect per attempt, fail-closed correlation, artifact validity before handoff, and the retry/recovery classification each state earns. Both phases are covered by automated tests that drive a **fake `BrowserGateway`** (72 tests in this package), plus the queue/asset/QC contract tests that drive the real durable engine against that same fake.

**Live Google Flow status: BLOCKED / NOT RUN — manual validation pending.** Every test here uses a scripted in-process gateway; none logs into Google, opens an interactive Flow session, or downloads a real Flow artifact. The real Flow page's accessible names, selected-mode signals, generation status, result card, and download controls have not been observed or validated in this checkout. Live validation happens by hand on Google Colab with the user, one generation at a time, before any autonomous run is attempted. Do not read a passing fake test as evidence about live Flow selectors, eligibility, quota, or account behavior. If live state cannot be uniquely correlated, the adapter stops and keeps the same durable attempt rather than accepting a guessed result or resubmitting.

## Scope and capabilities

The adapter currently declares only `imageGeneration: true`. It supports exactly one image output when all of these are true:

- a user-authorized CDP browser is attached to the public Flow page;
- the user has authenticated manually and the page is not blocked or busy;
- one visible contenteditable prompt editor and one visible Image-selected mode are uniquely observable;
- the request has a non-empty prompt, no references, one output, and no settings beyond `mode: "image"` and `outputCount: 1`;
- the prompt editor is empty at write time (the guarded fill compares its live value before writing); pre-existing text is never overwritten;
- the Generate action and eventual result can be correlated unambiguously through visible UI state.

Video generation, references/ingredients, start/end frames, batch outputs, Flow model/settings selection, project creation, storyboards, agents, audio/video editing, and a full media pipeline are **not supported**. Capabilities are deliberately false for video, references, start/end frame, and batch generation. `GoogleFlowProvider.capabilities` describes the implemented narrow path; the live path remains unverified until the opt-in smoke test passes on an authorized session.

## Session and authentication

Use a browser profile the user controls, launch it with a local CDP endpoint, and authenticate manually in the visible browser. The provider never asks for, reads, stores, or replays a password, cookie, token, or browser-storage value. It can open the public Flow page, but any sign-in/challenge is a manual user action.

`inspectSession()` returns a small status summary rather than page text or account data:

- `DISCONNECTED`, `NO_PAGE`, `NOT_FLOW`, `AUTH_REQUIRED`, `BLOCKED`, `BUSY`, `PAGE_NOT_READY`, `READY`, or `UI_CHANGED`;
- an opaque `sessionId` derived from the CDP endpoint origin;
- a sanitized active URL without query/fragment;
- a `reasonCode` when the state needs one, so `UI_CHANGED` can still be told apart from a merely late-rendering page.

`PAGE_NOT_READY` is deliberately separate from `UI_CHANGED`: a document that has not finished loading is worth another pass, while a page whose controls are absent or ambiguous is a person's decision. Authentication is never automated — the adapter reports the state and stops.

## Request and visible workflow

The adapter centralizes all provider-specific semantic targets in `providers/google-flow/src/index.ts`. It currently recognizes the visible contenteditable prompt textbox, a Generate control labeled `Generate` or `Construction begins`, a selected Image/Video control, an optional `More` menu, and a `Download` control. It only treats `https://labs.google/fx/tools/flow…` as Flow. Those names are provisional UI assumptions, not a Google-stable automation contract.

Session readiness uses the gateway's disabled-aware matching (`includeDisabled`): before a prompt is entered the Generate control is usually disabled, and a single enabled-or-disabled control still identifies the page as Flow rather than `UI_CHANGED`. Submission separately re-resolves the **enabled** Generate control and never clicks a disabled one.

For an accepted request it:

1. checks the attached session, Flow page, visible Image mode, prompt editor, current busy state, document readiness, and request limits — every one of them before anything is written or clicked;
2. re-reads the durable request identity (`providerRequestKey`, attempt number, prompt digest) against any existing recovery record, so an attempt already being monitored can only be observed;
3. fills only if the editor's live value is still empty at write time and verifies the read-back; pre-existing text is never replaced;
4. **re-reads the page and requires exactly one new visible occurrence of the prompt it just wrote**, then re-resolves the *enabled* Generate control, and only then writes `SUBMITTING` and dispatches one visible semantic click;
5. records `RUNNING` with a stable provider job ID derived from the attempt's provider request key; it does not claim that a dispatched click proves remote acceptance, and a dispatched-but-unverified click becomes `FLOW_TIMEOUT` with uncertain submission;
6. observes visible Flow state and reports `RUNNING`, `SUCCEEDED`, `FAILED`, or a typed uncertain-state error only when its correlation rules are met;
7. on success, rechecks the same visible prompt/image association *and* the recorded media fingerprint, hovers the uniquely correlated image, opens a visible `More` menu only if a unique `Download` control is not already visible, and requires exactly one visible `Download` control before invoking the gateway's browser download event;
8. confirms the downloaded bytes can be described as a supported image, then hands one local artifact to the existing queue, which imports it through `FileSystemAssetStore` and evaluates it through deterministic QC.

No private or undocumented Flow endpoints are used. No provider details were added to `packages/core` domain records.

## Prompt integrity before submission

The supplied prompt is authoritative. The adapter never clicks Generate because a Generate-shaped control exists, and it never infers that "the prompt I meant" is on screen. Because the gateway deliberately refuses to expose editable contents through discovery (see [docs/browser-gateway.md](./browser-gateway.md)), the adapter uses the two channels that do exist:

- the guarded `fill`, which compares the editor's live value before writing and reads the value back after (`verified`); and
- one more visible occurrence of the exact prompt in the page's own text, measured against the baseline taken before the fill.

Both are required *immediately before* the click, on the same page, in the same browser session. A page that reformats, truncates, hides, or loses the prompt fails closed as `FLOW_PROMPT_NOT_VISIBLE` with the recovery record left at `NOT_SUBMITTED`, which is provably true: no click had happened yet. This is the same evidence the correlation step needs later, so the pre-click gate cannot reject a submission that correlation would have accepted — it only moves that decision to before the side effect.

## One side effect per attempt

One `GenerationAttempt` produces at most one Generate submission, and that is a property of the persisted record rather than of in-memory bookkeeping:

- the recovery record is keyed by the attempt's durable `providerRequestKey` and created before any click, with `wx` + link so two processes cannot both claim to be first;
- a record in `PREPARED`/`SUBMITTING`/`RUNNING`/`SUCCEEDED`/`FAILED`/`CANCELLED` makes a repeated `createGeneration` a *recovery* (it returns the existing handle) — the editor is not rewritten and no second click is dispatched;
- only a record provably in `NOT_SUBMITTED` — written where the browser reported a fill, a verification, or a non-unique-target failure before dispatch — may be replaced and submitted;
- a click whose dispatch could not be confirmed stays in `SUBMITTING`, and observing it reports `FLOW_SUBMISSION_UNKNOWN` rather than re-clicking;
- poll timeouts, ambiguous correlation, session drift, unreadable records, and download failures all set `submissionUnknown`, which the existing queue handles as same-attempt recovery.

Nothing in the adapter polls in a loop or re-submits: one worker claim performs one observation cycle per step, and `maxRecoveries` bounds it.

## Durable recovery and correlation

The existing queue persists a per-attempt `providerRequestKey` before provider calls. The neutral provider port now also passes the current generic `GenerationProviderRequest` to lookup/status/download so an adapter can compare visible state without copying plaintext prompt data into a second provider record. MockProvider ignores the optional context and remains the deterministic local/CI provider.

Flow recovery records are stored under the configured `rootDir` (default `.flowforge/google-flow/`):

- `records/flow-<sha256(providerRequestKey)>.json` stores the provider request key, stable FlowForge provider job ID, attempt number, a one-way prompt hash, baseline visible prompt-occurrence count, baseline visible-media fingerprints, opaque CDP session ID, state, and correlation evidence;
- `downloads/` contains browser-downloaded bytes until the existing asset store imports them;
- the manifest is atomically written with owner-only file permissions where supported. It contains no cookies, credentials, browser storage, raw page text, or plaintext prompt.

`providerJobId` is FlowForge's own local handle — `flow-<sha256(providerRequestKey)>` — not a remote
identifier. Flow exposes no stable per-submission id through the visible UI, so none is invented or
scraped; the durable identity of the work is the attempt's `providerRequestKey` plus the visible evidence
recorded beside it, and that pairing is what recovery re-verifies.

The prompt stays in the existing durable job record. A pending Flow result is accepted only when the current visible page has exactly one new occurrence of that request prompt and exactly one new visible image element with an accessible name; video elements are deliberately ignored. An active generation additionally needs a visible busy signal. Completed state records a fingerprint for the matched image. Before downloading, the adapter rechecks the prompt/image match and hovers that image element. If the browser restarts, the adapter reattaches to the configured endpoint and uses the same manifest/request key. If the page no longer exposes unique evidence, it raises an uncertain provider error and the queue retains the same attempt; it never generates a replacement attempt automatically.

This is intentionally conservative. Some legitimate Flow layouts may not expose enough visible information to satisfy the rule. In that case the job remains uncertain until bounded queue recovery is exhausted and is surfaced for operator action. Do not delete the manifest or retry the same logical request under a new key to bypass uncertainty.

## State taxonomy and recovery classification

Every distinguishable state carries its own code, because each earns a different decision. `GOOGLE_FLOW_ERROR_CODES` is the single vocabulary; `GOOGLE_FLOW_ERROR_CODE_ALIASES` names the operator-facing state each code answers so no parallel taxonomy is invented.

| State | Code | `retryable` | `submissionUnknown` | Queue decision |
| --- | --- | --- | --- | --- |
| Provider selected, no browser session configured | `GOOGLE_FLOW_NOT_CONFIGURED` (application error, raised by the composition root) | — | — | nothing enqueued or executed yet |
| Endpoint configured, attach failed | `FLOW_BROWSER_UNAVAILABLE` | yes | no | retry: transient transport |
| No active page | `FLOW_BROWSER_UNAVAILABLE` | yes | no | retry after the page is opened |
| Document still loading | `FLOW_PAGE_NOT_READY` | yes | no | retry: waiting is the fix |
| Another generation visibly running | `FLOW_SESSION_NOT_READY` (`BUSY`) | yes | no | retry later; never join or replace it |
| Manual sign-in needed, nothing submitted | `FLOW_AUTH_REQUIRED` | no | no | fail fast; a person authenticates, then `retry` |
| Security/access challenge | `FLOW_ACCESS_BLOCKED` | no | no | fail fast; resolve manually, never evade |
| Flow editor absent | `FLOW_EDITOR_NOT_FOUND` | no | no | fail fast; inspect the page |
| Prompt editor absent/ambiguous | `FLOW_PROMPT_INPUT_NOT_FOUND` | no | no | fail fast; inspect the page |
| Generate control absent/disabled/non-unique | `FLOW_GENERATE_CONTROL_NOT_FOUND` | no | no | fail fast; never click a control that is not there |
| Controls present but the workflow changed | `FLOW_UI_CHANGED` | no | no | fail fast; inspect the page |
| Prompt not visibly echoed before the click | `FLOW_PROMPT_NOT_VISIBLE` | no | no | fail close; record stays `NOT_SUBMITTED` |
| Prompt could not be filled/read back | `FLOW_PROMPT_FILL_FAILED` | yes | no | retry; user text is preserved |
| Capability or request shape unsupported | `FLOW_UNSUPPORTED_REQUEST` | no | no | never reaches the browser |
| Control vanished at dispatch | `FLOW_SUBMISSION_FAILED` | yes | no | provably no submission, so a new attempt is safe |
| Dispatch attempted, outcome unknown | `FLOW_SUBMISSION_UNKNOWN` | yes | **yes** | defer: observe the same attempt |
| Clicked, no visible change yet (generation/poll timeout) | `FLOW_TIMEOUT` | yes | **yes** | defer: observe the same attempt |
| Result cannot be uniquely correlated | `FLOW_CORRELATION_AMBIGUOUS` | yes | **yes** | defer: never pick "latest" media |
| Correlated failure shown on the page | `FLOW_GENERATION_FAILED` | no | — | terminal for that remote request |
| No local record for that provider job ID | `FLOW_GENERATION_NOT_FOUND` | no | — | caller error; nothing to observe |
| Result not ready / not downloaded yet | `FLOW_RESULT_NOT_READY` | yes | **yes** | defer: the result may still appear |
| Download failed or menu/hover unavailable | `FLOW_DOWNLOAD_FAILED` | yes | **yes** | re-download the same result |
| Download timed out | `FLOW_DOWNLOAD_TIMEOUT` | yes | **yes** | re-download the same result |
| Downloaded bytes are not a describable image | `FLOW_INVALID_ARTIFACT` | yes | **yes** | re-download; never import, never regenerate |
| Local recovery record unavailable | `FLOW_RECOVERY_STORAGE_UNAVAILABLE` | yes | depends | never click without a durable record |
| Remote stop unavailable | `FLOW_CANCEL_UNAVAILABLE` | no | — | local cancellation stays final |

Two rules generate the whole table. First, **`retryable` answers "would trying again plausibly help", and `submissionUnknown` answers "might a remote generation already exist"** — the queue uses the second to choose same-attempt recovery over a new attempt, which is why an ambiguous state never earns a second click. Second, only a pre-click failure may claim that nothing was submitted, so the same code carries different flags depending on whether a dispatch was possible: `FLOW_AUTH_REQUIRED` before a click fails fast, while authentication lost *during* a pending generation defers the same attempt and resumes after a manual sign-in.

`FLOW_TIMEOUT` after a dispatched Generate click is explicitly `submissionUnknown`; it does not mark the generation failed. The existing queue retains and defers the same attempt under its unchanged Phase 1 classification (`UNCERTAIN_PROVIDER_STATE`), so no second retry engine or new durable error vocabulary was introduced. On the next run, it queries the provider using the durable request key and generic request context before it can decide whether the existing result is running, complete, failed, or still ambiguous. A visibly correlated provider failure is terminal for that remote request; a download failure retries the same result without regenerating. When bounded same-attempt recovery is exhausted, the attempt fails visibly and the existing storage guard still refuses a manual retry of uncertain work, which would otherwise create a new provider request key and a second Generate submission.

## Attempt phases: reading the recovery record

`GoogleFlowProvider.attemptState(providerRequestKey)` is a read-only projection of the same persisted manifest, so "the click was accepted" and "a result is correlated" are distinguishable without reading files or re-polling the page. It never clicks, writes, or adds a polling cycle.

| Phase | Meaning |
| --- | --- |
| `NOT_SUBMITTED` | a record exists and provably no Generate action was dispatched |
| `PREPARED` | validated and recorded, nothing dispatched yet |
| `SUBMITTING` | dispatch was attempted or begun and was never confirmed — the state that forbids re-clicking |
| `SUBMISSION_ACCEPTED` | the browser confirmed the dispatch; the result is pending |
| `RESULT_DETECTED` | exactly one new visible media element is correlated to this prompt |
| `RESULT_STORED` | the correlated bytes are downloaded and describable, ready for the existing asset path |
| `FAILED` / `CANCELLED` | terminal for this attempt, either visibly on the page or locally |

The phase is *derived* from the single manifest state machine, never stored beside it, so a record cannot disagree with itself. It carries no prompt, page text, credential, or remote identifier beyond the local `flow-<sha256(providerRequestKey)>` id FlowForge minted itself.

## Cancellation

FlowForge supports local job cancellation through the existing durable queue: the local job, active attempt, and queue item are marked `CANCELLED`. Remote Google Flow cancellation is deliberately conservative. `GoogleFlowProvider.cancelGeneration()` can mark a pre-submission local record cancelled, but for an in-flight/uncertain Flow request it returns the typed `FLOW_CANCEL_UNAVAILABLE` error and does not click a generic `Stop` or `Cancel` control. There is no tested visible workflow proving that such a control belongs to this attempt. The queue treats remote cancellation as best-effort, so local cancellation remains final even if Flow continues processing or consumes provider quota. A future remote-cancel implementation must first establish unambiguous ownership of the visible generation and test the complete workflow.

## Local use

Build and run deterministic checks without a Google account:

```sh
corepack pnpm build
corepack pnpm typecheck
corepack pnpm --filter @flowforge/browser test
corepack pnpm --filter @flowforge/provider-google-flow test
corepack pnpm vertical-slice
```

Every test above drives a **fake gateway**, never a browser: `test/provider.test.mjs` and
`test/provider-contract.test.mjs` cover the Phase 2 adapter and its queue/asset/QC contract;
`test/real-provider-boundary.test.mjs` covers the Phase 6 boundary (session and control states, prompt
integrity, one submission per attempt, correlation and download decisions) against
`test/support/fake-flow-gateway.mjs`, whose `generateClicks`, `downloadCalls`, and `pollCalls` counters
are what those tests assert; and `test/real-provider-integration.test.mjs` drives the same fake through
the real SQLite repository, queue, worker, asset store, and deterministic QC. `apps/cli/test/flow-runtime.test.mjs`
covers the composition root: the difference between "provider not configured" and "session unavailable",
and the fact that reads and enqueueing never attach a browser.

The safe manual prompt-only diagnostic requires a prepared user-authorized Flow session and does **not** generate:

```sh
FLOWFORGE_CDP_ENDPOINT=http://127.0.0.1:9222 \
  corepack pnpm --filter @flowforge/provider-google-flow test:prompt
```

The separate live smoke creates one image and can consume account quota. It is disabled unless both explicit confirmations are set:

```sh
FLOWFORGE_CDP_ENDPOINT=http://127.0.0.1:9222 \
FLOWFORGE_LIVE_SMOKE=1 \
FLOWFORGE_CONFIRM_LIVE_GENERATION=I_UNDERSTAND_THIS_GENERATES_MEDIA \
  corepack pnpm --filter @flowforge/provider-google-flow test:live
```

Authenticate manually before running it. The script prints a non-secret provider request key; pass it back as `FLOWFORGE_LIVE_SMOKE_REQUEST_KEY` to resume that same smoke request after a timeout/restart. A timeout or ambiguous result never triggers a second Generate click. Use the same provider data directory (`FLOWFORGE_GOOGLE_FLOW_DATA_DIR`) across restarts.

Ordinary `pnpm test` does not invoke the live smoke test. The live test was **NOT RUN** here because the required authorized browser session was unavailable.

## Known limitations

- Flow's live UI is not validated. Accessible labels, selected state, busy/failure text, visible output media, and Download-menu placement may differ or change.
- The adapter only accepts the single-image/default-settings path; it does not set or verify other Flow settings.
- Correlation requires the Flow page to visibly show the exact request prompt and one new accessible media element. It may safely refuse cases where Flow collapses/clears the prompt or does not expose an accessible media label.
- A unique page-level Download control is required after hovering the correlated media. If the UI presents multiple candidate controls or the result association is unclear, no download is accepted.
- The existing deterministic QC can validate file integrity/MIME and supported image dimensions; it does not evaluate visual prompt adherence or continuity.
- The fake UI/transport tests exercise the intended control flow, not actual Flow rendering, eligibility, quota, or authentication. A green suite here is evidence about the boundary, not about Google.
- Correlation and pre-click verification both require the page to echo the prompt as visible body text. The gateway never exposes editable contents, and the adapter will not assume a prompt is present because it typed one. If live Flow renders the prompt somewhere `document.body.innerText` does not cover, the correct outcome is a fail-closed `FLOW_PROMPT_NOT_VISIBLE` and a manual look — which is exactly the first thing the Colab validation is for.
- The composition root distinguishes `GOOGLE_FLOW_NOT_CONFIGURED` (no `--cdp-endpoint`/`FLOWFORGE_CDP_ENDPOINT`, so nothing was ever wired) from `PROVIDER_SESSION_UNAVAILABLE` (an endpoint was given but could not be attached). Both names are scheme-and-host only; credentials or query data in an endpoint URL are never echoed.
- Artifact validity is a *describability* check, not a quality check: the bytes are accepted as an image if the download name or the file signature says so, and refused as `FLOW_INVALID_ARTIFACT` if neither does. Judging the image itself stays with the existing deterministic QC path, which is not duplicated here.
- Nothing here has been executed against Google Flow. Until the manual single-generation check on an authorized session passes, the fake-tested boundary is the strongest claim this repository makes.
- Correlation depends on Flow visibly echoing the exact prompt text. If Flow reformats, translates, truncates, or clears the prompt in the result card, correlation stays uncertain rather than guessing.
- `clearPrompt()` in the manual prompt-only diagnostic removes only the exact text the same provider instance prepared; it never clears arbitrary user text. The prepared text is held in memory only and is not persisted.
- Manual diagnostic and smoke scripts print only FlowForge's own status/typed codes. Raw browser error text (which can echo selectors, URLs, or editable contents) is intentionally not printed.

See [docs/browser-gateway.md](./browser-gateway.md), [ARCHITECTURE.md](../ARCHITECTURE.md), [FEATURE_MATRIX.md](../FEATURE_MATRIX.md), [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md), and [DECISIONS.md](../DECISIONS.md).
