# Browser Gateway

## Purpose and status

`packages/browser` contains a provider-independent `BrowserGateway` interface and a Playwright `connectOverCDP` implementation. `apps/browser-gateway` is currently a local developer diagnostic, not an API/server or a production worker. The gateway can connect to a browser CDP endpoint, list tabs, inspect the first page, resolve semantic-like targets, fill/click targets, capture screenshots, and report DOM diagnostics. The current CLI invokes discovery and DOM diagnostics but does not capture a screenshot.

The gateway/provider interfaces are TypeScript-buildable, but the live CDP behavior has not been validated in this checkout: no browser session was attached during the Phase 0 audit. Current UI assumptions must be treated as unverified and may change with Google Flow.

## Safety boundary

- Use only a browser session that the user has explicitly authorized for this work.
- Do not attempt authentication, CAPTCHA, security-control, or provider-restriction bypass.
- Do not extract, persist, or log cookies, passwords, tokens, or session secrets.
- Do not call private or undocumented Google Flow endpoints.
- Do not run generation as part of ordinary tests or CI. A live generation can consume account quota and must be an explicit user-authorized action.
- Stop and report a blocked or ambiguous state; never retry in a way intended to evade provider restrictions.

Use a dedicated browser profile for development and keep CDP exposure local and protected. Never commit session files or screenshots that contain private project/account data.

## Existing manual scripts

- `apps/browser-gateway` start script prints connection state, tabs, first-page discovery, target-resolution diagnostics, and read-only DOM diagnostics.
- `test:fill` fills a matching contenteditable textbox with a test string and clears it afterwards. It changes page state; run only on a deliberately prepared test page.
- `providers/google-flow` `test:prompt` prepares and clears a test prompt, then checks whether a Generate control's enabled state changes. It does **not** dispatch Generate. Its assumptions are not a stable or verified Google Flow contract.

These are manual smoke scripts requiring an available CDP session, not automated browser tests. The latter should be added against controlled local fixtures before any live UI integration is considered complete.

## Next steps

1. Introduce a fake/test browser implementation and controlled pages for `BrowserGateway` tests.
2. Add explicit session/page selection and an allowlist for supported navigation.
3. Centralize provider target definitions in the Google Flow adapter; keep generic browser mechanics provider-neutral.
4. Add observation/wait, upload, download, and bounded diagnostic capture only behind tested interfaces.
5. Validate any live UI flow as an opt-in manual check on the user's authorized session. If submission/result state cannot be observed safely, pause rather than infer success or resubmit.

See [ARCHITECTURE.md](../ARCHITECTURE.md), [FEATURE_MATRIX.md](../FEATURE_MATRIX.md), and [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) for the full architecture and delivery gates.
