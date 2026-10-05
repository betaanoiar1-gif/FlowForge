import {
  AI_PLANNING_SCHEMA_VERSION,
  AI_PROPOSAL_LIMITS,
  GENERATION_SPEC_KINDS,
  type AIPlanner,
  type AIPlannerErrorCode,
  type AIPlanningRequest,
  type AIPlanningResponse,
} from "@flowforge/core";

/**
 * The OpenAI-compatible chat adapter (Phase 4C) — FlowForge's one shipped provider path for AI planning.
 *
 * It implements `AIPlanner` and nothing else: it builds a request body, asks for a JSON answer conforming
 * to the versioned proposal schema, parses it, and hands the document back. It writes no SQL, mints no
 * ids, mutates no lifecycle, and cannot reach a queue, a worker, or a browser — the port it implements
 * has no such capability to begin with. Whether an answer becomes a plan is decided by the service
 * validator and the deterministic planner, not here.
 *
 * Why this file names "OpenAI" while `packages/core` does not: a vendor is a *provider implementation*,
 * which by FlowForge's rule belongs outside the domain. The domain's vocabulary is `AIPlanner`; anything
 * else — a self-hosted model, another vendor, a future SDK — is welcome as long as it satisfies the same
 * port, and swapping it changes provenance strings and nothing else.
 *
 * Credentials are read from an environment variable *by name* at call time and placed in one request
 * header. They are never stored on the instance, never returned, never logged, and never included in a
 * failure message: every message this adapter can produce has passed through `redact()`, which removes
 * bearer fragments, URL authorities, and long opaque tokens — because providers echo request details back
 * at their clients, and an adapter that forwarded those verbatim would leak the key it just used.
 */

export const OPENAI_CHAT_ADAPTER_ID = "openai-chat";
/** Identity recorded in provenance; a wire-contract change here is an adapter-version change, not a domain change. */
export const OPENAI_CHAT_ADAPTER_VERSION = "openai-chat-adapter-v1";

export const OPENAI_CHAT_DEFAULTS = Object.freeze({
  model: "gpt-4o-mini",
  baseUrl: "https://api.openai.com/v1",
  /** Name of the environment variable holding the key. Never the key itself. */
  apiKeyEnv: "FLOWFORGE_AI_API_KEY",
  timeoutMs: 60_000,
  maxResponseBytes: 512_000,
  maxTokens: 4096,
  /**
   * Sampling temperature is *adapter configuration*, not the planner's seed. The seed belongs to
   * `PlannerInput` and controls the deterministic rules; this controls how loose the model is allowed to
   * be, and changing it changes what the model proposes, never how a proposal is planned.
   */
  temperature: 0.2,
});

export type OpenAiChatResponseFormat = "json_schema" | "json_object";

export interface OpenAiChatPlannerOptions {
  model?: string;
  /** Base URL without the `/chat/completions` suffix. */
  baseUrl?: string;
  /** Environment variable to read the key from. Defaults to `FLOWFORGE_AI_API_KEY`. */
  apiKeyEnv?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: OpenAiChatResponseFormat;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Extra top-level body fields, for endpoint dialects (e.g. a deployment-specific flag). */
  extraBody?: Record<string, unknown>;
}

/**
 * The proposal schema, rendered for the wire. Bounds come from `AI_PROPOSAL_LIMITS` in core, which is the
 * same table the service validator enforces — so a provider that honoured every constraint here would
 * still be checked against identical numbers there. `additionalProperties: false` is not decoration: it
 * is the reason a model that invents a field is refused rather than quietly accommodated.
 */
