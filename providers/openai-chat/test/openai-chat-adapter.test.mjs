import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { AI_PLANNING_SCHEMA_VERSION, AI_PROPOSAL_LIMITS } from "@flowforge/core";
import {
  OPENAI_CHAT_ADAPTER_ID,
  OPENAI_CHAT_ADAPTER_VERSION,
  OPENAI_CHAT_DEFAULTS,
  OpenAiChatPlanner,
  planningProposalJsonSchema,
  redact,
} from "../dist/index.js";

/**
 * Adapter contract tests for the OpenAI-compatible planning path (Phase 4C).
 *
 * They run with no credentials and no network: the transport is an injected `fetch` for almost every case,
 * and one case drives a loopback HTTP server so the real request line, headers, and body are checked
 * rather than asserted from memory. What is under test is the *boundary*: what the adapter refuses to send,
 * how it names a failure, how much it reads, and what it never lets into a message.
 *
 * A live provider call is not part of building, typechecking, or testing FlowForge. `docs/ai-planning.md`
 * documents the optional manual smoke; nothing here depends on it.
 */

const KEY = "sk-test-key-never-committed-000000000000";

function request(overrides = {}) {
  return {
    schemaVersion: AI_PLANNING_SCHEMA_VERSION,
    brief: {
      title: "Launch film",
      concept: "A launch teaser",
      objective: "Signups",
      audience: "Developers",
      tone: "confident",
      style: "clean",
      constraints: [{ kind: "MUST_NOT", value: "on-screen text after the hook" }],
    },
    characters: [{ name: "Aya", role: "protagonist" }],
    worlds: [{ name: "The loft" }],
    visualDna: [{ name: "grain", style: "35mm" }],
    availableKinds: ["image"],
    availableCapabilities: ["imageGeneration"],
    ...overrides,
  };
}

const PROPOSAL = {
  schemaVersion: AI_PLANNING_SCHEMA_VERSION,
  story: { premise: "P.", beginning: "B.", development: "D.", ending: "E." },
  scenes: [{ title: "Open", intent: "Establish." }],
};

/** A `fetch` stand-in that records calls and answers with whatever the case needs. */
function fakeFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init, calls.length);
  };
  return { fetch: impl, calls };
}

function jsonResponse(body, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completion(proposal, extra = {}) {
  return {
    model: "answered-model",
    choices: [
      {
        message: { role: "assistant", content: JSON.stringify(proposal) },
        finish_reason: "stop",
        ...(extra.choice ?? {}),
      },
    ],
    ...(extra.root ?? {}),
  };
}

async function withKey(run) {
  const previous = process.env.FLOWFORGE_AI_API_KEY;
  process.env.FLOWFORGE_AI_API_KEY = KEY;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.FLOWFORGE_AI_API_KEY;
    else process.env.FLOWFORGE_AI_API_KEY = previous;
  }
}

test("the port identity is fixed, so provenance names something stable", () => {
  const planner = new OpenAiChatPlanner({ fetchImpl: fakeFetch(() => jsonResponse({})).fetch });
  assert.equal(planner.id, OPENAI_CHAT_ADAPTER_ID);
  assert.equal(planner.adapterVersion, OPENAI_CHAT_ADAPTER_VERSION);
  assert.equal(planner.provider, "openai-compatible");
  assert.equal(planner.schemaVersion, AI_PLANNING_SCHEMA_VERSION);
  assert.equal(planner.model, OPENAI_CHAT_DEFAULTS.model);
});

