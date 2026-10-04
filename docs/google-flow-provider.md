# Google Flow Provider (Phase 2)

## Status

`providers/google-flow` now implements the provider-neutral generation port using only visible interactions through `BrowserGateway`. The only implemented workflow is one image request at a time, with no references or non-default settings. The flow is covered by fake-based provider tests and a fake queue/asset/QC contract test.

**Live Google Flow status: BLOCKED / NOT RUN.** There was no user-authorized CDP browser session available during this implementation. The real Flow page's accessible names, selected-mode signals, generation status, result card, and download controls have not been observed or validated here. Do not treat the fake tests as evidence that live Flow selectors or account behavior passed. If live state cannot be uniquely correlated, the adapter stops and keeps the same durable attempt rather than accepting a guessed result or resubmitting.

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

- `DISCONNECTED`, `NO_PAGE`, `NOT_FLOW`, `AUTH_REQUIRED`, `BLOCKED`, `BUSY`, `READY`, or `UI_CHANGED`;
- an opaque `sessionId` derived from the CDP endpoint origin;
- a sanitized active URL without query/fragment.

A changed/missing selector, a security/access challenge, unclear authentication, or an unexpected active generation is not worked around. The provider stops and uses a typed `GenerationProviderError` so the durable queue can defer the same attempt when its external outcome is uncertain.

## Request and visible workflow

The adapter centralizes all provider-specific semantic targets in `providers/google-flow/src/index.ts`. It currently recognizes the visible contenteditable prompt textbox, a Generate control labeled `Generate` or `Construction begins`, a selected Image/Video control, an optional `More` menu, and a `Download` control. It only treats `https://labs.google/fx/tools/flow…` as Flow. Those names are provisional UI assumptions, not a Google-stable automation contract.

Session readiness uses the gateway's disabled-aware matching (`includeDisabled`): before a prompt is entered the Generate control is usually disabled, and a single enabled-or-disabled control still identifies the page as Flow rather than `UI_CHANGED`. Submission separately re-resolves the **enabled** Generate control and never clicks a disabled one.

For an accepted request it:

1. checks the attached session, Flow page, visible Image mode, prompt editor, current busy state, and request limits;
2. fills only if the editor's live value is still empty at write time and verifies the read-back; pre-existing text is never replaced;
3. writes a local recovery record before the Generate click, then dispatches a visible semantic click;
4. records `RUNNING` with a stable provider job ID derived from the attempt's provider request key; it does not claim that a dispatched click proves remote acceptance, and a dispatched-but-unverified click becomes `FLOW_TIMEOUT` with uncertain submission;
5. observes visible Flow state and reports `RUNNING`, `SUCCEEDED`, or a typed uncertain-state error only when its correlation rules are met;
6. on success, rechecks the same visible prompt/image association, hovers the uniquely correlated image, opens a visible `More` menu only if a unique `Download` control is not already visible, and requires exactly one visible `Download` control before invoking the gateway's browser download event;
7. returns one local artifact to the existing queue, which imports it through `FileSystemAssetStore` and evaluates it through deterministic QC.

No private or undocumented Flow endpoints are used. No provider details were added to `packages/core` domain records.

## Durable recovery and correlation

The existing queue persists a per-attempt `providerRequestKey` before provider calls. The neutral provider port now also passes the current generic `GenerationProviderRequest` to lookup/status/download so an adapter can compare visible state without copying plaintext prompt data into a second provider record. MockProvider ignores the optional context and remains the deterministic local/CI provider.

Flow recovery records are stored under the configured `rootDir` (default `.flowforge/google-flow/`):

- `records/flow-<sha256(providerRequestKey)>.json` stores the provider request key, stable FlowForge provider job ID, attempt number, a one-way prompt hash, baseline visible prompt-occurrence count, baseline visible-media fingerprints, opaque CDP session ID, state, and correlation evidence;
- `downloads/` contains browser-downloaded bytes until the existing asset store imports them;
- the manifest is atomically written with owner-only file permissions where supported. It contains no cookies, credentials, browser storage, raw page text, or plaintext prompt.

