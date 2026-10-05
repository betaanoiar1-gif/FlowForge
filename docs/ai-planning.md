# AI-assisted planning (Phase 4C)

One sentence carries the whole design:

> **AI proposes. The deterministic planner normalizes. Phase 4A validates. Lifecycle services decide state. Execution is still outside Phase 4C.**

Everything below is a consequence of that sentence. A model may decide *what the piece should be about and in
what order it should happen*; it may not decide ids, durations beyond what it explicitly asked for per scene,
specifications, capabilities, references, continuity structure, fingerprints, statuses, or whether anything
runs. There is exactly one planning engine in FlowForge — the Phase 4B deterministic planner — and the AI
path is a way of *feeding* it, never a second way of planning.

```
CreativeBrief + project definitions
        │
        ▼
AIPlannerService ── builds AIPlanningRequest (names, brief text, capability envelope, guidance)
        │
        ▼
AIPlanner port ──── provider adapter (providers/openai-chat today) → AIPlanningResponse
        │
        ▼
validateProposal ── versioned schema, strict unknown-field refusal  ──┐ invalid → typed failure, no write
        │                                                            │
        ▼                                                            │
translateProposal ─ names → ids, beats, cast/world claims, options ──┘ unresolved → typed failure, no write
        │
        ▼
PlannerService.plan()  ← Phase 4B: the only author of plan rows
        │
        ▼
Phase 4A validation → ProductionPlanVersion → DRAFT / VALIDATED / APPROVED / EXECUTABLE
        │
        ▼
(nothing). Jobs, queue, providers, browser, assets, and publishing are not in this path.
```

## 1. What Phase 4C added, and what it may not add

Added: the `AIPlanner` port and `PlanningProposal` types in `packages/core` (`src/ai-planning.ts`); the
proposal schema validator, translation, fingerprints, and orchestration service in `packages/services`
(`src/ai-planner/`, `src/ai-planner-service.ts`); AI provenance columns in `packages/storage` (schema v6);
one provider implementation in `providers/openai-chat`; and one operator command, `flowforge planner ai-run`.

Not added, deliberately: a second planner, a plan-execution command, any call into `GenerationService`, job
creation, queue submission, Google Flow or browser access, asset download, rendering, publishing, analytics,
an event bus, autonomous agent loops, arbitrary tool calling, or a web UI. `mapPlanToJobs` still has no
caller in any command, and the adapter receives no object through which it could reach any of the above: its
input is data and its output is data.

## 2. The port

```ts
interface AIPlanner {
  readonly id: string;            // provenance identity, e.g. "openai-chat"
  readonly adapterVersion: string; // bump when prompting or parsing semantics change
  readonly provider: string;       // protocol family, e.g. "openai-compatible"
  readonly model: string;          // as configured; never invented by the adapter
  readonly schemaVersion: string;  // must equal AI_PLANNING_SCHEMA_VERSION
  propose(request: AIPlanningRequest): Promise<AIPlanningResponse>;
}
```

Rules that make the port safe to hold:

- **Domain-neutral.** `packages/core` names no vendor. "OpenAI", "Anthropic", "Gemini", and "KiosAPI" appear
  in provider packages and their configuration, not in the domain or the services. A vendor-specific concept
  only enters `core` if it is genuinely a domain concept; none was needed here.
- **Data in, data out.** The request carries the brief's text, the project's character/world/visual-DNA
  *names*, the capability envelope, and the operator's guidance. It carries no repository, queue, provider
  registry object, browser, credential, or endpoint — an adapter that wanted those was asking to plan
  outside the boundary that makes it optional.
- **Two outcomes only.** `AIPlanningResponse` is `AIPlanningSuccess` (a document, typed `unknown`, because
  only the validator may decide it is a proposal) or `AIPlannerFailure` (a code from a closed list, a message,
  and whether retrying could help). Prose is a failure. Partial answers are a failure. An adapter must never
  invent required content the model omitted.
- **`propose` does not throw.** Transport problems become `AI_*` codes; a thrown error is still handled
  (`AI_FAILED`) with the message sanitized, because providers echo request details back at their clients.
- **No retries inside the adapter.** Retryability is reported, never acted on: resending a paid request is
  the operator's decision.

