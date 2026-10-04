# Browser Gateway

## Purpose and status

`packages/browser` is the provider-neutral browser boundary. `CdpBrowserGateway` uses Playwright's supported `connectOverCDP` connection to attach to a browser the user launched and authenticated manually. `apps/browser-gateway` remains a local diagnostic CLI, not a server or production worker.

The gateway supports opaque tab selection, HTTP(S)-only navigation, semantic visible-control resolution, bounded waits, page observation, click dispatch reporting, guarded fill/read-back, hover, file chooser upload, browser download events, screenshots, and redacted DOM diagnostics. It contains no Google Flow selectors or application behavior.

The CDP adapter is covered by fake-transport tests that run without Chrome or a Google account. Those tests verify gateway mechanics, not real Chromium behavior. No authorized CDP session was available during this Phase 2 implementation, so live CDP and Flow UI behavior remain **BLOCKED / unverified**. Flow-specific target assumptions are centralized in `providers/google-flow` and must be rechecked against the user's current visible UI.

## Gateway contract

- `tabs()` returns stable opaque IDs for the life of the attached Playwright connection. `selectTab(id)` makes the target explicit. If the selected tab disappears while several tabs remain, operations fail until a tab is selected again.
- `open(url)` only navigates to `http:` or `https:` pages; callers may request a new tab. URL query strings and fragments are omitted from diagnostic tab/page URLs.
- `discoverPage()` returns visible semantic elements but omits editable form contents from element names/text. `resolve()` and `fill()` results likewise do not return prompt text; fill returns lengths only. `observe()` adds a bounded visible-text snapshot because provider correlation needs visible page context; callers must never log or persist that text indiscriminately.
- `resolve()` matches accessible name/text/role and requires uniqueness. By default it excludes disabled controls; `includeDisabled: true` is for read-only state inspection, while `enabled: false` selects disabled controls. `waitFor()` polls a semantic query until it matches or the timeout expires.
- `click()` uses Playwright's visible locator click and distinguishes `dispatched` from `verified`. A click can be dispatched without a visible URL/title/text change; consumers must not equate dispatch with provider acceptance. The Flow provider classifies an unverified post-Generate state as `FLOW_TIMEOUT` with uncertain submission, then inspects the existing attempt before any recovery decision.
- `fill()` verifies the before/after value internally but returns only lengths, never the text. An optional `expectedBeforeValue` provides a compare-before-write guard so a concurrent change is not silently overwritten.
- `hover()`, `upload()`, and `download()` act through visible UI controls and Playwright file chooser/download events. Upload paths must be local regular files selected by the caller. Download filenames are generated locally and do not trust provider-suggested paths. Upload/download transport errors use `BrowserGatewayError`, including a typed timeout flag, without forwarding Playwright's raw error text.
- `sessionId` is a non-secret hash of the CDP endpoint origin. Endpoint path/query/userinfo are not included in that ID.
- `domDiagnostics()` intentionally omits live form values, labels/placeholders, page text, and raw element HTML; it returns structural tags/roles/types only. The adapter never reads cookies or browser storage.

## Safety boundary

- Use only a browser session the user has explicitly authorized.
- Authentication remains manual. Do not automate sign-in, CAPTCHA, security challenges, provider restrictions, or account selection.
- Do not extract, persist, or log cookies, passwords, tokens, or session secrets. Do not print raw CDP endpoint strings or query-bearing page URLs.
- Do not call private or undocumented provider APIs/endpoints.
- Do not run generation in ordinary tests or CI. A live generation can consume quota and requires an explicit user-authorized action.
- Stop on unclear authentication, changed UI, ambiguous provider state, or uncertain result correlation; never resubmit blindly.

Keep CDP exposure local and protected. Use a dedicated browser profile for development. Do not commit profile/session files, screenshots, or private project data.

## Diagnostics and tests

- `apps/browser-gateway` prints sanitized endpoint/page summaries, redacted semantic labels, and redacted DOM diagnostics.
- `apps/browser-gateway` `test:fill` is a manual prompt-editor fill/clear check. It refuses to overwrite non-empty text, uses the compare-before-write guard, reports lengths rather than the prompt, and never dispatches Generate.
- `providers/google-flow` `test:prompt` checks the Flow session, fills a marked prompt only into an empty editor, verifies the enabled Generate control, and clears the prompt. It does **not** dispatch Generate.
- `packages/browser/test/cdp.test.mjs` uses an injected fake CDP transport to test tab selection, semantic resolution with disabled-control matching (`includeDisabled`, `enabled: false`), bounded `waitFor` polling, click dispatch versus verification, guarded fill with length-only results, hover, upload/download events, typed download timeouts, contenteditable-text omission from discovery/resolve/diagnostics, navigation restrictions, and disconnect. It requires neither Chrome nor a Google account and does not prove live provider UI behavior.

Run the deterministic browser gateway tests with:

```sh
corepack pnpm --filter @flowforge/browser test
```

The manual scripts require a local CDP endpoint and a deliberately prepared, user-authorized page. Never use them on a sign-in form or a page with private text in the prompt editor.

## Phase 2 status and next validation

Generic gateway operations and their fake tests are implemented. The opt-in Google Flow generation/download smoke test is separate from ordinary tests; it must be run only with the user's authorized manually authenticated session. In this checkout there is no such session, so live Flow behavior has not passed and remains **BLOCKED**.

See [docs/google-flow-provider.md](./google-flow-provider.md), [ARCHITECTURE.md](../ARCHITECTURE.md), [FEATURE_MATRIX.md](../FEATURE_MATRIX.md), [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md), and [DECISIONS.md](../DECISIONS.md).