test("without a credential nothing is sent, and the failure names the variable to set", async () => {
  const { fetch, calls } = fakeFetch(() => {
    throw new Error("must not be reached");
  });
  const previous = process.env.FLOWFORGE_AI_API_KEY;
  delete process.env.FLOWFORGE_AI_API_KEY;
  try {
    const planner = new OpenAiChatPlanner({ fetchImpl: fetch, apiKeyEnv: "FLOWFORGE_AI_API_KEY" });
    const response = await planner.propose(request());
    assert.equal(response.status, "FAILED");
    assert.equal(response.code, "AI_CREDENTIAL_MISSING");
    assert.match(response.message, /set FLOWFORGE_AI_API_KEY/u);
    assert.equal(response.retryable, false, "retrying without a key is the same call again");
    assert.equal(calls.length, 0);
  } finally {
    if (previous !== undefined) process.env.FLOWFORGE_AI_API_KEY = previous;
  }
});

test("a request the adapter cannot answer in its own schema is refused before any network call", async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse(completion(PROPOSAL)));
  const planner = await withKey(() => new OpenAiChatPlanner({ fetchImpl: fetch }));
  const response = await planner.propose(request({ schemaVersion: "ai-planning-proposal-v0" }));
  assert.equal(response.status, "FAILED");
  assert.equal(response.code, "AI_SCHEMA_MISMATCH");
  assert.equal(calls.length, 0);
});

test("the request body carries the schema, the context, and a bearer key — and nothing else", async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse(completion(PROPOSAL)));
  const planner = new OpenAiChatPlanner({ fetchImpl: fetch, temperature: 0.4, maxTokens: 1234 });
  const response = await withKey(() => planner.propose(request({ guidance: { sceneCount: 3, notes: "no dialogue" } })));
  assert.equal(response.status, "OK");
  assert.deepEqual(response.proposal, PROPOSAL);
  assert.deepEqual(response.meta, { model: "answered-model", finishReason: "stop", truncated: false });

  const [call] = calls;
  assert.equal(call.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["content-type"], "application/json");
  assert.equal(call.init.headers.authorization, `Bearer ${KEY}`);
  assert.ok(call.init.signal instanceof AbortSignal, "every call is bounded by a timeout signal");
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, OPENAI_CHAT_DEFAULTS.model);
  assert.equal(body.temperature, 0.4, "sampling looseness is adapter config, never the planner seed");
  assert.equal(body.max_tokens, 1234);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.name, "flowforge_planning_proposal");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /never create, approve, or execute anything/u);
  assert.match(body.messages[0].content, /FlowForge will refuse it rather than guess/u);
  assert.equal(body.messages[0].content.includes(KEY), false, "the key never enters a prompt");
  const sent = JSON.parse(body.messages[1].content);
  assert.deepEqual(sent.characters, [{ name: "Aya", role: "protagonist" }]);
  assert.deepEqual(sent.guidance, { sceneCount: 3, notes: "no dialogue" });
});

test("json_object mode puts the schema in the prompt instead of the response format", async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse(completion(PROPOSAL)));
  const planner = new OpenAiChatPlanner({ fetchImpl: fetch, responseFormat: "json_object" });
  await withKey(() => planner.propose(request()));
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.match(body.messages[0].content, /"additionalProperties":false/u);
});

test("the wire schema is rendered from the shared bounds, so provider and validator cannot drift", () => {
  const schema = planningProposalJsonSchema();
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.scenes.maxItems, AI_PROPOSAL_LIMITS.maxScenes);
  assert.equal(schema.properties.scenes.items.properties.durationMs.maximum, AI_PROPOSAL_LIMITS.maxDurationMs);
  assert.equal(schema.properties.scenes.items.properties.characters.maxItems, AI_PROPOSAL_LIMITS.maxCharactersPerScene);
  assert.equal(schema.properties.story.properties.premise.maxLength, AI_PROPOSAL_LIMITS.maxText);
  assert.equal(schema.properties.visualDna.maxLength, AI_PROPOSAL_LIMITS.maxTitle);
  assert.equal(schema.properties.scenes.items.properties.continuity.maxLength, AI_PROPOSAL_LIMITS.maxNote);
  assert.equal(schema.properties.scenes.items.required.join(","), "title,intent");
});