`AiPlannerService` is the only caller. `PlannerService.plan()` remains the only author of plan rows. The
service owns no transaction, opens no write, and mutates no lifecycle status; it delegates persistence
entirely, which is why dry runs, reuse, write-once provenance, and validation behave exactly as they do for
a hand-authored or deterministic run.

## 3. The proposal schema

`AI_PLANNING_SCHEMA_VERSION = "ai-planning-proposal-v1"`. A proposal declares it and must match it exactly;
an adapter that cannot say which schema it wrote is unusable. Structure:

| Field | Required | Meaning after planning |
| --- | --- | --- |
| `schemaVersion` | yes | refused outright if it is not `ai-planning-proposal-v1` |
| `story.premise` | yes | `plan_stories.premise` |
| `story.beginning` / `development` / `ending` | yes | the three story movements, verbatim (tidied) |
| `story.structure` | no | omitted → the planner derives a structure from the brief, as it always has |
| `story.themes` | no | `plan_stories.themes` |
| `scenes[]` | yes, 1–`maxScenes` | one explicit beat each → one scene plan, in the proposed order |
| `scenes[].title` | yes | scene plan title |
| `scenes[].intent` | yes | scene plan narrative purpose |
| `scenes[].emphasis` | no | weight handed to `duration-allocation` (`establish`/`develop`/`resolve`) |
| `scenes[].durationMs` | no | honoured as an *explicit* beat duration; never used to set the piece's budget |
| `scenes[].characters[]` | no | character **names** → cast assignments |
| `scenes[].world` | no | world name → scene world binding |
| `scenes[].kinds[]` | no | requested spec kinds; the capability rule may refuse one |
| `scenes[].continuity` | no | a `ScenePlanContinuity` statement, wording preserved |
| `scenes[].constraints[]` | no | echoes of brief constraints only; a new one is a failure |
| `visualDna` | no | visual-DNA name → the version's DNA binding |
| `logline` | no | read by the operator, not planned |
| `constraints[]` | no | `{kind, value}` pairs, each required to exist in the brief |

Bounds live in core as `AI_PROPOSAL_LIMITS` — `maxScenes` 24, `maxCharactersPerScene` 12, `maxTitle` 200,
`maxText` 4000, `maxNote` 600, `maxDurationMs` 600000 — and are the single table from which both FlowForge's
validator and the provider-side wire schema are rendered. The bounds cap the *document*, not the piece: a
longer proposal is refused rather than truncated, so a plan can never be a clipped version of an answer.

### Strictness policy

Unknown fields are **errors**, at every level (`$`, `$.story`, `$.scenes[i]`, `$.constraints[i]`). A model
that invented a field is describing a domain FlowForge does not have; accepting it silently would make the
proposal the source of truth about the schema. Consequences:

- a provider that ignores `additionalProperties: false` still gets refused here;
- field *order* is irrelevant (canonical JSON is used for digests), while *unknown* fields are fatal;
- text is tidied through the planner's own `tidyText`, so whitespace is never a content difference, and
  over-long or empty-after-trimming text is a typed issue, not a silent truncation;
- `durationMs` must be a whole number of milliseconds within `[1000, maxDurationMs]` — a fractional value is
  a `TYPE` violation and a negative or over-cap value is a `RANGE` one;
- issues are collected in full and sorted by path, so an operator sees every problem in one report and the
  same malformed answer always produces the same report.

## 4. Translation: proposal → `PlannerInput`

`translateProposal` is the only translation an AI answer ever gets. Six rules, in order of consequence:

1. **Names, never ids.** Resolution is exact after trimming and case-insensitive; a project id is also
   accepted. Unknown → `AI_PROPOSAL_UNKNOWN_CHARACTER` / `_WORLD` / `_VISUAL_DNA`. Two definitions sharing a
   name → `AI_PROPOSAL_INVALID` ("matches more than one character"), because picking the first match would let
   a model plan an entity the operator did not mean.
2. **Nothing is invented.** Anything the schema required and the answer omitted was already refused;
   translation supplies no premise, title, duration, world, or DNA.
3. **Explicit beats.** The scene list becomes the planner's *explicit* beats, so ordering is the proposal's
   while key allocation, duration distribution, spec composition, references, and continuity structure remain
   the rules'. Beat keys are deduplicated with the planner's own `-2` suffix policy so two scenes sharing a
   title cannot blur a cast or world claim.
