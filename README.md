# FlowForge

FlowForge is an independent AI video production operating system.

The first integration is Google Flow through a user-owned Chrome session. FlowForge does not require or assume a private Google Flow API. Browser automation is isolated behind a provider adapter so the rest of the system remains provider-agnostic.

## Architecture

- apps/api — orchestration API
- apps/web — future dashboard
- apps/browser-gateway — Chrome/CDP boundary
- packages/core — domain contracts
- packages/browser — browser abstractions
- packages/events — event contracts
- packages/queue — job state contracts
- packages/providers — provider interfaces
- providers/google-flow — Google Flow adapter
- docs — architecture and operational notes

## Safety boundary

The browser gateway operates only on a user-authorized browser session. Credentials and session data are never committed to the repository.

## Status

Phase 0A: repository foundation and Browser Gateway contract.