The prompt stays in the existing durable job record. A pending Flow result is accepted only when the current visible page has exactly one new occurrence of that request prompt and exactly one new visible image element with an accessible name; video elements are deliberately ignored. An active generation additionally needs a visible busy signal. Completed state records a fingerprint for the matched image. Before downloading, the adapter rechecks the prompt/image match and hovers that image element. If the browser restarts, the adapter reattaches to the configured endpoint and uses the same manifest/request key. If the page no longer exposes unique evidence, it raises an uncertain provider error and the queue retains the same attempt; it never generates a replacement attempt automatically.

This is intentionally conservative. Some legitimate Flow layouts may not expose enough visible information to satisfy the rule. In that case the job remains uncertain until bounded queue recovery is exhausted and is surfaced for operator action. Do not delete the manifest or retry the same logical request under a new key to bypass uncertainty.

## Typed errors and timeout behavior

Provider failures use `GenerationProviderError` codes so callers can distinguish `FLOW_AUTH_REQUIRED` / `FLOW_ACCESS_BLOCKED`, `FLOW_UI_CHANGED` / `FLOW_SESSION_NOT_READY`, `FLOW_TIMEOUT`, `FLOW_CORRELATION_AMBIGUOUS`, `FLOW_DOWNLOAD_TIMEOUT` / `FLOW_DOWNLOAD_FAILED`, and `FLOW_GENERATION_FAILED`. `FLOW_TIMEOUT` after a dispatched Generate click is explicitly `submissionUnknown`; it does not mark the generation failed. The existing queue retains and defers the same attempt under its unchanged Phase 1 classification (`UNCERTAIN_PROVIDER_STATE`), so no second retry engine or new durable error vocabulary was introduced. On the next run, it queries the provider using the durable request key and generic request context before it can decide whether the existing result is running, complete, failed, or still ambiguous. A visibly correlated provider failure is terminal for that remote request; a download failure retries the same result without regenerating. When bounded same-attempt recovery is exhausted, the attempt fails visibly and the existing storage guard still refuses a manual retry of uncertain work, which would otherwise create a new provider request key and a second Generate submission.

## Cancellation

FlowForge supports local job cancellation through the existing durable queue: the local job, active attempt, and queue item are marked `CANCELLED`. Remote Google Flow cancellation is deliberately conservative. `GoogleFlowProvider.cancelGeneration()` can mark a pre-submission local record cancelled, but for an in-flight/uncertain Flow request it returns the typed `FLOW_CANCEL_UNAVAILABLE` error and does not click a generic `Stop` or `Cancel` control. There is no tested visible workflow proving that such a control belongs to this attempt. The queue treats remote cancellation as best-effort, so local cancellation remains final even if Flow continues processing or consumes provider quota. A future remote-cancel implementation must first establish unambiguous ownership of the visible generation and test the complete workflow.

## Local use

Build and run deterministic checks without a Google account:

```sh
corepack pnpm build
corepack pnpm typecheck
corepack pnpm --filter @flowforge/browser test
corepack pnpm --filter @flowforge/provider-google-flow test
```

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
- The fake UI/transport tests exercise the intended control flow, not actual Flow rendering, eligibility, quota, or authentication.
- Correlation depends on Flow visibly echoing the exact prompt text. If Flow reformats, translates, truncates, or clears the prompt in the result card, correlation stays uncertain rather than guessing.
- `clearPrompt()` in the manual prompt-only diagnostic removes only the exact text the same provider instance prepared; it never clears arbitrary user text. The prepared text is held in memory only and is not persisted.
- Manual diagnostic and smoke scripts print only FlowForge's own status/typed codes. Raw browser error text (which can echo selectors, URLs, or editable contents) is intentionally not printed.

See [docs/browser-gateway.md](./browser-gateway.md), [ARCHITECTURE.md](../ARCHITECTURE.md), [FEATURE_MATRIX.md](../FEATURE_MATRIX.md), [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md), and [DECISIONS.md](../DECISIONS.md).