4. **Duration intent is per scene, never for the piece.** Even when every scene declares a duration, the
   plan's total budget stays the operator's option — summing a model answer would let the route decide how
   long the piece is.
5. **Brief constraints are the only constraints.** A proposal may echo them (the echo is checked once, not
   per scene); an invented `kind`/`value` pair is `AI_PROPOSAL_CONSTRAINT_UNKNOWN`. Creative rules come from
   the brief, which the operator authors.
6. **Stable plan identity.** `planTitle` comes from the command, never from `proposal.title`, because plan
   identity is `(project, brief, title)`: a model that words a title differently each run would fork a
   *plan*, not a version. Only `--plan-title` forks a plan.

Cast is declared from the whole project roster (as a hand-authored run would) with roles taken from each
character's `traits.role`; scene-level `characters` win per beat. Every project world is handed over with the
beats that claimed it, so `world-binding` decides ambiguity by its existing rule rather than by a guess here.

## 5. Determinism boundary

AI planning is **not** deterministic planning, and the code says so in three ways:

- **The engine is untouched.** All 12 rules, their order, seed handling, ids, and fingerprints run exactly as
  they do for `planner run`. `PLANNING_RULES_VERSION` stays `planning-rules-v1`: Phase 4C added one optional
  *input* channel (`StoryBeatInput.continuityNote`), which is a widening of the accepted grammar, not a
  change of any rule — every input that does not use it produces byte-identical output, which
  `test/planner-engine.test.mjs` proves by keeping its 15 golden expectations green.
- **AI metadata stays out of plan content.** `ai_*` provenance columns and the AI trace steps are outside
  `content_hash` and outside `plannerInputFingerprint`/`plannerOutputFingerprint`. Two consequences: an
  adapter's identity can never change a plan, and a plan's content cannot be laundered by re-running an
  adapter. The test that pins this is cross-route equality — the same intent proposed by a fake adapter and
  authored by hand produces the same input and output fingerprints, and in one project the hand-authored run
  is recognised as *unchanged content* and writes nothing.
- **Volatility is digested, not trusted.** `requestFingerprint` covers the structured context (so an identical
  question is recognisable); `responseFingerprint` covers the document as received, before validation;
  `proposalFingerprint` covers the accepted, tidied proposal. Digests use `fingerprintJson` under namespaced
  prefixes (`flowforge:ai-planner-request:v1`, `-proposal:v1`, `-response:v1`) so an AI digest can never be
  mistaken for a planner id. Nothing pretends the model is reproducible: a live call may answer differently
  every time, and the run is recorded as the answer it actually got.
- **Seed and temperature are different knobs.** `--seed` is the planner's, bounded as in Phase 4B
  (`0…4294967295`), and it changes tie-breaking inside the deterministic rules. Adapter sampling
  (`temperature`, `max_tokens`) is provider configuration: it changes what the model *proposes*, never how a
  proposal is planned, and it is deliberately absent from `PlannerInput`.

## 6. Provenance and trace

Every persisted version records, once and immutably, enough to answer: *was an AI involved, which adapter and
model, which schema, what was asked, what was accepted, what came back, did it fall back, and what did
validation decide?*

| Column | Content |
| --- | --- |
| `ai_adapter`, `ai_adapter_version`, `ai_provider`, `ai_model` | who answered, by identity, not by URL |
| `ai_schema_version` | which proposal contract the answer claims to satisfy |
| `ai_path` | `ai-adapter` or `deterministic-fallback` |
| `ai_request_fingerprint`, `ai_proposal_fingerprint` | the question and the accepted answer |
| `ai_response_fingerprint` | the answer as received, nullable (a refusal may have produced nothing) |
| `ai_fallback` | whether the operator's explicit fallback was used |

The rules mirror Phase 4B's provenance exactly, because they answer the same failure modes:

- **Additive only.** Schema v6 adds ten nullable columns; nothing is rebuilt or rewritten, and v5 databases
  migrate in place. A version nobody proposed with an AI keeps all ten `NULL` — that is how a hand-authored
  or deterministic version stays distinguishable from an AI-planned one.
- **All-or-nothing.** The complete-set triggers (on INSERT and UPDATE) refuse half a tuple; the one exempt
  column is `ai_response_fingerprint`, because "no response to digest" is a real state.