test("prose, emptiness, truncation, and refusal each get their own typed failure", async () => {
  const cases = [
    ["prose", jsonResponse({ model: "m", choices: [{ message: { content: "A story about a developer…" }, finish_reason: "stop" }] }), "AI_INVALID_JSON"],
    ["no choices", jsonResponse({ model: "m", choices: [] }), "AI_EMPTY_RESPONSE"],
    ["no content", jsonResponse({ model: "m", choices: [{ message: { content: "   " }, finish_reason: "stop" }] }), "AI_EMPTY_RESPONSE"],
    ["truncated", jsonResponse({ model: "m", choices: [{ message: { content: "{" }, finish_reason: "length" }] }), "AI_TRUNCATED"],
    ["filtered", jsonResponse({ model: "m", choices: [{ message: { content: "" }, finish_reason: "content_filter" }] }), "AI_REFUSAL"],
    ["not json at all", jsonResponse("<html>gateway error</html>"), "AI_INVALID_JSON"],
    ["error envelope", jsonResponse({ error: { message: `quota exceeded, key ${KEY}` } }), "AI_FAILED"],
  ];
  for (const [label, response, expected] of cases) {
    const { fetch } = fakeFetch(() => response);
    const planner = new OpenAiChatPlanner({ fetchImpl: fetch });
    const result = await withKey(() => planner.propose(request()));
    assert.equal(result.status, "FAILED", label);
    assert.equal(result.code, expected, `${label}: got ${result.code} — ${result.message}`);
    const serialized = JSON.stringify(result);
    for (const forbidden of [KEY, "Bearer ", "data:image", "<html>"]) {
      assert.equal(serialized.includes(forbidden), false, `${label} must not carry ${forbidden}`);
    }
  }
});

test("an HTTP status becomes one retryable-or-not decision, never a stack trace", async () => {
  for (const [status, retryable] of [
    [400, false],
    [401, false],
    [429, true],
    [500, true],
    [503, true],
  ]) {
    const { fetch } = fakeFetch(() => new Response(`upstream said no (status ${status})`, { status }));
    const planner = new OpenAiChatPlanner({ fetchImpl: fetch });
    const result = await withKey(() => planner.propose(request()));
    assert.equal(result.code, "AI_HTTP_ERROR", `status ${status}`);
    assert.equal(result.retryable, retryable, `status ${status} retryable`);
    assert.match(result.message, new RegExp(`HTTP ${String(status)}`, "u"));
    if (status === 401) assert.match(result.message, /credential was refused/u);
  }
});

test("an unreachable endpoint and an expired timeout are distinguishable, and both are retryable", async () => {
  const unreachable = new OpenAiChatPlanner({
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    },
  });
  const refused = await withKey(() => unreachable.propose(request()));
  assert.equal(refused.code, "AI_UNAVAILABLE");
  assert.equal(refused.retryable, true);

  const slow = new OpenAiChatPlanner({
    timeoutMs: 20,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        // `AbortSignal.timeout`'s timer does not hold the event loop open, and a test that ends before the
        // abort fires proves nothing — so this stand-in keeps a tick pending until the signal the adapter
        // passed in actually fires, which is the behaviour under test.
        const keepAlive = setInterval(() => {}, 5);
        init.signal.addEventListener("abort", () => {
          clearInterval(keepAlive);
          const error = new Error("The operation was aborted due to timeout");
          error.name = "TimeoutError";
          reject(error);
        });
      }),
  });
  const timedOut = await withKey(() => slow.propose(request()));
  assert.equal(timedOut.code, "AI_TIMEOUT");
  assert.match(timedOut.message, /within 20 ms/u);
  assert.equal(timedOut.retryable, true);
});