export function planningProposalJsonSchema(): Record<string, unknown> {
  const text = (maxLength: number, description: string) => ({
    type: "string",
    maxLength,
    description,
  });
  const stringList = (maxLength: number, description: string) => ({
    type: "array",
    maxItems: AI_PROPOSAL_LIMITS.maxScenes,
    items: text(maxLength, description),
  });
  const nameRef = text(AI_PROPOSAL_LIMITS.maxTitle, "An exact name from the context lists. Never an id.");
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "story", "scenes"],
    properties: {
      schemaVersion: { type: "string", const: AI_PLANNING_SCHEMA_VERSION },
      story: {
        type: "object",
        additionalProperties: false,
        required: ["premise", "beginning", "development", "ending"],
        properties: {
          premise: text(AI_PROPOSAL_LIMITS.maxText, "One-sentence premise."),
          structure: { type: "string", maxLength: AI_PROPOSAL_LIMITS.maxText },
          themes: stringList(AI_PROPOSAL_LIMITS.maxText, "Themes, in order of importance."),
          beginning: text(AI_PROPOSAL_LIMITS.maxText, "What is established and why it matters."),
          development: text(AI_PROPOSAL_LIMITS.maxText, "How tension escalates."),
          ending: text(AI_PROPOSAL_LIMITS.maxText, "The resolution, including what changes."),
        },
      },
      scenes: {
        type: "array",
        minItems: 1,
        maxItems: AI_PROPOSAL_LIMITS.maxScenes,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "intent"],
          properties: {
            key: text(AI_PROPOSAL_LIMITS.maxTitle, "Stable slug for this scene, used to refer to it elsewhere."),
            title: text(AI_PROPOSAL_LIMITS.maxTitle, "Short scene title."),
            intent: text(AI_PROPOSAL_LIMITS.maxText, "What the scene must accomplish."),
            emphasis: { type: "string", enum: ["establish", "develop", "resolve"] },
            durationMs: {
              type: "integer",
              minimum: 1_000,
              maximum: AI_PROPOSAL_LIMITS.maxDurationMs,
              description: "Optional duration intent in milliseconds. The planner allocates the real budget.",
            },
            characters: {
              type: "array",
              maxItems: AI_PROPOSAL_LIMITS.maxCharactersPerScene,
              items: nameRef,
              description: "Exact character names from the project.",
            },
            world: nameRef,
            kinds: { type: "array", maxItems: GENERATION_SPEC_KINDS.length, items: { type: "string", enum: [...GENERATION_SPEC_KINDS] } },
            continuity: text(AI_PROPOSAL_LIMITS.maxNote, "What must carry into the next scene."),
            constraints: stringList(
              AI_PROPOSAL_LIMITS.maxText,
              'Brief constraints this scene honours, as "kind: value". You may not add new ones.',
            ),
          },
        },
      },
      visualDna: nameRef,
      logline: text(AI_PROPOSAL_LIMITS.maxText, "Optional summary of the direction."),
      constraints: {
        type: "array",
        maxItems: AI_PROPOSAL_LIMITS.maxScenes,
        items: { type: "string", maxLength: AI_PROPOSAL_LIMITS.maxText },
      },
    },
  };
}

export class OpenAiChatPlanner implements AIPlanner {
  readonly id = OPENAI_CHAT_ADAPTER_ID;
  /** `openai-compatible` is the protocol, not the vendor: any endpoint that speaks the chat-completions wire qualifies. */
  readonly provider = "openai-compatible";
  readonly adapterVersion = OPENAI_CHAT_ADAPTER_VERSION;
  readonly schemaVersion = AI_PLANNING_SCHEMA_VERSION;
  readonly model: string;