- **Write-once.** The identity columns cannot be amended, so an old plan stays attributable to the route that
  wrote it. The only permitted back-fill is a response digest, added later from an archived response; that is
  an addition, not a rewrite of who was asked or what was accepted.
- **Reuse records nothing new.** When the planner recognises unchanged content it writes no version and so
  attaches no new AI record — the result says `provenanceRecorded: false` with the reason, rather than
  implying the attempt was recorded.
- **`version.ai` carries no trace.** The AI stages travel in the version's single `plannerTrace`, in execution
  order: `AI_REQUEST`, `AI_RESPONSE`, `AI_SCHEMA_VALIDATION`, `NORMALIZATION`, then the rule steps, then
  `DOMAIN_VALIDATION` with the stored verdict. A second trace table would be a second history to disagree with
  the first. `includeTrace: false` suppresses the AI steps exactly as it suppresses the rule steps, and
  identity columns still record: provenance is not a trace.

**Retention.** FlowForge persists digests and sanitized summaries, never prompt bodies, response bodies,
headers, or provider request ids. Raw prompts are the operator's to keep elsewhere if they want them; the
digest is what makes a later re-derivation checkable. Nothing in this phase grows a prompt archive, because
raw model text is where credentials and project secrets end up hiding.

## 7. Security boundary

- Credentials are read from an environment variable **by name at call time** (`FLOWFORGE_AI_API_KEY` by
  default, selectable with `--ai-key-env`) and placed in one request header. No key, token, cookie, header,
  or base URL with a secret path is stored on the adapter instance, written to SQLite, printed by the CLI, or
  included in a failure.
- Every message that can reach storage or stdout passes through a sanitizer that removes credential-shaped
  fragments (authorization/bearer/token/secret material, `sk-…` keys, long opaque tokens) and URL
  authorities, and truncates. An adapter's error text is never stored verbatim.
- Responses are bounded twice: the adapter caps the body in bytes before parsing (`maxResponseBytes`) and the
  validator caps the document's structure and text lengths. A runaway endpoint cannot make FlowForge buffer or
  parse unbounded text on a planning call.
- Timeouts are enforced with `AbortSignal.timeout`, so a hung endpoint becomes `AI_TIMEOUT` rather than a
  wedged planning command.
- There is no tool calling, no function execution, no URL fetching on the model's advice, and no
  "let the model decide whether to run it" step. The proposal is inert data whose only possible effect is
  becoming planner input.
- The live smoke is optional and never part of build, typecheck, test, or the vertical slice. Ordinary tests
  use injected transports or a loopback server; nothing in CI can reach a provider account.

## 8. Failure model

Three vocabularies for three questions. They are kept apart on purpose so nobody has to guess which boundary
spoke.

- **Could the adapter answer?** `AIPlannerErrorCode` (core): `AI_CREDENTIAL_MISSING`, `AI_UNAVAILABLE`,
  `AI_TIMEOUT`, `AI_HTTP_ERROR`, `AI_EMPTY_RESPONSE`, `AI_TRUNCATED`, `AI_INVALID_JSON`, `AI_SCHEMA_MISMATCH`,
  `AI_REFUSAL`, `AI_FAILED`.
- **Was the answer a valid proposal for this project?** schema issue codes (`SCHEMA_VERSION`, `MISSING`,
  `EMPTY`, `TYPE`, `RANGE`, `UNKNOWN_FIELD`, `DUPLICATE`, `TOO_MANY`) with JSON-ish paths, plus
  `AI_PLANNING_ERROR_CODES` (services): `AI_PROPOSAL_INVALID`, `AI_PROPOSAL_EMPTY`,
  `AI_PROPOSAL_UNKNOWN_CHARACTER`, `AI_PROPOSAL_UNKNOWN_WORLD`, `AI_PROPOSAL_UNKNOWN_VISUAL_DNA`,
  `AI_PROPOSAL_CONSTRAINT_UNKNOWN`, `AI_FALLBACK_NOT_REQUESTED`.
- **Is the resulting plan sound?** the Phase 4A `PlanningFindingCode` catalogue and the planner's own
  `PLANNER_*` notices — unchanged, and still the only answer that decides whether a version is validatable.