test("an oversized response is refused rather than buffered", async () => {
  const planner = new OpenAiChatPlanner({
    maxResponseBytes: 256,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let index = 0; index < 40; index += 1) controller.enqueue(new TextEncoder().encode("x".repeat(64)));
            controller.close();
          },
        }),
        { status: 200 },
      ),
  });
  const result = await withKey(() => planner.propose(request()));
  assert.equal(result.status, "FAILED");
  assert.equal(result.code, "AI_UNAVAILABLE");
  assert.match(result.message, /exceeded 256 bytes/u);
});

test("configuration is validated at construction, not at first use", () => {
  assert.throws(() => new OpenAiChatPlanner({ model: "  " }), /model must be a non-empty string/u);
  assert.throws(() => new OpenAiChatPlanner({ baseUrl: "   " }), /baseUrl must not be empty/u);
  assert.throws(() => new OpenAiChatPlanner({ timeoutMs: 0 }), /timeoutMs must be an integer/u);
  assert.throws(() => new OpenAiChatPlanner({ timeoutMs: 99_999_999 }), /timeoutMs must be an integer/u);
  assert.throws(() => new OpenAiChatPlanner({ temperature: 9 }), /temperature must be a finite number/u);
  assert.throws(() => new OpenAiChatPlanner({ maxTokens: 1e9 }), /maxTokens/u);
});

test("describe() prints where it will call, and never what it will call it with", () => {
  const planner = new OpenAiChatPlanner({ baseUrl: "https://gateway.example.com/v1/tenant-secret-path", apiKeyEnv: "MY_ENV" });
  const described = planner.describe();
  assert.deepEqual(described, {
    id: OPENAI_CHAT_ADAPTER_ID,
    adapterVersion: OPENAI_CHAT_ADAPTER_VERSION,
    provider: "openai-compatible",
    schemaVersion: AI_PLANNING_SCHEMA_VERSION,
    model: OPENAI_CHAT_DEFAULTS.model,
    endpoint: "https://gateway.example.com",
    apiKeyEnv: "MY_ENV",
    timeoutMs: OPENAI_CHAT_DEFAULTS.timeoutMs,
    maxResponseBytes: OPENAI_CHAT_DEFAULTS.maxResponseBytes,
    temperature: OPENAI_CHAT_DEFAULTS.temperature,
    responseFormat: "json_schema",
  });
  assert.equal(JSON.stringify(described).includes("tenant-secret-path"), false, "a deployment path can carry a tenant secret");
});

test("redact removes the shapes a credential can hide in", () => {
  const sample = `header "Authorization: Bearer ${KEY}" failed at https://api.openai.com/v1?user=abc`;
  const clean = redact(sample);
  // Value *and* label go together: nothing credential-shaped survives, so a redacted message cannot be
  // pasted into a bug report and leak the key it was complaining about.
  assert.equal(clean.includes(KEY), false);
  assert.equal(clean.includes("Authorization"), false);
  assert.equal(clean.includes("Bearer"), false);
  assert.equal(clean.includes("api.openai.com"), false);
  assert.match(clean, /\[redacted\]/u);
  assert.ok(clean.length <= 320, "and it stays short enough to store");
});

test("against a real socket: the path, headers, and body an endpoint actually receives", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completion(PROPOSAL)));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const planner = new OpenAiChatPlanner({ baseUrl: `http://127.0.0.1:${String(port)}/v1` });
    const result = await withKey(() => planner.propose(request()));
    assert.equal(result.status, "OK");
    assert.deepEqual(result.proposal, PROPOSAL);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/v1/chat/completions");
    assert.equal(seen[0].authorization, `Bearer ${KEY}`);
    const body = JSON.parse(seen[0].body);
    assert.equal(body.response_format.json_schema.schema.properties.schemaVersion.const, AI_PLANNING_SCHEMA_VERSION);
    // The key travelled in exactly one place: the header. Not in the prompt, not in the response, and
    // nowhere that FlowForge would persist.
    assert.equal(seen[0].body.includes(KEY), false);
    assert.equal(JSON.stringify(result).includes(KEY), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