  readonly #options: Required<Omit<OpenAiChatPlannerOptions, "fetchImpl" | "extraBody">> & {
    extraBody: Record<string, unknown>;
  };
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiChatPlannerOptions = {}) {
    this.#options = {
      model: requiredLabel(options.model ?? OPENAI_CHAT_DEFAULTS.model, "model"),
      baseUrl: trimSlash(options.baseUrl ?? OPENAI_CHAT_DEFAULTS.baseUrl),
      apiKeyEnv: requiredLabel(options.apiKeyEnv ?? OPENAI_CHAT_DEFAULTS.apiKeyEnv, "apiKeyEnv"),
      timeoutMs: positiveInteger(options.timeoutMs ?? OPENAI_CHAT_DEFAULTS.timeoutMs, "timeoutMs", 600_000),
      maxResponseBytes: positiveInteger(
        options.maxResponseBytes ?? OPENAI_CHAT_DEFAULTS.maxResponseBytes,
        "maxResponseBytes",
        8_000_000,
      ),
      maxTokens: positiveInteger(options.maxTokens ?? OPENAI_CHAT_DEFAULTS.maxTokens, "maxTokens", 32_000),
      temperature: boundedNumber(options.temperature ?? OPENAI_CHAT_DEFAULTS.temperature, "temperature", 2),
      responseFormat: options.responseFormat ?? "json_schema",
      extraBody: { ...(options.extraBody ?? {}) },
    };
    this.model = this.#options.model;
    const injected = options.fetchImpl;
    this.#fetch =
      injected ??
      (typeof fetch === "function"
        ? fetch
        : (() => {
            throw new Error("global fetch is unavailable");
          }) as typeof fetch);
  }

  /** Configuration an operator can print. It contains the variable *name*, never a value or a key. */
  describe(): Record<string, unknown> {
    return {
      id: this.id,
      adapterVersion: this.adapterVersion,
      provider: this.provider,
      schemaVersion: this.schemaVersion,
      model: this.#options.model,
      endpoint: describeEndpoint(this.#options.baseUrl),
      apiKeyEnv: this.#options.apiKeyEnv,
      timeoutMs: this.#options.timeoutMs,
      maxResponseBytes: this.#options.maxResponseBytes,
      temperature: this.#options.temperature,
      responseFormat: this.#options.responseFormat,
    };
  }

  async propose(request: AIPlanningRequest): Promise<AIPlanningResponse> {
    if (request.schemaVersion !== AI_PLANNING_SCHEMA_VERSION) {
      // Refused before any network call: asking an endpoint to answer in a dialect FlowForge cannot read
      // would waste the operator's budget on a document that is guaranteed to be rejected.
      return failure(
        "AI_SCHEMA_MISMATCH",
        `This adapter answers in ${AI_PLANNING_SCHEMA_VERSION}; the request asked for ${String(request.schemaVersion)}. No request was sent.`,
      );
    }

    const apiKey = (process.env[this.#options.apiKeyEnv] ?? "").trim();
    if (apiKey.length === 0) {
      return failure(
        "AI_CREDENTIAL_MISSING",
        `No API key is available: set ${this.#options.apiKeyEnv} in this process's environment. FlowForge stores no credentials, so nothing can be retried until the variable is present.`,
        "apiKeyEnv",
      );
    }

    const body: Record<string, unknown> = {
      model: this.#options.model,
      temperature: this.#options.temperature,
      max_tokens: this.#options.maxTokens,
      messages: [
        { role: "system", content: systemPrompt(this.#options.responseFormat) },
        { role: "user", content: JSON.stringify(request) },
      ],
      ...this.#options.extraBody,
    };
    if (this.#options.responseFormat === "json_schema") {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "flowforge_planning_proposal", strict: true, schema: planningProposalJsonSchema() },
      };
    } else {
      body.response_format = { type: "json_object" };
    }

    let raw: string;
    try {
      const response = await this.#fetch(`${this.#options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#options.timeoutMs),
      });
      if (!response.ok) {
        const detail = redact(await readText(response, this.#options.maxResponseBytes));
        return failure(
          httpCode(response.status),
          `The endpoint answered HTTP ${String(response.status)}${
            detail.length === 0 ? "" : `: ${detail}`
          }${response.status === 401 || response.status === 403 ? " — the credential was refused; check the key in the configured environment variable." : ""}`,
          undefined,
          isRetryableStatus(response.status),
        );
      }
      raw = await readText(response, this.#options.maxResponseBytes);
    } catch (error) {
      if (isTimeout(error)) {
        return failure(
          "AI_TIMEOUT",
          `The endpoint did not answer within ${String(this.#options.timeoutMs)} ms. Nothing was written; planning is unchanged.`,
          undefined,
          true,
        );
      }
      // Includes a response over the byte cap: an oversized body is refused before it is parsed.
      return failure("AI_UNAVAILABLE", `The endpoint could not be reached: ${redact(messageOf(error))}`, undefined, true);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return failure(
        "AI_INVALID_JSON",
        "The endpoint answered with something that is not JSON; a planning proposal has to be a structured document.",
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      return failure("AI_EMPTY_RESPONSE", "The endpoint answered with a document that carries no proposal.");
    }
    const record = parsed as Record<string, unknown>;
    const providerError = record.error;
    if (providerError !== undefined) {
      // An error envelope with a 200 status still means the answer is unusable, and the provider's own
      // code may be anything, so the message is the only thing carried forward — redacted, once.
      return failure("AI_FAILED", `The endpoint reported an error: ${redact(stringify(providerError))}`);
    }
    const choice = firstChoice(record);
    if (choice === undefined) {
      return failure("AI_EMPTY_RESPONSE", "The endpoint returned no completion choice.");
    }
    const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
    if (finishReason === "content_filter" || finishReason === "refusal") {
      return failure(
        "AI_REFUSAL",
        "The endpoint declined to answer this brief. Nothing was planned; revise the brief or plan deterministically.",
      );
    }
    if (finishReason === "length") {
      return failure(
        "AI_TRUNCATED",
        "The completion was cut off by the token limit, so the document is incomplete and cannot be judged. Nothing was planned.",
        undefined,
        true,
      );
    }
    const content = contentOf(choice);
    if (content === undefined) {
      return failure("AI_EMPTY_RESPONSE", "The completion carried no content.");
    }
    let proposal: unknown;
    try {
      proposal = typeof content === "string" ? JSON.parse(content) : content;
    } catch {
      return failure(
        "AI_INVALID_JSON",
        "The completion was prose rather than the JSON object the schema requires; a proposal must be structured.",
      );
    }
    return {
      status: "OK",
      proposal,
      meta: {
        ...(typeof record.model === "string" ? { model: record.model } : { model: this.#options.model }),
        ...(finishReason === undefined ? {} : { finishReason }),
        truncated: false,
      },
    };
  }
}

/* -------------------------------------------------------------------------- */
/* request construction                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The instruction the model works from. It states the contract, the boundaries, and what happens to an
 * answer FlowForge cannot use — because the cheapest failure mode of an LLM is a confident fabrication,
 * and the only defence in a single prompt is to make fabrication strictly worse than refusal.
 */
export function systemPrompt(format: OpenAiChatResponseFormat): string {
  return [
    "You propose film-production plans for FlowForge. You never create, approve, or execute anything.",
    `Return exactly one JSON object conforming to the ${AI_PLANNING_SCHEMA_VERSION} schema${format === "json_schema" ? " already supplied as your response format" : `: ${JSON.stringify(planningProposalJsonSchema())}`}. No prose before or after it, no markdown fence.`,
    "The object carries story direction and an ordered list of scenes: each scene states a title, what it must accomplish, which characters appear, which world it happens in, an optional duration and output-kind intent, and what must carry into the next scene.",
    `Refer to characters, worlds, and visual DNA by the exact names in the request${format === "json_object" ? ` (the schema, including its bounds, is:\n${JSON.stringify(planningProposalJsonSchema())})` : ""}. Never invent a name, never invent an id, never rename one. FlowForge refuses a proposal that names something the project does not have.`,
    "You may honour the brief's constraints, and you may not add new ones. Ordering, duration, and kinds are *intent*: the deterministic planner allocates durations, ids, specifications, and every technical field, so an unstated budget is left to it rather than guessed by you.",
    "If the brief cannot support a complete object, still return the best object you can with only what the brief states. FlowForge will refuse it rather than guess. Never pad a missing field with invented content, and never describe the plan in prose instead of answering.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* transport helpers                                                           */
/* -------------------------------------------------------------------------- */

function httpCode(_status: number): AIPlannerErrorCode {
  // Every non-2xx is one domain fact — the endpoint refused the request — because the vendor's status
  // taxonomy is not FlowForge's vocabulary. Which status it was is in the message, along with whether a
  // retry could help (`isRetryableStatus`), which is the part an operator acts on.
  return "AI_HTTP_ERROR";
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function failure(code: AIPlannerErrorCode, message: string, field?: string, retryable = false): AIPlanningResponse {
  return {
    status: "FAILED",
    code,
    message: message.length === 0 ? `The adapter failed (${code}).` : message,
    retryable,
    ...(field === undefined ? {} : { field }),
  };
}

function firstChoice(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  return typeof first === "object" && first !== null ? (first as Record<string, unknown>) : undefined;
}

/** `content`, or the reasoning-model variant `content` array flattened, or nothing at all. */
function contentOf(choice: Record<string, unknown>): unknown {
  const message =
    typeof choice.message === "object" && choice.message !== null ? (choice.message as Record<string, unknown>) : undefined;
  const content = message?.content;
  if (typeof content === "string") return content.trim().length === 0 ? undefined : content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text"
          ? String((part as Record<string, unknown>).text ?? "")
          : "",
      )
      .join("")
      .trim();
    return text.length === 0 ? undefined : text;
  }
  return undefined;
}

async function readText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    // A cap on the *body*, not just the parsed document: a runaway or malicious endpoint must not be able
    // to make FlowForge buffer unbounded text on a planning call.
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`response exceeded ${String(maxBytes)} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concat(chunks));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Removes credential material before a message is returned to a caller that may print or persist it. The
 * field label goes with the value: `Authorization=[redacted]` tells an operator that something was taken
 * out, and nothing that could be replayed survives. URL authorities are dropped whole, because a
 * deployment path can carry a tenant name. This is deliberately more aggressive than the browser gateway's
 * redaction: a planning failure has no operational value that a credential fragment could add.
 */
export function redact(value: string): string {
  return truncate(
    value
      .replace(/(authorization|bearer|api[-_ ]?key|token|secret|password)[\s=:]*\S*/giu, "[redacted]")
      .replace(/sk-[A-Za-z0-9_-]{4,}/gu, "[redacted]")
      .replace(/https?:\/\/\S+/giu, "[endpoint-redacted]")
      .replace(/\s+/gu, " ")
      .trim(),
    300,
  );
}

function describeEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "unparseable base URL";
  }
}

function trimSlash(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (trimmed.length === 0) throw new RangeError("baseUrl must not be empty.");
  return trimmed;
}

function requiredLabel(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw new RangeError(`${field} must be a non-empty string of at most 128 characters.`);
  }
  return trimmed;
}

function positiveInteger(value: number, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${field} must be an integer between 1 and ${String(max)}.`);
  }
  return value;
}

function boundedNumber(value: number, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    throw new RangeError(`${field} must be a finite number between 0 and ${String(max)}.`);
  }
  return value;
}