Every AI-planning failure path shares one property: **nothing is written.** No version, no forked plan, no
half-attached provenance, and no patched-over field. `AI_PLANNER_NOT_CONFIGURED` (thrown, not returned) is the
only case where the process cannot answer at all: no adapter is wired, so the command fails with guidance to
configure one or to use `planner run`.

## 9. Idempotency, dry run, and fallback

Two identities must not be confused:

- **AI-invocation identity** — the response digest, per attempt, volatile by nature.
- **Normalized planning identity** — the planner's input and output fingerprints over the *accepted* proposal.

Equivalent normalized proposals therefore reuse Phase 4B's behavior exactly: two attempts whose accepted
content matches produce one version and a second run that writes nothing (`reused: true`), even though the
adapters' wording differed. Differing accepted content stays distinguishable and forks a new version — the
planner never collapses two plans that differ, and never invents a difference where the content is equal.

`--dry-run` really calls the model, then validates, translates, plans, and reports fingerprints, scene counts,
and what validation would say — and commits nothing: no plan, no version, no validation row, no provenance, no
job, no queue entry. It is honest about its limits: a dry run is *not* a promise that a later call produces the
same answer, because the provider is nondeterministic. The report is labelled as an attempt against the state
as it stood at that moment.

`fallback` is explicit or absent: `"none"` (default) fails the run; `"deterministic"` plans the operator's own
`--story-json`/`--cast-json`/`--worlds-json` input through `planner run`'s rules. A fallback version still
records the attempt — `ai_path = deterministic-fallback`, `ai_fallback = 1`, and the refusal digest as the
proposal fingerprint — so an audited plan never hides that an AI route was tried first.

## 10. Operator surface

```bash
flowforge planner ai-run --project-id pilot [--brief-id ID] [--plan-title TEXT]
  [--ai-adapter openai-chat] [--ai-model NAME] [--ai-base-url URL] [--ai-key-env NAME]
  [--guidance-json JSON] [--options-json JSON] [--seed N] [--scenes N] [--duration-ms N]
  [--story-json JSON] [--cast-json JSON] [--worlds-json JSON] [--visual-dna-id ID]
  [--providers CSV] [--fallback deterministic] [--dry-run] [--trace] [--approve] [--reviewer NAME]
```

Flags are `--flag=value` or `--flag value`; unknown flags are refused (exit 2). `--guidance-json` carries
`{sceneCount, totalDurationMs, aspectRatio, notes, themes}` — bounds and notes for the adapter, not
instructions to a person. `--story-json` and friends are used **only** by `--fallback=deterministic`.

Exit codes: `0` planned and valid; `2` usage or configuration error; `3` the request was well formed but
nothing usable came of it (proposal refused, adapter failed, validation refused) — the same blocked-exit policy
Phase 4A/4B use; `1` a programming or persistence error. `--json` emits the same read model the human
renderer reads from, including `ai` (adapter, provider, model, path, fallback, three fingerprints,
`provenanceRecorded` and why not), `notices`, `findings`, `errors`, and `trace`.

Every run ends with the boundary restated: *planning only — no generation job was created, nothing was
enqueued, and nothing was executed.* There is no `planner execute`, no `planner ai-execute`, and no
`--execute` flag, and the CLI tests assert their absence so a later phase cannot add one by accident.

## 11. The shipped adapter: `providers/openai-chat`

`@flowforge/provider-openai-chat` implements `AIPlanner` against an OpenAI-compatible `chat/completions`
endpoint. It is the one provider path in this phase, and it is replaceable: another adapter needs only to
satisfy the port, and nothing in core, services, or storage changes.

| Configuration | Default | Notes |
| --- | --- | --- |
| `--ai-model` / `model` | `gpt-4o-mini` | recorded in provenance as configured |
| `--ai-base-url` / env `FLOWFORGE_AI_BASE_URL` | `https://api.openai.com/v1` | printed only as `protocol//host` |
| `--ai-key-env` / env `FLOWFORGE_AI_KEY_ENV` | `FLOWFORGE_AI_API_KEY` | the variable's *name* is configurable; its value never is |
| `timeoutMs` | 60000 | becomes `AI_TIMEOUT` |
| `maxResponseBytes` | 512000 | enforced while streaming |
| `temperature` | 0.2 | sampling looseness is adapter config, never the planner seed |
| `responseFormat` | `json_schema` | `json_object` puts the schema in the prompt instead |

It asks for `flowforge_planning_proposal` with `strict: true`, `additionalProperties: false`, and the shared
bounds, and its system prompt states the contract: order and intent are yours to propose, ids and technical
fields are not, an unusable answer is refused rather than repaired, and nothing you say is executed. The
prompt contains no timestamp, no counter, and no secret, so an identical request serializes identically —
which is what makes `requestFingerprint` meaningful.

A smoke test against a real endpoint is a documented manual step
(`corepack pnpm --filter @flowforge/provider-openai-chat build && node -e …`), never a gate. Its absence from
CI is deliberate: a build that needs a paid API is a build nobody can verify.

## 12. Property → test map

| Property | Test |
| --- | --- |
| an accepted proposal becomes an ordinary, validated plan version | `packages/services/test/ai-planner.test.mjs` — "planned by the deterministic engine and validated as ordinary plan state" |
| the trace carries the AI stages around the unchanged rule steps | same test, stage-order assertion |
| the request carries names and context, never ids or credentials | same test, request-shape assertions |
| AI route ≡ hand-authored route for the same content | "an AI proposal and the equivalent hand-authored input produce the same plan content and fingerprints" |
| unknown or ambiguous names fail closed with nothing written | "a proposal that names what the project does not have…", "an ambiguous reference is refused rather than guessed" |
| prose, empty, over-long, malformed answers are refused | "arbitrary prose is a failure…", "the schema validator is strict about fields, bounds, and emptiness" |
| a capability the providers do not declare is not planned into existence | "the model cannot plan a scene the domain would not accept…" |
| adapter refusals and thrown adapters are typed failures | "adapter refusals surface as typed failures…", "an adapter that throws is reported as a failure, not a crash" |
| fallback happens only when asked, and is recorded | "the deterministic route happens only when the operator asked for it, and says so" |
| dry run writes nothing, including provenance | "a dry run reports everything and writes nothing…" |
| equivalent proposals reuse; differing ones fork | "equivalent proposals are idempotent, differing ones stay distinguishable", "whitespace-only differences…" |
| provenance holds digests and identity only, never secrets | "the version records who was asked and what was accepted…" |
| `includeTrace:false` suppresses steps, not identity | "includeTrace:false records no steps…" |
| AI metadata stays outside `content_hash` | "AI metadata stays outside the deterministic content hash…" |
| no execution state is touched | "nothing about a proposal may reach execution state" |
| v6 columns, complete-set and write-once triggers | `packages/storage/test/planner-provenance.test.mjs` (three v6 tests) |
| the 4B engine is unchanged by the new input channel | `packages/services/test/planner-engine.test.mjs` (15 tests, goldens intact) |
| adapter contract: bounds, redaction, transport mapping, no-send cases | `providers/openai-chat/test/openai-chat-adapter.test.mjs` (14 tests, incl. a loopback socket) |
| CLI: happy path, dry run, exit 3, usage errors, trace, no execution verb | `apps/cli/test/ai-planner-cli.test.mjs` (7 tests) |

## 13. Changing this phase

- A new adapter is a new package implementing `AIPlanner`, plus a line in `AI_ADAPTERS` in
  `apps/cli/src/runtime.ts`. It must not receive a repository, queue, worker, or browser, and it must not
  invent a proposal field.
- A new proposal field means: core type, `AI_PROPOSAL_LIMITS` if bounded, schema validator entry,
  `AI_PLANNING_PROPOSAL_FIELDS`/`PROPOSAL_FIELDS`, the adapter's wire schema, a translation rule, a golden
  test — and a decision about whether it belongs to the *domain* at all.
- A change to prompting or parsing semantics bumps `OPENAI_CHAT_ADAPTER_VERSION`; a change that alters how a
  proposal becomes planner input bumps `PLANNING_RULES_VERSION` and the planner's goldens together.
- Nothing in this file may become an execution path. The first command that turns a proposal into a submitted
  job has to arrive as its own phase, with its own review — not as a flag here.

Related: [docs/planner-engine.md](planner-engine.md) for the engine and its rule set,
[docs/planning-domain.md](planning-domain.md) for the aggregate, lifecycle, and validation catalogue,
[docs/application-services.md](application-services.md) for service responsibilities, and
[docs/google-flow-provider.md](google-flow-provider.md) for why live execution remains a separate, still
unvalidated concern.
